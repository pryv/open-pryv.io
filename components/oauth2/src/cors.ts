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
 * Okta on equivalent endpoints. Applied to the whole OAuth surface
 * (`OAUTH_CORS_PATHS`: every `/oauth2/*` route, among them the token,
 * revocation and consent-screen endpoints, and the `/.well-known/*`
 * discovery documents): each answer carries it and every preflight is
 * answered by it (204). The API's own CORS middleware leaves that
 * surface alone (`isOAuthSurface`), so no credentials header and no
 * echoed origin reach these answers.
 */

import type { Request, Response } from 'express';

const ALLOW_HEADERS = 'Content-Type, Authorization, DPoP';
const ALLOW_METHODS = 'POST, GET, OPTIONS';
const MAX_AGE = '3600';

/** Path prefixes the OAuth policy owns (the API's CORS middleware leaves them alone). */
export const OAUTH_CORS_PATHS: readonly string[] = Object.freeze(['/oauth2/', '/.well-known/']);

/** True for a request path on the OAuth surface (`OAUTH_CORS_PATHS`). */
export function isOAuthSurface (path: string): boolean {
  return OAUTH_CORS_PATHS.some((prefix) => path.startsWith(prefix));
}

/**
 * Apply the CORS response headers. Idempotent; safe to call before any
 * response.
 */
export function applyCors (req: Request, res: Response): void {
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
export function corsMiddleware (req: Request, res: Response, next: () => void): void {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  next();
}
