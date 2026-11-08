/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `POST /oauth2/authorize/refuse` handler.
 *
 * Called from the consent UI (e.g. app-web-user-account, the current
 * reference UI) when the user declines consent. Body:
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

import { verifyState, stateKeyFromConfig } from '../signedState.ts';
import type { PerUserIssuerOf } from '../perUserIssuer.ts';
import { requestIssuer, stateIssuerRefusal } from '../perUserIssuer.ts';
import { audit } from '../audit.ts';

import type { Request, Response } from 'express';

export type RefuseDeps = {
  config: { get (key: string): unknown };
  /** The per-user issuer of a request on an account's host (`oauth:perUserIssuer`). */
  perUserIssuerOf?: PerUserIssuerOf;
};

export function handleRefuse (deps: RefuseDeps) {
  return async function refuse (req: Request, res: Response): Promise<void> {
    const current = await requestIssuer(deps.config, deps.perUserIssuerOf, req);
    const issuer = current.issuer;
    const stateKey = stateKeyFromConfig(deps.config);
    if (!issuer || !stateKey) {
      return sendJson(res, 500, { error: 'server_error', error_description: 'service:api or oauth:stateKey not configured' });
    }

    const body = req.body ?? {};
    if (typeof body.state !== 'string' || body.state.length === 0) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'state is required' });
    }

    const verified = verifyState(stateKey, body.state);
    if (!verified.ok) {
      return sendJson(res, 400, {
        error: 'invalid_request',
        error_description: `signed state ${verified.reason}`,
      });
    }
    const payload = verified.payload;
    // Answered with the issuer the authorization was made at, never another.
    const otherIssuer = stateIssuerRefusal(deps.config, payload.issuer, current);
    if (otherIssuer != null) return sendJson(res, otherIssuer.status, otherIssuer.body);

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

function sendJson (res: Response, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
