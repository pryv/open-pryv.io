/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `POST /oauth2/authorize/refuse` handler.
 *
 * Called from app-web-auth3 when the user declines consent. Body:
 *   { state: <signed-state> }
 *
 * Server verifies the signed state (so we never redirect to an
 * unverified URL — open-redirector defense, mirroring /authorize) and
 * returns the redirect URL the client should navigate to:
 *
 *   <redirect_uri>?error=access_denied&state=<original-csrf>&iss=<issuer>
 *
 * No access is created. No code row is persisted. Emits the
 * `oauth.consent.refused` audit event.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { verifyState } = require('../signedState.ts');
const { issuerFromConfig } = require('../issuer.ts');
const { audit } = require('../audit.ts');

export type RefuseDeps = {
  config: { get (key: string): unknown };
};

export function handleRefuse (deps: RefuseDeps) {
  return async function refuse (req: any, res: any): Promise<void> {
    const issuer = issuerFromConfig(deps.config);
    const adminKey = String(deps.config.get('auth:adminAccessKey') ?? '');
    if (!issuer || !adminKey) {
      return sendJson(res, 500, { error: 'server_error', error_description: 'service:api or auth:adminAccessKey not configured' });
    }

    const body = req.body ?? {};
    if (typeof body.state !== 'string' || body.state.length === 0) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'state is required' });
    }

    const verified = verifyState(adminKey, body.state);
    if (!verified.ok) {
      return sendJson(res, 400, {
        error: 'invalid_request',
        error_description: `signed state ${verified.reason}`,
      });
    }
    const payload = verified.payload;

    await audit('oauth.consent.refused', {
      clientId: payload.clientId,
      requestedScope: payload.scope,
      reason: 'user-declined',
    });

    const sep = payload.redirectUri.indexOf('?') >= 0 ? '&' : '?';
    const redirectTo = payload.redirectUri + sep +
      'error=access_denied' +
      '&state=' + encodeURIComponent(payload.state) +
      '&iss=' + encodeURIComponent(issuer);

    return sendJson(res, 200, { redirectTo });
  };
}

function sendJson (res: any, status: number, body: any): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
