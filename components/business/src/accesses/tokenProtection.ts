/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Access tokens and personal session ids at rest.
 *
 * The storage engines never keep a token in clear. A row holds:
 *   - a keyed hash, the only lookup key (no clear token in any index or WHERE
 *     clause): `kid + '.' + base64url(HMAC-SHA256(key, input))`;
 *   - an AES-256-GCM envelope of the token (the at-rest envelope of
 *     `acme/AtRestEncryption.ts`), opened when the item is read, so every place
 *     that returns `token` keeps working.
 *
 * Above the engines the item is unchanged: `access.token` is the clear token.
 *
 * The HMAC is keyed (not a plain sha256) because chosen tokens can be short or
 * human-made: a dump of plain hashes of those is reversed by enumeration. The
 * key lives in the configuration only, never in the database.
 *
 * The engines never store the access `integrity` in clear either: that value
 * is an unkeyed hash of the access including its token, so a dump of it would
 * let a low-entropy token chosen by a caller (or a short legacy one) be tested
 * offline. It is stored sealed, `sealed:<kid>.<envelope>` (the envelope bound
 * to the user id), and opened on read; above the engines it is the public
 * `ACCESS:0:...` value. The same sealed form keeps a credential sent to
 * another platform (the endpoint of a pending deletion notice) out of the
 * database in clear.
 *
 * Envelopes are version 2 only (context-bound); the openers refuse any other
 * version.
 *
 * Key root, layered:
 *   1. `auth.accessTokensKey` (base64, 32 bytes) when set;
 *   2. else `auth.adminAccessKey`;
 *   3. else no key: refused (no unkeyed fallback, a process with another key
 *      would find no token at all).
 * Six keys are HKDF-derived from the root with their own labels. The `kid`
 * (first 8 hex chars of an HMAC under the access hash key) prefixes every
 * hash: rows under another key are recognised (boot guard, `rekey` tool).
 */

import { createHmac } from 'node:crypto';
import type { ConfigLike } from '@pryv/boiler';
import type { TokenProtection } from 'storages/interfaces/_shared/tokenProtection.ts';
import { SEALED_PREFIX, isSealedValue } from 'storages/interfaces/_shared/tokenProtection.ts';
import { deriveKey, encrypt, decrypt, envelopeVersion, KEY_BYTES, ENVELOPE_VERSION } from '../acme/AtRestEncryption.ts';

const PURPOSE_ACCESS_HASH = 'access-token-hash-v1';
const PURPOSE_ACCESS_ENC = 'access-token-enc-v1';
const PURPOSE_SESSION_HASH = 'session-id-hash-v1';
const PURPOSE_SESSION_ENC = 'session-id-enc-v1';
const PURPOSE_ACCESS_INTEGRITY_ENC = 'access-integrity-enc-v1';
const PURPOSE_OUTBOUND_ENC = 'outbound-credential-enc-v1';
const KID_LENGTH = 8;

/** An envelope that does not open: tampered, or sealed under another key. */
class TokenUnreadableError extends Error {
  /** The access id, when known (a session has none). */
  accessId: string | null;
  constructor (message: string, accessId: string | null = null) {
    super(message);
    this.name = 'TokenUnreadableError';
    this.accessId = accessId;
  }
}

function b64url (buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function assertString (value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(what + ' must be a string');
}

/** Open a version-2 envelope (none other is ever written here). */
function openV2 (encoded: string, key: Buffer, context: string): string {
  const version = envelopeVersion(encoded);
  if (version !== ENVELOPE_VERSION) throw new Error('envelope version ' + version + ' is not accepted here');
  return decrypt(encoded, key, context).toString('utf8');
}

/**
 * Build the protection object from a key root (the dedicated 32-byte key, or
 * the `auth.adminAccessKey` string).
 */
function createTokenProtection (root: string | Buffer): TokenProtection {
  if (root == null || root.length === 0) throw new Error('token protection: a key root is required');
  const accessHashKey = deriveKey(root, PURPOSE_ACCESS_HASH);
  const accessEncKey = deriveKey(root, PURPOSE_ACCESS_ENC);
  const sessionHashKey = deriveKey(root, PURPOSE_SESSION_HASH);
  const sessionEncKey = deriveKey(root, PURPOSE_SESSION_ENC);
  const integrityEncKey = deriveKey(root, PURPOSE_ACCESS_INTEGRITY_ENC);
  const outboundEncKey = deriveKey(root, PURPOSE_OUTBOUND_ENC);
  const kid = createHmac('sha256', accessHashKey).update('kid').digest('hex').slice(0, KID_LENGTH);
  const prefix = kid + '.';
  const sealedPrefix = SEALED_PREFIX + prefix;

  const accessContext = (userId: string, tokenHash: string): string => 'access-token:' + userId + ':' + tokenHash;
  const sessionContext = (idHash: string): string => 'session-id:' + idHash;
  const integrityContext = (userId: string): string => 'access-integrity:' + userId;

  /** `sealed:<kid>.<envelope>`: the key id is in the value (rows without a token hash carry it too). */
  const seal = (value: string, key: Buffer, context: string): string => sealedPrefix + encrypt(value, key, context);
  const open = (stored: string, key: Buffer, context: string, what: string): string => {
    if (!isSealedValue(stored)) throw new TokenUnreadableError(what + ' is not a sealed value');
    if (!stored.startsWith(sealedPrefix)) throw new TokenUnreadableError(what + ' is sealed under another key');
    try {
      return openV2(stored.slice(sealedPrefix.length), key, context);
    } catch (err) {
      throw new TokenUnreadableError(what + ' envelope does not open: ' + (err as Error).message);
    }
  };

  return {
    kid,
    ownsHash (storedHash) {
      return typeof storedHash === 'string' && storedHash.startsWith(prefix);
    },
    hashAccessToken (userId, token) {
      assertString(userId, 'user id');
      assertString(token, 'access token');
      const mac = createHmac('sha256', accessHashKey).update(userId).update(Buffer.from([0])).update(token).digest();
      return prefix + b64url(mac);
    },
    sealAccessToken (userId, tokenHash, token) {
      assertString(token, 'access token');
      return encrypt(token, accessEncKey, accessContext(userId, tokenHash));
    },
    openAccessToken (userId, tokenHash, tokenEnc) {
      try {
        return openV2(tokenEnc, accessEncKey, accessContext(userId, tokenHash));
      } catch (err) {
        throw new TokenUnreadableError('access token envelope does not open: ' + (err as Error).message);
      }
    },
    hashSessionId (id) {
      assertString(id, 'session id');
      return prefix + b64url(createHmac('sha256', sessionHashKey).update(id).digest());
    },
    sealSessionId (idHash, id) {
      assertString(id, 'session id');
      return encrypt(id, sessionEncKey, sessionContext(idHash));
    },
    openSessionId (idHash, idEnc) {
      try {
        return openV2(idEnc, sessionEncKey, sessionContext(idHash));
      } catch (err) {
        throw new TokenUnreadableError('session id envelope does not open: ' + (err as Error).message);
      }
    },
    isSealed (stored) {
      return isSealedValue(stored);
    },
    ownsSealed (stored) {
      return typeof stored === 'string' && stored.startsWith(sealedPrefix);
    },
    sealAccessIntegrity (userId, integrity) {
      assertString(userId, 'user id');
      assertString(integrity, 'access integrity');
      return seal(integrity, integrityEncKey, integrityContext(userId));
    },
    openAccessIntegrity (userId, stored) {
      assertString(userId, 'user id');
      return open(stored, integrityEncKey, integrityContext(userId), 'access integrity');
    },
    sealSecret (context, value) {
      assertString(context, 'context');
      assertString(value, 'secret');
      return seal(value, outboundEncKey, context);
    },
    openSecret (context, stored) {
      assertString(context, 'context');
      return open(stored, outboundEncKey, context, 'secret');
    }
  };
}

/** The key root from configured values (see the module note for the order). */
function keyRootFrom (accessTokensKey: unknown, adminAccessKey: unknown): string | Buffer {
  if (accessTokensKey != null && accessTokensKey !== '') {
    if (typeof accessTokensKey !== 'string') throw new Error('auth.accessTokensKey must be a base64 string');
    const buf = Buffer.from(accessTokensKey, 'base64');
    if (buf.length !== KEY_BYTES) {
      throw new Error(`auth.accessTokensKey must decode to ${KEY_BYTES} bytes (base64), got ${buf.length}`);
    }
    return buf;
  }
  if (typeof adminAccessKey === 'string' && adminAccessKey.length > 0) return adminAccessKey;
  throw new Error('access tokens at rest: no key, set auth.adminAccessKey (or auth.accessTokensKey)');
}

/** The protection object of the configured key root. Throws when none is set. */
function resolveTokenProtection (config: ConfigLike): TokenProtection {
  return createTokenProtection(keyRootFrom(config.get('auth:accessTokensKey'), config.get('auth:adminAccessKey')));
}

/**
 * The protection objects a previous key file may stand for: its content as an
 * `auth.adminAccessKey` value, and, when it decodes to 32 bytes, as an
 * `auth.accessTokensKey` value. The caller keeps the one whose `kid` matches
 * the stored rows.
 */
function candidateProtectionsFromKeyText (text: string): TokenProtection[] {
  const value = text.trim();
  if (value.length === 0) return [];
  const out = [createTokenProtection(value)];
  const buf = Buffer.from(value, 'base64');
  if (buf.length === KEY_BYTES) out.push(createTokenProtection(buf));
  return out;
}

export {
  createTokenProtection,
  resolveTokenProtection,
  candidateProtectionsFromKeyText,
  TokenUnreadableError
};
export type { TokenProtection };
