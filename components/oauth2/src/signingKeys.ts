/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: OpenID Connect signing keys (per core, YAML only).
 *
 *   oauth:
 *     signingKeys:
 *       - kid: 2026-10
 *         privateKeyFile: /path/to/key.pem   # or privateKeyPem: "-----BEGIN …"
 *         # alg: RS256                       # optional; RS256 is the only value
 *
 * RS256 only (no algorithm choice, so no algorithm confusion), RSA keys of at
 * least 2048 bits, every key named by a unique `kid` that the id_token header
 * carries.
 *
 * Rotation is by ordering: the FIRST entry signs; every entry is published in
 * the JWK Set. To rotate, put the new key first and keep the old one listed
 * until every id_token it signed has expired (`oauth:idTokenTTL`), then remove
 * it. To introduce a key before it signs, list it second.
 *
 * No `signingKeys`: OpenID Connect is off on this core (`openid` is refused at
 * /oauth2/authorize, the discovery document and the JWK Set answer 404). A
 * malformed entry throws: the route mount fails the boot.
 *
 * Private keys never leave this module: not logged, not in PlatformDB, and the
 * JWK Set is rebuilt from the public modulus and exponent only.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

export const SIGNING_ALG = 'RS256' as const;
export const MIN_RSA_BITS = 2048;
const KID_RE = /^[\x21-\x7e]{1,128}$/;

export type SigningKey = {
  kid: string;
  alg: typeof SIGNING_ALG;
  privateKey: crypto.KeyObject;
  /** Public members only: kty, n, e, kid, alg, use. */
  publicJwk: { kty: 'RSA'; n: string; e: string; kid: string; alg: typeof SIGNING_ALG; use: 'sig' };
};

type RawKey = { kid?: unknown; alg?: unknown; privateKeyFile?: unknown; privateKeyPem?: unknown };

type ConfigReader = { get (key: string): unknown };

// One entry: the configuration does not change while a process runs, and a
// test that swaps it simply reloads.
let cached: { fingerprint: string; keys: SigningKey[] } | null = null;

/** The configured signing keys, signing key first (empty when OIDC is off). Throws on a bad entry. */
export function loadSigningKeys (config: ConfigReader): SigningKey[] {
  const raw = config.get('oauth:signingKeys');
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) return [];
  if (!Array.isArray(raw)) throw new Error('oauth:signingKeys must be a list');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(raw)).digest('base64url');
  if (cached != null && cached.fingerprint === fingerprint) return cached.keys;
  const kids = new Set<string>();
  const keys = (raw as RawKey[]).map((entry, i): SigningKey => {
    const where = `oauth:signingKeys[${i}]`;
    if (entry == null || typeof entry !== 'object') throw new Error(`${where}: must be an object`);
    if (typeof entry.kid !== 'string' || !KID_RE.test(entry.kid)) {
      throw new Error(`${where}: kid is required (1 to 128 printable characters, no space)`);
    }
    if (kids.has(entry.kid)) throw new Error(`${where}: duplicate kid "${entry.kid}"`);
    kids.add(entry.kid);
    if (entry.alg != null && entry.alg !== SIGNING_ALG) throw new Error(`${where}: alg must be ${SIGNING_ALG}`);
    const hasPem = typeof entry.privateKeyPem === 'string' && entry.privateKeyPem.length > 0;
    const hasFile = typeof entry.privateKeyFile === 'string' && entry.privateKeyFile.length > 0;
    if (hasPem === hasFile) throw new Error(`${where}: exactly one of privateKeyFile or privateKeyPem is required`);
    let pem: string;
    if (hasPem) {
      pem = entry.privateKeyPem as string;
    } else {
      try {
        pem = fs.readFileSync(entry.privateKeyFile as string, 'utf8');
      } catch (err: unknown) {
        throw new Error(`${where}: cannot read privateKeyFile (${(err as NodeJS.ErrnoException)?.code ?? 'error'})`);
      }
    }
    let privateKey: crypto.KeyObject;
    try {
      privateKey = crypto.createPrivateKey(pem);
    } catch {
      // The parser's message may quote the input: never echo it.
      throw new Error(`${where}: the private key cannot be read (an unencrypted PEM private key is expected)`);
    }
    if (privateKey.asymmetricKeyType !== 'rsa') throw new Error(`${where}: an RSA key is required for ${SIGNING_ALG}`);
    const bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < MIN_RSA_BITS) throw new Error(`${where}: RSA key of ${bits} bits, at least ${MIN_RSA_BITS} required`);
    const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' }) as { n?: string; e?: string };
    if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw new Error(`${where}: cannot derive the public key`);
    return {
      kid: entry.kid,
      alg: SIGNING_ALG,
      privateKey,
      publicJwk: { kty: 'RSA' as const, n: jwk.n, e: jwk.e, kid: entry.kid, alg: SIGNING_ALG, use: 'sig' as const },
    };
  });
  cached = { fingerprint, keys };
  return keys;
}

/** Whether OpenID Connect is available on this core (at least one signing key). */
export function hasSigningKeys (config: ConfigReader): boolean {
  return loadSigningKeys(config).length > 0;
}

/** The public JWK Set: public members only, in configuration order. */
export function publicJwkSet (keys: SigningKey[]): { keys: Array<SigningKey['publicJwk']> } {
  return {
    keys: keys.map((k) => ({ kty: 'RSA', n: k.publicJwk.n, e: k.publicJwk.e, kid: k.kid, alg: SIGNING_ALG, use: 'sig' })),
  };
}

/** Sign a JWT with RS256 (RSASSA-PKCS1-v1_5, SHA-256); the header names the key. */
export function signJwt (key: SigningKey, payload: Record<string, unknown>): string {
  const header = { alg: SIGNING_ALG, kid: key.kid, typ: 'JWT' };
  const input = b64json(header) + '.' + b64json(payload);
  const signature = crypto.sign('sha256', Buffer.from(input), {
    key: key.privateKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  }).toString('base64url');
  return input + '.' + signature;
}

function b64json (v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

/** Test-only: drop the cached keys. */
export function _resetForTests (): void {
  cached = null;
}
