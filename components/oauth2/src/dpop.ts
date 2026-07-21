/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * DPoP (RFC 9449) proof verification — pure module, no HTTP and no
 * storage. Verifies a `DPoP` header value (a compact JWS) against the
 * request it claims to cover and derives the key's RFC 7638 thumbprint
 * (`jkt`). Replay accounting (`jti` single-use) is the CALLER's job —
 * this module only validates shape, signature and claims.
 *
 * Deliberately ES256-only (EC P-256), verification-only, and
 * dependency-free on top of node:crypto webcrypto: the server never
 * signs, and accepting exactly one algorithm removes the JWS
 * alg-confusion surface (`none`, HMAC-with-public-key) by construction.
 */

import { createHash, webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

/** Upper bound on an acceptable proof; a legitimate ES256 proof is <1 KB. */
const MAX_PROOF_LENGTH = 4096;

export interface VerifiedDPoPProof {
  /** RFC 7638 JWK thumbprint (base64url) of the proof's public key. */
  jkt: string;
  /** The proof's unique identifier — caller enforces single use. */
  jti: string;
  /** The proof's issued-at (seconds since epoch, as claimed). */
  iat: number;
}

export interface DPoPVerifyOptions {
  /** Expected HTTP method (uppercase, e.g. 'POST'). */
  htm: string;
  /** Expected external request URI (compared without query/fragment). */
  htu: string;
  /** When present, the proof's `ath` must be base64url(sha256(accessToken)). */
  accessToken?: string;
  /** Acceptance window for `iat`, in seconds (± around now). */
  clockSkewSeconds: number;
  /** Injectable clock for tests (ms since epoch). */
  now?: number;
}

/**
 * Single error type for every verification failure: the HTTP layer maps
 * it uniformly to `invalid_dpop_proof` (RFC 9449 §7.1) so responses
 * carry no oracle; `reason` is for server-side logs only.
 */
export class DPoPProofError extends Error {
  readonly code = 'invalid_dpop_proof';
  readonly reason: string;
  constructor (reason: string) {
    super('DPoP proof verification failed');
    this.reason = reason;
  }
}

function fail (reason: string): never {
  throw new DPoPProofError(reason);
}

function b64urlDecode (segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) fail('segment is not base64url');
  return Buffer.from(segment, 'base64url');
}

function b64urlSha256 (input: string): string {
  return createHash('sha256').update(input).digest('base64url');
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

interface EcPublicJwk { kty: 'EC', crv: 'P-256', x: string, y: string }

/**
 * Accept exactly a public EC P-256 key: coordinates must be 32-byte
 * base64url values and any private-key member is rejected outright.
 */
function checkJwk (jwk: unknown): EcPublicJwk {
  if (jwk == null || typeof jwk !== 'object' || Array.isArray(jwk)) fail('jwk missing or not an object');
  const k = jwk as Record<string, unknown>;
  if (k.kty !== 'EC') fail('jwk.kty must be EC');
  if (k.crv !== 'P-256') fail('jwk.crv must be P-256');
  if ('d' in k) fail('jwk carries private key material');
  for (const coord of ['x', 'y'] as const) {
    const v = k[coord];
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v)) fail(`jwk.${coord} is not a 32-byte base64url coordinate`);
  }
  return { kty: 'EC', crv: 'P-256', x: k.x as string, y: k.y as string };
}

/**
 * RFC 7638 thumbprint: SHA-256 over the JSON of the key's REQUIRED
 * members only, keys in lexicographic order, no whitespace.
 */
export function computeJkt (jwk: EcPublicJwk): string {
  return b64urlSha256(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`);
}

/**
 * htu comparison form (RFC 9449 §4.3): scheme and host lowercased,
 * default ports elided, query and fragment stripped. Paths compare
 * verbatim — '/a' and '/a/' are different resources.
 */
export function normalizeHtu (uri: string): string {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    fail('htu is not an absolute URI');
  }
  // URL already lowercases scheme+host and elides default ports.
  return url.origin + url.pathname;
}

/**
 * Verify a DPoP proof. Returns the verified claims + jkt, or throws
 * DPoPProofError. Callers MUST afterwards enforce jti single-use and,
 * where a binding exists, compare jkt with the bound thumbprint.
 */
export async function verifyDPoPProof (proof: unknown, opts: DPoPVerifyOptions): Promise<VerifiedDPoPProof> {
  if (typeof proof !== 'string' || proof.length === 0) fail('proof missing');
  if (proof.length > MAX_PROOF_LENGTH) fail('proof too large');
  const segments = proof.split('.');
  if (segments.length !== 3 || segments.some((s) => s.length === 0)) fail('proof is not a compact JWS');
  const [headerB64, payloadB64, signatureB64] = segments;

  const header = parseJsonObject(b64urlDecode(headerB64), 'JWS header');
  if (header.typ !== 'dpop+jwt') fail('header.typ must be dpop+jwt');
  if (header.alg !== 'ES256') fail('header.alg must be ES256');
  const jwk = checkJwk(header.jwk);

  // ES256 JWS signatures are the raw 64-byte r||s concatenation —
  // exactly the form webcrypto ECDSA verify expects.
  const signature = b64urlDecode(signatureB64);
  if (signature.length !== 64) fail('signature is not a raw ES256 signature');
  let valid = false;
  try {
    // Import ONLY the sanitized members — never the raw header object.
    const key = await subtle.importKey(
      'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );
    valid = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      Buffer.from(`${headerB64}.${payloadB64}`, 'utf8')
    );
  } catch {
    // e.g. coordinates not on the curve — a proof defect, not a server error.
    fail('public key rejected');
  }
  if (!valid) fail('signature verification failed');

  const payload = parseJsonObject(b64urlDecode(payloadB64), 'JWS payload');

  const jti = payload.jti;
  if (typeof jti !== 'string' || jti.length === 0 || jti.length > 256) fail('jti missing or out of bounds');

  if (payload.htm !== opts.htm) fail('htm does not match the request method');
  if (typeof payload.htu !== 'string' || normalizeHtu(payload.htu) !== normalizeHtu(opts.htu)) {
    fail('htu does not match the request URI');
  }

  const iat = payload.iat;
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof iat !== 'number' || !Number.isFinite(iat)) fail('iat missing or not a number');
  if (Math.abs(nowSeconds - iat) > opts.clockSkewSeconds) fail('iat outside the acceptance window');

  if (opts.accessToken != null) {
    if (payload.ath !== b64urlSha256(opts.accessToken)) fail('ath does not match the access token');
  }

  return { jkt: computeJkt(jwk), jti, iat };
}
