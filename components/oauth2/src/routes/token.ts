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
 * The current substrate wires only `authorization_code`; the same
 * dispatcher will pick up `refresh_token` and `client_credentials` as
 * their handlers ship.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { handleAuthorizationCode } = require('../grants/authorization_code.ts');
const { handleRefreshToken } = require('../grants/refresh_token.ts');

export type TokenDeps = {
  config: { get (key: string): unknown };
  platform: any;
  /** Required when grant_type=refresh_token is dispatched. */
  mintRefreshedAccess?: (params: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
  }) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;
};

export function handleToken (deps: TokenDeps) {
  return async function token (req: any, res: any): Promise<void> {
    const body = req.body ?? {};
    const grantType = typeof body.grant_type === 'string' ? body.grant_type : '';

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
      const body: Record<string, unknown> = { error: outcome.error };
      if (outcome.description) body.error_description = outcome.description;
      res.end(JSON.stringify(body));
    }
  };
}
