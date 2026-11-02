/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: public JWK Set validation + thumbprint helpers.
 *
 * A registered client MAY carry a public JWK Set (inline, or published at
 * its `jwks_uri`) used to verify `private_key_jwt` client-authentication
 * assertions (RFC 7521/7523). Accepted keys: EC P-256 (ES256), EC P-384
 * (ES384) and RSA of at least 2048 bits (RS384). Each algorithm is bound to
 * one key type, so an assertion is only ever verified with a key of the type
 * its header names (no alg confusion).
 *
 * These keys are PUBLIC, so caching them cluster-wide in PlatformDB does
 * not breach the no-credentials-in-PlatformDB invariant, but a private
 * component sneaking in WOULD, so every validator rejects it outright.
 * Dependency-free on top of node:crypto webcrypto.
 */

import { createHash, webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

/** JWS algorithms accepted for a client assertion, in discovery order. */
export const CLIENT_ASSERTION_ALGS: readonly string[] = Object.freeze(['ES256', 'ES384', 'RS384']);

/** A public EC JWK (P-256 for ES256, P-384 for ES384). */
export interface EcPublicJwk {
  kty: 'EC';
  crv: 'P-256' | 'P-384';
  x: string;
  y: string;
  /** Optional key id: selects the key when an assertion header names one. */
  kid?: string;
  /** Optional: the one algorithm this key may verify. */
  alg?: string;
  use?: 'sig';
}

/** A public EC P-256 JWK (the DPoP / legacy shape). */
export type EcP256PublicJwk = EcPublicJwk & { crv: 'P-256' };

/** A public RSA JWK (RS384). */
export interface RsaPublicJwk {
  kty: 'RSA';
  n: string;
  e: string;
  kid?: string;
  alg?: string;
  use?: 'sig';
}

/** A public key a client assertion may be verified with. */
export type ClientPublicJwk = EcPublicJwk | RsaPublicJwk;

/** A validated public JWK Set. */
export interface PublicJwkSet {
  keys: ClientPublicJwk[];
}

/** Members that only a private (or symmetric) key carries. */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

/** Base64url length of an unpadded coordinate, per curve. */
const COORD_LENGTH: Record<string, number> = { 'P-256': 43, 'P-384': 64 };

/** Curve per EC algorithm, and the one RSA algorithm. */
const ALG_KEY: Record<string, { kty: 'EC' | 'RSA'; crv?: 'P-256' | 'P-384'; hash: string }> = {
  ES256: { kty: 'EC', crv: 'P-256', hash: 'SHA-256' },
  ES384: { kty: 'EC', crv: 'P-384', hash: 'SHA-384' },
  RS384: { kty: 'RSA', hash: 'SHA-384' },
};

/** RSA modulus bounds, bytes: 2048 to 8192 bits. */
const RSA_MIN_BYTES = 256;
const RSA_MAX_BYTES = 1024;

/** Upper bound on keys in one set. */
export const MAX_JWKS_KEYS = 20;

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** The algorithm a key of this type verifies (one per key type). */
export function algForKey (jwk: ClientPublicJwk): string {
  if (jwk.kty === 'RSA') return 'RS384';
  return jwk.crv === 'P-384' ? 'ES384' : 'ES256';
}

/** Whether `jwk` may verify a signature made with `alg`. */
export function keyMatchesAlg (jwk: ClientPublicJwk, alg: string): boolean {
  const want = ALG_KEY[alg];
  if (want == null || jwk.kty !== want.kty) return false;
  if (jwk.kty === 'EC' && jwk.crv !== want.crv) return false;
  return jwk.alg == null || jwk.alg === alg;
}

/**
 * Validate ONE public JWK. Returns the sanitized key (only the members we
 * accept) or throws Error with a human message. Rejects any key carrying
 * private material.
 */
export function validatePublicJwk (jwk: unknown): ClientPublicJwk {
  if (jwk == null || typeof jwk !== 'object' || Array.isArray(jwk)) {
    throw new Error('jwk must be a JSON object');
  }
  const k = jwk as Record<string, unknown>;
  const leaked = PRIVATE_MEMBERS.filter((m) => m in k);
  if (leaked.length > 0) {
    throw new Error(`jwk carries private key material ("${leaked.join('", "')}"): public keys only`);
  }
  if (k.use != null && k.use !== 'sig') throw new Error('jwk.use must be "sig" when present');
  let out: ClientPublicJwk;
  if (k.kty === 'EC') {
    if (k.crv !== 'P-256' && k.crv !== 'P-384') throw new Error('jwk.crv must be "P-256" (ES256) or "P-384" (ES384)');
    const len = COORD_LENGTH[k.crv];
    for (const coord of ['x', 'y'] as const) {
      const v = k[coord];
      if (typeof v !== 'string' || v.length !== len || !B64URL_RE.test(v)) {
        throw new Error(`jwk.${coord} must be a base64url coordinate of ${k.crv}`);
      }
    }
    out = { kty: 'EC', crv: k.crv, x: k.x as string, y: k.y as string };
  } else if (k.kty === 'RSA') {
    if (typeof k.n !== 'string' || !B64URL_RE.test(k.n)) throw new Error('jwk.n must be base64url');
    const n = Buffer.from(k.n, 'base64url');
    const bytes = n.length - (n[0] === 0 ? 1 : 0);
    if (bytes < RSA_MIN_BYTES || bytes > RSA_MAX_BYTES) throw new Error('jwk.n must be an RSA modulus of 2048 to 8192 bits');
    if (typeof k.e !== 'string' || !B64URL_RE.test(k.e)) throw new Error('jwk.e must be base64url');
    const e = Buffer.from(k.e, 'base64url');
    if (e.length === 0 || e.length > 4 || (e[e.length - 1] & 1) === 0 || e.readUIntBE(0, e.length) < 3) {
      throw new Error('jwk.e must be an odd public exponent of at least 3');
    }
    out = { kty: 'RSA', n: k.n, e: k.e };
  } else {
    throw new Error('jwk.kty must be "EC" or "RSA"');
  }
  if (k.kid != null) {
    if (typeof k.kid !== 'string' || k.kid.length === 0 || k.kid.length > 256) throw new Error('jwk.kid must be a string of 1 to 256 characters');
    out.kid = k.kid;
  }
  if (k.alg != null) {
    if (typeof k.alg !== 'string' || !CLIENT_ASSERTION_ALGS.includes(k.alg) || !keyMatchesAlg({ ...out }, k.alg)) {
      throw new Error(`jwk.alg "${String(k.alg)}" does not fit a ${out.kty === 'EC' ? (out as EcPublicJwk).crv : 'RSA'} key (expected ${algForKey(out)})`);
    }
    out.alg = k.alg;
  }
  if (k.use === 'sig') out.use = 'sig';
  return out;
}

/**
 * Validate a whole `{ keys: [...] }` JWK Set, as registered by the operator.
 * Returns the sanitized set or throws Error with a human message. At least
 * one key; with more than one, every key carries a distinct `kid` (an
 * assertion must name the key it is signed with).
 */
export function validatePublicJwkSet (jwks: unknown): PublicJwkSet {
  const keys = rawKeys(jwks);
  const out = keys.map(validatePublicJwk);
  if (out.length > 1) {
    const kids = out.map((k) => k.kid);
    if (kids.some((kid) => kid == null)) throw new Error('jwks: every key needs a "kid" when the set holds more than one key');
    if (new Set(kids).size !== kids.length) throw new Error('jwks: two keys share a "kid"');
  }
  return { keys: out };
}

/**
 * A JWK Set as published by a client at its `jwks_uri`: keys this server
 * cannot use (encryption keys, other key types) are skipped; a key carrying
 * private material refuses the whole set; at least one usable key remains.
 */
export function usablePublicJwkSet (jwks: unknown): PublicJwkSet {
  const keys = rawKeys(jwks, 100);
  const out: ClientPublicJwk[] = [];
  for (const raw of keys) {
    if (raw != null && typeof raw === 'object' && PRIVATE_MEMBERS.some((m) => m in (raw as object))) {
      throw new Error('jwks: a key carries private key material');
    }
    try { out.push(validatePublicJwk(raw)); } catch { /* not usable here: skipped */ }
  }
  if (out.length === 0) throw new Error('jwks: no usable signature key');
  return { keys: out.slice(0, MAX_JWKS_KEYS) };
}

function rawKeys (jwks: unknown, max: number = MAX_JWKS_KEYS): unknown[] {
  if (jwks == null || typeof jwks !== 'object' || Array.isArray(jwks)) {
    throw new Error('jwks must be a JSON object of the form { keys: [...] }');
  }
  const keys = (jwks as Record<string, unknown>).keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('jwks.keys must be a non-empty array');
  }
  if (keys.length > max) throw new Error(`jwks.keys holds more than ${max} keys`);
  return keys;
}

/**
 * RFC 7638 thumbprint: SHA-256 over the JSON of the key's REQUIRED
 * members only, keys in lexicographic order, no whitespace. Returned as
 * unpadded base64url (43 chars).
 */
export function computeThumbprint (jwk: ClientPublicJwk): string {
  const canonical = jwk.kty === 'RSA'
    ? `{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`
    : `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return createHash('sha256').update(canonical).digest('base64url');
}

/**
 * Import a validated public JWK as a webcrypto verify-only key for `alg`.
 * Imports ONLY the sanitized members (never a raw attacker object). Throws
 * when the key does not fit the algorithm or is not a valid key.
 */
export async function importVerifyKey (jwk: ClientPublicJwk, alg: string = 'ES256') {
  if (!keyMatchesAlg(jwk, alg)) throw new Error('key does not fit ' + alg);
  if (jwk.kty === 'RSA') {
    return subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: ALG_KEY[alg].hash }, false, ['verify']);
  }
  return subtle.importKey('jwk', { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: jwk.crv }, false, ['verify']);
}

/** webcrypto verify parameters for `alg`. */
export function verifyParams (alg: string): { name: 'ECDSA'; hash: string } | { name: 'RSASSA-PKCS1-v1_5' } {
  const spec = ALG_KEY[alg];
  if (spec == null) throw new Error('unsupported alg ' + alg);
  return spec.kty === 'EC' ? { name: 'ECDSA', hash: spec.hash } : { name: 'RSASSA-PKCS1-v1_5' };
}

/** Byte length of a raw ES signature (r||s), per EC algorithm. */
export const EC_SIGNATURE_BYTES: Record<string, number> = { ES256: 64, ES384: 96 };
