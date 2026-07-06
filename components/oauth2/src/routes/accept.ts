/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `POST /oauth2/authorize/accept` handler.
 *
 * Called from app-web-auth3 after the user accepts the consent. Body:
 *   { state: <signed-state>, username: <user>, userToken: <user's
 *     personal access token>, grantedScope: string[] }
 *
 * Server flow:
 *   1. Verify the signed state (400 on tamper/expired).
 *   2. Validate grantedScope ⊆ requestedScope (scope-downgrade).
 *   3. Resolve {username, userToken} → an authenticated user-session
 *      handle via the injected `resolveUser` helper. The handle carries
 *      whatever the host app needs to make subsequent API calls on
 *      behalf of the user (a MethodContext in the real wiring).
 *   4. Use the injected `createAccess` helper to mint an app access
 *      under that user. The user is the auth principal — full
 *      accesses.create chain runs (permission checks + hooks).
 *   5. Persist the {code, accessId, accessToken, apiEndpoint, …} row
 *      in PlatformDB. The grant just retrieves these at /token time
 *      after PKCE verification — the user is gone by then, so all
 *      access creation MUST happen here.
 *   6. Return the redirect URL `redirect_uri?code=…&state=…&iss=…`.
 *
 * Refuse path: when the user declines, app-web-auth3 should NOT call
 * this endpoint — it should navigate the user-agent directly to
 * `redirect_uri?error=access_denied&state=…&iss=…`. That path is
 * client-side; nothing for the server to do beyond audit (deferred).
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const cuid = require('cuid');
const { verifyState } = require('../signedState.ts');
const { issuerFromConfig } = require('../issuer.ts');
const { setCode } = require('../storage.ts');
const { audit } = require('../audit.ts');

/** Authenticated user-session handle, opaque to this module. */
export type UserSession = {
  userId: string;
  username: string;
  /** Host-app data piggybacked through createAccess (e.g. MethodContext). */
  [key: string]: unknown;
};

/** Resolver provided by the route mount: {username, userToken} → session | null. */
export type ResolveUser = (params: { username: string; userToken: string })
  => Promise<UserSession | null>;

/** Access-creator provided by the route mount: mints an OAuth app access for the resolved user. */
export type CreateAccess = (params: {
  session: UserSession;
  clientId: string;
  scope: string[];
  expiresAt: number;
}) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;

/** Shape of the inputs the host app injects. */
export type AcceptDeps = {
  config: { get (key: string): unknown };
  platform: any;
  resolveUser: ResolveUser;
  createAccess: CreateAccess;
};

/** Authorization-code lifetime — 10 minutes per RFC 6749 §4.1.2. */
export const CODE_TTL_SECONDS = 600;

/** Express-style handler factory. */
export function handleAccept (deps: AcceptDeps) {
  return async function accept (req: any, res: any): Promise<void> {
    const issuer = issuerFromConfig(deps.config);
    const adminKey = String(deps.config.get('auth:adminAccessKey') ?? '');
    const coreId = String(deps.config.get('core:id') ?? 'single');
    const accessTokenTTL = Number(deps.config.get('oauth:accessTokenTTL') ?? 3600);
    if (!issuer || !adminKey) {
      return sendJson(res, 500, { error: 'server_error', error_description: 'service:api or auth:adminAccessKey not configured' });
    }

    const body = req.body ?? {};
    if (!isNonEmptyString(body.state)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'state is required' });
    }
    if (!isNonEmptyString(body.username)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'username is required' });
    }
    if (!isNonEmptyString(body.userToken)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'userToken is required' });
    }
    if (!Array.isArray(body.grantedScope)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'grantedScope must be an array' });
    }

    const verified = verifyState(adminKey, body.state);
    if (!verified.ok) {
      return sendJson(res, 400, {
        error: 'invalid_request',
        error_description: `signed state ${verified.reason}`,
      });
    }
    const payload = verified.payload;

    // Scope-downgrade check: granted MUST be a subset of requested.
    const requested = new Set<string>(payload.scope);
    const granted = body.grantedScope.filter((s: unknown) => typeof s === 'string') as string[];
    for (const g of granted) {
      if (!requested.has(g)) {
        return sendJson(res, 400, {
          error: 'invalid_scope',
          error_description: `granted scope "${g}" was not in the requested set`,
        });
      }
    }

    // Resolve the user session via {username, userToken}.
    const session = await deps.resolveUser({ username: body.username, userToken: body.userToken });
    if (session == null) {
      return sendJson(res, 401, {
        error: 'invalid_request',
        error_description: 'username + userToken did not resolve to a valid user session',
      });
    }

    // Mint the app access under the resolved user. The user is the auth
    // principal — full accesses.create chain runs.
    const accessExpiresAt = Date.now() + accessTokenTTL * 1000;
    let access;
    try {
      access = await deps.createAccess({
        session,
        clientId: payload.clientId,
        scope: granted,
        expiresAt: accessExpiresAt,
      });
    } catch (err: any) {
      return sendJson(res, 500, {
        error: 'server_error',
        error_description: 'failed to create access: ' + (err?.message ?? String(err)),
      });
    }

    // Mint code + persist with the access details so the grant can
    // return them after PKCE verification (user is gone by then).
    const code = cuid();
    const codeExpiresAt = Date.now() + CODE_TTL_SECONDS * 1000;
    await setCode(deps.platform, coreId, code, {
      clientId: payload.clientId,
      redirectUri: payload.redirectUri,
      codeChallenge: payload.codeChallenge,
      codeChallengeMethod: payload.codeChallengeMethod,
      userId: session.userId,
      username: session.username,
      scope: granted,
      expiresAt: codeExpiresAt,
      accessId: access.accessId,
      accessToken: access.accessToken,
      apiEndpoint: access.apiEndpoint,
    });

    await audit('oauth.consent.granted', {
      clientId: payload.clientId,
      userId: session.userId,
      requestedScope: payload.scope,
      grantedScope: granted,
      accessId: access.accessId,
    });

    const sep = payload.redirectUri.indexOf('?') >= 0 ? '&' : '?';
    const redirectTo = payload.redirectUri + sep +
      'code=' + encodeURIComponent(code) +
      '&state=' + encodeURIComponent(payload.state) +
      '&iss=' + encodeURIComponent(issuer);

    return sendJson(res, 200, { redirectTo });
  };
}

function isNonEmptyString (v: unknown): boolean {
  return typeof v === 'string' && v.length > 0;
}

function sendJson (res: any, status: number, body: any): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
