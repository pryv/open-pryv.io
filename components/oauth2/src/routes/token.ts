/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `POST /oauth2/token` handler.
 *
 * Dispatches by `grant_type` to a grant-specific handler. CORS is
 * applied by the route mount (corsMiddleware); the body is expected
 * pre-parsed as `application/x-www-form-urlencoded` (api-server's
 * existing body parser handles both that and `application/json`).
 *
 * Wired grants: authorization_code, refresh_token, client_credentials.
 * Each grant handler returns either {ok:true, body} or {ok:false,
 * status, error, description?}; the dispatcher translates to HTTP.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { handleAuthorizationCode } = require('../grants/authorization_code.ts');
const { handleRefreshToken } = require('../grants/refresh_token.ts');
const { handleClientCredentials } = require('../grants/client_credentials.ts');

export type TokenDeps = {
  config: { get (key: string): unknown };
  platform: any;
  /** Required when grant_type=refresh_token is dispatched. */
  mintRefreshedAccess?: (params: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
  }) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;
  /** Required when grant_type=client_credentials is dispatched. */
  mintClientAccess?: (params: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
  }) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;
  /** Required when grant_type=client_credentials is dispatched. */
  resolveAccountUserId?: (username: string) => Promise<string | null>;
};

/**
 * Decode RFC 6749 §2.3.1 Basic credentials from an Authorization
 * header. Returns null if absent or malformed. The values are URL-
 * decoded per spec (the header carries percent-encoded credentials).
 */
function decodeBasicAuth (headerValue: unknown): { client_id: string; client_secret: string } | null {
  if (typeof headerValue !== 'string') return null;
  const m = headerValue.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/);
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

export function handleToken (deps: TokenDeps) {
  return async function token (req: any, res: any): Promise<void> {
    const body = req.body ?? {};
    const grantType = typeof body.grant_type === 'string' ? body.grant_type : '';
    const basic = decodeBasicAuth(req.headers?.authorization);

    let outcome;
    if (grantType === 'authorization_code') {
      outcome = await handleAuthorizationCode(
        { config: deps.config, platform: deps.platform },
        body,
      );
    } else if (grantType === 'refresh_token') {
      if (typeof deps.mintRefreshedAccess !== 'function') {
        outcome = { ok: false, status: 501, error: 'unsupported_grant_type', description: 'refresh_token grant is not wired on this deployment' };
      } else {
        outcome = await handleRefreshToken(
          { config: deps.config, platform: deps.platform, mintRefreshedAccess: deps.mintRefreshedAccess },
          body,
        );
      }
    } else if (grantType === 'client_credentials') {
      if (typeof deps.mintClientAccess !== 'function' || typeof deps.resolveAccountUserId !== 'function') {
        outcome = { ok: false, status: 501, error: 'unsupported_grant_type', description: 'client_credentials grant is not wired on this deployment' };
      } else {
        outcome = await handleClientCredentials(
          {
            config: deps.config,
            platform: deps.platform,
            mintClientAccess: deps.mintClientAccess,
            resolveAccountUserId: deps.resolveAccountUserId,
          },
          { ...body, basic },
        );
      }
    } else if (grantType === '') {
      outcome = { ok: false, status: 400, error: 'invalid_request', description: 'grant_type is required' };
    } else {
      outcome = {
        ok: false,
        status: 400,
        error: 'unsupported_grant_type',
        description: `grant_type "${grantType}" is not supported`,
      };
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (outcome.ok) {
      res.statusCode = 200;
      res.end(JSON.stringify(outcome.body));
    } else {
      res.statusCode = outcome.status;
      const resBody: Record<string, unknown> = { error: outcome.error };
      if (outcome.description) resBody.error_description = outcome.description;
      res.end(JSON.stringify(resBody));
    }
  };
}
