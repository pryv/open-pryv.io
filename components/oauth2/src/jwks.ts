/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — public JWK Set validation + thumbprint helpers.
 *
 * A registered client MAY carry an inline public JWK Set used to verify
 * `private_key_jwt` client-authentication assertions (RFC 7521/7523).
 * ONLY public EC P-256 keys (ES256) are accepted: the client signs, the
 * server verifies, and accepting exactly one curve/algorithm removes the
 * signature alg-confusion surface by construction.
 *
 * These keys are PUBLIC, so caching them cluster-wide in PlatformDB does
 * not breach the no-credentials-in-PlatformDB invariant — but a private
 * component (`d`) sneaking in WOULD, so every validator rejects it
 * outright. Dependency-free on top of node:crypto webcrypto, mirroring
 * the DPoP verifier's approach.
 */

import { createHash, webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

/** A public EC P-256 (ES256) JWK — the only key kind accepted. */
export interface EcP256PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  /** Optional key id — used to select a key when an assertion header names one. */
  kid?: string;
}

/** A validated public JWK Set. */
export interface PublicJwkSet {
  keys: EcP256PublicJwk[];
}

/** A 32-byte base64url coordinate is exactly 43 unpadded chars. */
const COORD_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Validate ONE public EC P-256 JWK. Returns the sanitized key (only the
 * members we accept) or throws Error with a human message. Rejects any
 * key carrying a private component (`d`) — public keys only.
 */
export function validatePublicJwk (jwk: unknown): EcP256PublicJwk {
  if (jwk == null || typeof jwk !== 'object' || Array.isArray(jwk)) {
    throw new Error('jwk must be a JSON object');
  }
  const k = jwk as Record<string, unknown>;
  if (k.kty !== 'EC') throw new Error('jwk.kty must be "EC"');
  if (k.crv !== 'P-256') throw new Error('jwk.crv must be "P-256" (ES256)');
  if ('d' in k) throw new Error('jwk carries private key material ("d") — public keys only');
  for (const coord of ['x', 'y'] as const) {
    const v = k[coord];
    if (typeof v !== 'string' || !COORD_RE.test(v)) {
      throw new Error(`jwk.${coord} must be a 32-byte base64url coordinate`);
    }
  }
  const out: EcP256PublicJwk = { kty: 'EC', crv: 'P-256', x: k.x as string, y: k.y as string };
  if (typeof k.kid === 'string' && k.kid.length > 0) out.kid = k.kid;
  return out;
}

/**
 * Validate a whole `{ keys: [...] }` JWK Set. Returns the sanitized set
 * or throws Error with a human message. At least one key is required.
 */
export function validatePublicJwkSet (jwks: unknown): PublicJwkSet {
  if (jwks == null || typeof jwks !== 'object' || Array.isArray(jwks)) {
    throw new Error('jwks must be a JSON object of the form { keys: [...] }');
  }
  const keys = (jwks as Record<string, unknown>).keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('jwks.keys must be a non-empty array');
  }
  return { keys: keys.map(validatePublicJwk) };
}

/**
 * RFC 7638 thumbprint: SHA-256 over the JSON of the key's REQUIRED
 * members only, keys in lexicographic order, no whitespace. Returned as
 * unpadded base64url (43 chars).
 */
export function computeThumbprint (jwk: EcP256PublicJwk): string {
  return createHash('sha256')
    .update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`)
    .digest('base64url');
}

/**
 * Import a validated public JWK as a webcrypto verify-only ECDSA key.
 * Imports ONLY the sanitized members (never a raw attacker object).
 * Throws if the coordinates are not a valid point on the curve.
 */
export async function importVerifyKey (jwk: EcP256PublicJwk) {
  return subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}
