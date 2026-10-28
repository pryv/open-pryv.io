/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — OpenID Connect signing keys (per core, YAML only).
 *
 *   oauth:
 *     signingKeys:
 *       - kid: 2026-10
 *         alg: RS256
 *         privateKeyFile: /path/to/key.pem   # or privateKeyPem: "-----BEGIN …"
 *
 * The first entry signs; every entry is published in the JWK Set, so a key is
 * rotated by adding the new one first and keeping the old one until every
 * id_token it signed has expired (`oauth:idTokenTTL`). No `signingKeys`: OIDC
 * is off on this core (`openid` is refused at /authorize). A malformed entry
 * throws: the caller fails the boot.
 *
 * The private keys never leave this module: not logged, not in PlatformDB.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

export type SigningKey = {
  kid: string;
  alg: 'RS256';
  privateKey: crypto.KeyObject;
  publicJwk: Record<string, string>;
};

type RawKey = { kid?: unknown; alg?: unknown; privateKeyFile?: unknown; privateKeyPem?: unknown };

const MIN_RSA_BITS = 2048;
const cache = new Map<string, SigningKey[]>();

/** The configured signing keys (empty when OIDC is off). Throws on a bad entry. */
export function loadSigningKeys (config: { get (key: string): unknown }): SigningKey[] {
  const raw = config.get('oauth:signingKeys');
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) return [];
  if (!Array.isArray(raw)) throw new Error('oauth:signingKeys must be a list');
  const cacheKey = JSON.stringify(raw);
  const cached = cache.get(cacheKey);
  if (cached != null) return cached;
  const kids = new Set<string>();
  const keys = (raw as RawKey[]).map((entry, i) => {
    const where = `oauth:signingKeys[${i}]`;
    if (typeof entry?.kid !== 'string' || entry.kid.length === 0) throw new Error(`${where}: kid is required`);
    if (kids.has(entry.kid)) throw new Error(`${where}: duplicate kid "${entry.kid}"`);
    kids.add(entry.kid);
    if (entry.alg !== 'RS256') throw new Error(`${where}: alg must be RS256`);
    let pem: string;
    if (typeof entry.privateKeyPem === 'string' && entry.privateKeyPem.length > 0) {
      pem = entry.privateKeyPem;
    } else if (typeof entry.privateKeyFile === 'string' && entry.privateKeyFile.length > 0) {
      pem = fs.readFileSync(entry.privateKeyFile, 'utf8');
    } else {
      throw new Error(`${where}: privateKeyFile or privateKeyPem is required`);
    }
    let privateKey: crypto.KeyObject;
    try {
      privateKey = crypto.createPrivateKey(pem);
    } catch {
      throw new Error(`${where}: the private key cannot be read`);
    }
    if (privateKey.asymmetricKeyType !== 'rsa') throw new Error(`${where}: an RSA key is required`);
    const bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < MIN_RSA_BITS) throw new Error(`${where}: RSA key of ${bits} bits, at least ${MIN_RSA_BITS} required`);
    const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' }) as Record<string, string>;
    return {
      kid: entry.kid,
      alg: 'RS256' as const,
      privateKey,
      publicJwk: { kty: 'RSA', n: jwk.n, e: jwk.e, kid: entry.kid, alg: 'RS256', use: 'sig' },
    };
  });
  cache.set(cacheKey, keys);
  return keys;
}

/** Whether OIDC is available on this core. */
export function hasSigningKeys (config: { get (key: string): unknown }): boolean {
  return loadSigningKeys(config).length > 0;
}

/** The public JWK Set (public members only). */
export function publicJwkSet (keys: SigningKey[]): { keys: Array<Record<string, string>> } {
  return { keys: keys.map((k) => ({ ...k.publicJwk })) };
}

/** Sign a JWT (RS256) with the given key. */
export function signJwt (key: SigningKey, payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', kid: key.kid, typ: 'JWT' };
  const input = b64json(header) + '.' + b64json(payload);
  const signature = crypto.sign('sha256', Buffer.from(input), key.privateKey).toString('base64url');
  return input + '.' + signature;
}

function b64json (v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

/** Test-only — drop cached keys. */
export function _resetForTests (): void {
  cache.clear();
}
