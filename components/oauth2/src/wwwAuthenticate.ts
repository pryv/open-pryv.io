/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — WWW-Authenticate challenge header builders (RFC 6750 §3).
 *
 * Used by components/middleware/getAuth.ts on 401 responses. The
 * helpers keep the header-format minutiae in one place so middleware
 * stays clean.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import type { OAuth2Error } from './errorMap.ts';

/**
 * Build a `Bearer`-scheme challenge string. Per RFC 6750 §3:
 *   WWW-Authenticate: Bearer realm="<realm>"[, error="<err>"][, error_description="<desc>"]
 *
 * Realm should be the service short-name (`service.name` from config);
 * defaults to "pryv.io" if unset.
 */
export function WWW_AUTHENTICATE_BEARER (
  realm: string = 'pryv.io',
  error?: Extract<OAuth2Error, 'invalid_request' | 'invalid_token' | 'insufficient_scope'>,
  errorDescription?: string,
): string {
  const parts = [`realm="${escapeQuoted(realm)}"`];
  if (error != null) parts.push(`error="${error}"`);
  if (errorDescription != null) parts.push(`error_description="${escapeQuoted(errorDescription)}"`);
  return `Bearer ${parts.join(', ')}`;
}

/**
 * Phase F preview — `DPoP`-scheme challenge. Same shape, different
 * scheme keyword. M1 doesn't emit it; left here so M2's middleware
 * edit can reference both consistently.
 */
export function WWW_AUTHENTICATE_DPOP (
  realm: string = 'pryv.io',
  error?: Extract<OAuth2Error, 'invalid_request' | 'invalid_token' | 'insufficient_scope'>,
  errorDescription?: string,
  algs: string[] = ['ES256'],
): string {
  const parts = [
    `realm="${escapeQuoted(realm)}"`,
    `algs="${algs.join(' ')}"`,
  ];
  if (error != null) parts.push(`error="${error}"`);
  if (errorDescription != null) parts.push(`error_description="${escapeQuoted(errorDescription)}"`);
  return `DPoP ${parts.join(', ')}`;
}

/**
 * Escape a string for inclusion inside an HTTP quoted-string. Per
 * RFC 7230 §3.2.6 `quoted-string` permits TEXT minus DQUOTE; backslash
 * is the escape character. Conservative: replace `\` and `"`.
 */
function escapeQuoted (s: string): string {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
