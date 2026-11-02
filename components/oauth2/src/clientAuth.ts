/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: client authentication helpers shared by the endpoints that
 * authenticate a client (token, introspection, revocation). No route module in
 * here, so any endpoint can import it without a cycle.
 */

import { CLIENT_ASSERTION_TYPE } from './clientAssertion.ts';

/** Same bound as the assertion verifier: a legitimate assertion is <2 KB. */
const MAX_ASSERTION_LENGTH = 8192;

/**
 * The client a `private_key_jwt` assertion names (RFC 7521 §4.2,
 * RFC 7523 §3: `client_id` is optional next to a `client_assertion`).
 * Reads the assertion's `iss` WITHOUT verifying anything: the caller then
 * authenticates the client named this way exactly as it would a body
 * `client_id` (signature, iss/sub, aud, exp, jti burn). Returns null when
 * the type is not the jwt-bearer URN, the assertion is not a compact JWS
 * with a JSON payload, or `iss` is missing or differs from `sub`: callers
 * answer that with their uniform `invalid_client`.
 */
export function clientIdFromAssertion (assertion: unknown, assertionType: unknown): string | null {
  if (assertionType !== CLIENT_ASSERTION_TYPE) return null;
  if (typeof assertion !== 'string' || assertion.length === 0 || assertion.length > MAX_ASSERTION_LENGTH) return null;
  const segments = assertion.split('.');
  if (segments.length !== 3 || segments.some((s) => !/^[A-Za-z0-9_-]+$/.test(s))) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { iss, sub } = payload as Record<string, unknown>;
  if (typeof iss !== 'string' || iss.length === 0 || iss !== sub) return null;
  return iss;
}

/** A client with a public key set on file, inline or by `jwks_uri` (`private_key_jwt`). */
export function hasKeySet (client: { jwks?: { keys: unknown[] }; jwksUri?: unknown } | null | undefined): boolean {
  return (client?.jwks != null && Array.isArray(client.jwks.keys) && client.jwks.keys.length > 0) ||
    (typeof client?.jwksUri === 'string' && client.jwksUri.length > 0);
}

/** A client that authenticates: a secret or a key set on file. */
export function isConfidentialClient (client: { clientSecretHash?: unknown; jwks?: { keys: unknown[] }; jwksUri?: unknown } | null | undefined): boolean {
  return client != null && ((typeof client.clientSecretHash === 'string' && client.clientSecretHash.length > 0) || hasKeySet(client));
}

/**
 * Decode RFC 6749 §2.3.1 Basic credentials from an Authorization
 * header. Returns null if absent or malformed. The values are URL-
 * decoded per spec (the header carries percent-encoded credentials).
 */
export function decodeBasicAuth (headerValue: unknown): { client_id: string; client_secret: string } | null {
  if (typeof headerValue !== 'string') return null;
  // RFC 7617 §2: the `Basic` auth-scheme name is case-INSENSITIVE (`basic`,
  // `BASIC`, … are all valid). The base64 credentials stay strict.
  const m = headerValue.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (m == null) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx <= 0) return null;
  try {
    return {
      client_id: decodeURIComponent(decoded.slice(0, idx)),
      client_secret: decodeURIComponent(decoded.slice(idx + 1)),
    };
  } catch {
    return null;
  }
}
