/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `private_key_jwt` client-authentication assertion verification
 * (RFC 7521 + RFC 7523). Pure module: no HTTP, no storage. Validates the
 * `client_assertion` (a compact JWS) against the client's registered
 * inline public JWK Set and the token-endpoint's expected audiences.
 * Replay accounting (`jti` single-use) is the CALLER's job — this module
 * only validates shape, signature and claims.
 *
 * Deliberately ES256-only (EC P-256), verification-only, and
 * dependency-free on top of node:crypto webcrypto: the server never
 * signs, and accepting exactly one algorithm removes the JWS
 * alg-confusion surface (`none`, HMAC/RSA-with-EC-public-key) by
 * construction.
 */

import { webcrypto } from 'node:crypto';
import { validatePublicJwk, importVerifyKey, type EcP256PublicJwk } from './jwks.ts';

const { subtle } = webcrypto;

/**
 * RFC 7521 §4.2 — the `client_assertion_type` a `private_key_jwt`
 * request MUST carry.
 */
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** Upper bound on an acceptable assertion; a legitimate ES256 JWT is <2 KB. */
const MAX_ASSERTION_LENGTH = 8192;

/**
 * Clock-skew tolerance (seconds) applied to `exp`/`iat`. A small fixed
 * constant — deliberately NOT reusing the DPoP config key, and small
 * enough that a leaked assertion is short-lived.
 */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Maximum accepted assertion lifetime: `exp` may be at most this many
 * seconds in the future. Caps how long a captured assertion stays usable.
 */
const MAX_LIFETIME_SECONDS = 300;

export interface VerifiedClientAssertion {
  /** The assertion's unique identifier — caller enforces single use. */
  jti: string;
  /** The assertion's expiry (seconds since epoch) — caller uses as the jti-burn TTL. */
  exp: number;
}

export interface ClientAssertionVerifyOptions {
  /** The request's authenticated client_id — must equal iss and sub. */
  clientId: string;
  /** The client's registered inline public JWK Set (raw; re-validated here). */
  jwks: { keys: unknown[] } | null | undefined;
  /** Acceptable `aud` values — the token-endpoint URL and the issuer URL. */
  expectedAudiences: string[];
  /** Injectable clock for tests (ms since epoch). */
  now?: number;
}

/**
 * Single error type for every verification failure: the client-auth
 * layer maps it uniformly to `invalid_client` with no distinguishing
 * description, so responses carry no oracle; `reason` is server-side only.
 */
export class ClientAssertionError extends Error {
  readonly code = 'invalid_client';
  readonly reason: string;
  constructor (reason: string) {
    super('client assertion verification failed');
    this.reason = reason;
  }
}

function fail (reason: string): never {
  throw new ClientAssertionError(reason);
}

function b64urlDecode (segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) fail('segment is not base64url');
  return Buffer.from(segment, 'base64url');
}

function parseJsonObject (buf: Buffer, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    fail(`${what} is not valid JSON`);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Validate the client's JWK Set for verification and select candidate
 * keys. When the header names a `kid`, only the matching key is tried;
 * otherwise every registered key is a candidate.
 */
function selectCandidateKeys (jwksRaw: { keys: unknown[] } | null | undefined, kid: unknown): EcP256PublicJwk[] {
  if (jwksRaw == null || typeof jwksRaw !== 'object' || !Array.isArray(jwksRaw.keys) || jwksRaw.keys.length === 0) {
    fail('no JWKS on file for client');
  }
  let keys: EcP256PublicJwk[];
  try {
    keys = jwksRaw.keys.map(validatePublicJwk);
  } catch {
    fail('registered JWKS is not a valid public EC P-256 set');
  }
  if (typeof kid === 'string' && kid.length > 0) {
    const matched = keys.filter((k) => k.kid === kid);
    // A named kid that matches nothing is a failure — do NOT fall back to
    // trying every key (that would let an attacker name a bogus kid and still
    // brute the set).
    if (matched.length === 0) fail('no registered key matches the assertion kid');
    return matched;
  }
  return keys;
}

/**
 * Verify a `private_key_jwt` client assertion. Returns the verified
 * `jti` + `exp`, or throws ClientAssertionError. The caller MUST
 * afterwards enforce jti single-use (burning it under the client id) so
 * a captured assertion cannot be replayed within its lifetime.
 */
export async function verifyClientAssertion (
  assertion: unknown,
  opts: ClientAssertionVerifyOptions,
): Promise<VerifiedClientAssertion> {
  if (typeof assertion !== 'string' || assertion.length === 0) fail('assertion missing');
  if (assertion.length > MAX_ASSERTION_LENGTH) fail('assertion too large');
  if (typeof opts.clientId !== 'string' || opts.clientId.length === 0) fail('clientId missing');

  const segments = assertion.split('.');
  if (segments.length !== 3 || segments.some((s) => s.length === 0)) fail('assertion is not a compact JWS');
  const [headerB64, payloadB64, signatureB64] = segments;

  const header = parseJsonObject(b64urlDecode(headerB64), 'JWS header');
  // ES256 ONLY — rejects `none`, HS*, RS*, and any alg-confusion attempt.
  if (header.alg !== 'ES256') fail('header.alg must be ES256');

  const candidates = selectCandidateKeys(opts.jwks, header.kid);

  // ES256 JWS signatures are the raw 64-byte r||s concatenation — exactly
  // the form webcrypto ECDSA verify expects.
  const signature = b64urlDecode(signatureB64);
  if (signature.length !== 64) fail('signature is not a raw ES256 signature');
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');

  let valid = false;
  for (const jwk of candidates) {
    try {
      const key = await importVerifyKey(jwk);
      if (await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, signingInput)) {
        valid = true;
        break;
      }
    } catch {
      // e.g. coordinates not on the curve — try the next candidate.
    }
  }
  if (!valid) fail('signature verification failed');

  const payload = parseJsonObject(b64urlDecode(payloadB64), 'JWS payload');

  // iss === sub === client_id, and both must equal the request's client_id.
  if (typeof payload.iss !== 'string' || payload.iss !== opts.clientId) fail('iss must equal client_id');
  if (typeof payload.sub !== 'string' || payload.sub !== opts.clientId) fail('sub must equal client_id');

  // aud: the token-endpoint URL or the issuer URL (server-derived). May be a
  // single string or an array; at least one entry must match.
  const audValues: string[] = Array.isArray(payload.aud)
    ? payload.aud.filter((a): a is string => typeof a === 'string')
    : (typeof payload.aud === 'string' ? [payload.aud] : []);
  if (audValues.length === 0) fail('aud missing');
  const accepted = new Set(opts.expectedAudiences.filter((a) => typeof a === 'string' && a.length > 0));
  if (accepted.size === 0) fail('server could not derive its token-endpoint audience');
  if (!audValues.some((a) => accepted.has(a))) fail('aud does not match the token endpoint or issuer');

  const jti = payload.jti;
  if (typeof jti !== 'string' || jti.length === 0 || jti.length > 256) fail('jti missing or out of bounds');

  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);

  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) fail('exp missing or not a number');
  if (exp <= nowSec - CLOCK_SKEW_SECONDS) fail('assertion is expired');
  if (exp > nowSec + MAX_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) fail('exp is too far in the future');

  const iat = payload.iat;
  if (iat != null) {
    if (typeof iat !== 'number' || !Number.isFinite(iat)) fail('iat is not a number');
    if (iat > nowSec + CLOCK_SKEW_SECONDS) fail('iat is in the future');
  }

  return { jti, exp };
}
