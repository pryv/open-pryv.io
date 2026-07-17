/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — CORS middleware for the public OAuth surface.
 *
 * Policy: allow-all origins, NO credentials. Browser clients use PKCE
 * for binding; cookies must not cross. Same policy as Google/Auth0/
 * Okta on equivalent endpoints. Applied to:
 *   - `POST /oauth2/token` (preflight + response)
 *   - `OPTIONS /oauth2/token` (preflight only)
 *   - `GET /oauth2/authorize` (no preflight; safe-method, no headers required)
 *   - `GET /.well-known/oauth-authorization-server` (handled inline in wellKnown.ts)
 */

const ALLOW_HEADERS = 'Content-Type, Authorization, DPoP';
const ALLOW_METHODS = 'POST, GET, OPTIONS';
const MAX_AGE = '3600';

/**
 * Apply the CORS response headers. Idempotent; safe to call before any
 * response.
 */
export function applyCors (req: any, res: any): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
  res.setHeader('Access-Control-Max-Age', MAX_AGE);
  res.setHeader('Vary', 'Origin');
}

/**
 * Express-style middleware: apply CORS headers on every response and
 * short-circuit OPTIONS preflight with 204.
 */
export function corsMiddleware (req: any, res: any, next: () => void): void {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  next();
}
