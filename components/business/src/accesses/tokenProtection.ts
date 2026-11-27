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
 * Key root, layered:
 *   1. `auth.accessTokensKey` (base64, 32 bytes) when set;
 *   2. else `auth.adminAccessKey`;
 *   3. else no key: refused (no unkeyed fallback, a process with another key
 *      would find no token at all).
 * Four keys are HKDF-derived from the root with their own labels. The `kid`
 * (first 8 hex chars of an HMAC under the access hash key) prefixes every
 * hash: rows under another key are recognised (boot guard, `rekey` tool).
 */

import { createHmac } from 'node:crypto';
import type { ConfigLike } from '@pryv/boiler';
import type { TokenProtection } from 'storages/interfaces/_shared/tokenProtection.ts';
import { deriveKey, encrypt, decrypt, KEY_BYTES } from '../acme/AtRestEncryption.ts';

const PURPOSE_ACCESS_HASH = 'access-token-hash-v1';
const PURPOSE_ACCESS_ENC = 'access-token-enc-v1';
const PURPOSE_SESSION_HASH = 'session-id-hash-v1';
const PURPOSE_SESSION_ENC = 'session-id-enc-v1';
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
  const kid = createHmac('sha256', accessHashKey).update('kid').digest('hex').slice(0, KID_LENGTH);
  const prefix = kid + '.';

  const accessContext = (userId: string, tokenHash: string): string => 'access-token:' + userId + ':' + tokenHash;
  const sessionContext = (idHash: string): string => 'session-id:' + idHash;

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
        return decrypt(tokenEnc, accessEncKey, accessContext(userId, tokenHash)).toString('utf8');
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
        return decrypt(idEnc, sessionEncKey, sessionContext(idHash)).toString('utf8');
      } catch (err) {
        throw new TokenUnreadableError('session id envelope does not open: ' + (err as Error).message);
      }
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
