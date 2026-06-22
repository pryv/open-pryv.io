/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — hand-maintained Pryv error.id → RFC 6749 §5.2 error enum map.
 *
 * Per Phase A §17 Q5 close (2026-06-19): map at the endpoint edge,
 * NOT auto-derived from the Pryv error catalogue. Reasons:
 * - keeps the OAuth surface decoupled from internal error churn
 * - one file to review for OAuth compliance
 * - explicit default (unmapped → invalid_request) avoids leaking
 *   Pryv-specific error.ids to vanilla OAuth clients
 *
 * Add new entries here whenever a Pryv error.id surfaces on an
 * /oauth2/* route. See IMPLEMENTERS-GUIDE.md.
 */

/**
 * The closed RFC 6749 §5.2 enum + the RFC 6749 §4.1.2.1 + RFC 6750 §3.1
 * additions that downstream consumers may emit.
 */
export type OAuth2Error =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'server_error'
  | 'temporarily_unavailable'
  // RFC 6750 §3.1 — resource-server use
  | 'invalid_token'
  | 'insufficient_scope';

/**
 * Hand-maintained mapping. Add a row when a new Pryv error.id
 * surfaces on /oauth2/*. Default fallback: `invalid_request`.
 */
export const errorMap: Record<string, OAuth2Error> = {
  // --- request shape / param validation ---
  'invalid-parameters-format': 'invalid_request',
  'invalid-method': 'invalid_request',
  'missing-required-fields': 'invalid_request',

  // --- client identification / authentication ---
  'unknown-client': 'invalid_client',
  'unknown-referenced-resource': 'invalid_client', // when the referenced resource is the client_id
  'invalid-client-secret': 'invalid_client',
  'app-account-not-registered': 'invalid_client',

  // --- redirect_uri / response_type ---
  'invalid-redirect-uri': 'invalid_request',
  'unregistered-redirect-uri': 'invalid_request',
  'unsupported-response-type': 'unsupported_response_type',

  // --- scope ---
  'unknown-scope': 'invalid_scope',
  'scope-not-granted': 'invalid_scope',
  'scope-not-subset': 'invalid_scope', // user granted a superset claim

  // --- grant ---
  'unsupported-grant-type': 'unsupported_grant_type',
  'invalid-authorization-code': 'invalid_grant',
  'expired-authorization-code': 'invalid_grant',
  'authorization-code-already-used': 'invalid_grant',
  'invalid-pkce-verifier': 'invalid_grant',
  'invalid-refresh-token': 'invalid_grant',
  'expired-refresh-token': 'invalid_grant',
  'revoked-refresh-token': 'invalid_grant',

  // --- consent ---
  'user-refused-consent': 'access_denied',

  // --- access control ---
  'mfa-required': 'unauthorized_client',
  'app-account-not-mfa-enrolled': 'unauthorized_client',

  // --- server-side ---
  'temporarily-unavailable': 'temporarily_unavailable',
  'internal-error': 'server_error',
  'platform-storage-unavailable': 'temporarily_unavailable',

  // --- resource-server (M2+ uses these via WWW-Authenticate) ---
  'expired-access-token': 'invalid_token',
  'revoked-access-token': 'invalid_token',
  'unknown-access-token': 'invalid_token',
};

const FALLBACK: OAuth2Error = 'invalid_request';

/**
 * Map a Pryv `error.id` to the closest RFC 6749 §5.2 enum value.
 * Unknown error.ids fall through to `invalid_request` (per RFC: the
 * generic error for malformed requests; safer than leaking Pryv
 * internal error.ids to OAuth clients).
 */
export function mapError (pryvErrorId: string): OAuth2Error {
  if (typeof pryvErrorId !== 'string' || pryvErrorId.length === 0) {
    return FALLBACK;
  }
  return errorMap[pryvErrorId] ?? FALLBACK;
}

/**
 * Format an RFC 6749 §5.2 error response body.
 */
export function buildErrorResponse (
  oauthError: OAuth2Error,
  description?: string,
  uri?: string,
): { error: OAuth2Error; error_description?: string; error_uri?: string } {
  const body: ReturnType<typeof buildErrorResponse> = { error: oauthError };
  if (description != null) body.error_description = description;
  if (uri != null) body.error_uri = uri;
  return body;
}
