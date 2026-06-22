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
 *   { state: <signed-state>, userToken: <personal-access-token>,
 *     grantedScope: string[] }
 *
 * Server:
 *   1. Verifies the signed state (returns 400 on tamper/expired).
 *   2. Resolves userToken → { userId, username } via the injected
 *      `resolveUser` helper (provided by the route mount).
 *   3. Validates grantedScope ⊆ requestedScope (scope-downgrade).
 *   4. Mints an authorization code (CUID2, opaque).
 *   5. Stores the code row in PlatformDB via storage.setCode.
 *   6. Returns the redirect URL `redirect_uri?code=...&state=...&iss=...`.
 *
 * Refuse path: when the user declines, app-web-auth3 should NOT call
 * this endpoint — it should navigate the user-agent directly to
 * `redirect_uri?error=access_denied&state=...&iss=...`. That path is
 * client-side; nothing for the server to do beyond audit (deferred).
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const cuid = require('cuid');
const { verifyState } = require('../signedState.ts');
const { setCode } = require('../storage.ts');
const { audit } = require('../audit.ts');

/** Resolver provided by the route mount: token → { userId, username } | null. */
export type ResolveUser = (userToken: string) => Promise<{ userId: string; username: string } | null>;

/** Shape of the inputs the host app injects. */
export type AcceptDeps = {
  config: { get (key: string): unknown };
  platform: any;
  resolveUser: ResolveUser;
};

/** Authorization-code lifetime — 10 minutes per RFC 6749 §4.1.2. */
export const CODE_TTL_SECONDS = 600;

/** Express-style handler factory. */
export function handleAccept (deps: AcceptDeps) {
  return async function accept (req: any, res: any): Promise<void> {
    const issuer = String(deps.config.get('service:api') ?? '').replace(/\/$/, '');
    const adminKey = String(deps.config.get('auth:adminAccessKey') ?? '');
    const coreId = String(deps.config.get('core:id') ?? 'single');
    if (!issuer || !adminKey) {
      return sendJson(res, 500, { error: 'server_error', error_description: 'service:api or auth:adminAccessKey not configured' });
    }

    const body = req.body ?? {};
    if (!isNonEmptyString(body.state)) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'state is required' });
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

    // Resolve the user token.
    const user = await deps.resolveUser(body.userToken);
    if (user == null) {
      return sendJson(res, 401, {
        error: 'invalid_request',
        error_description: 'userToken did not resolve to a valid user session',
      });
    }

    // Mint code + persist.
    const code = cuid();
    const expiresAt = Date.now() + CODE_TTL_SECONDS * 1000;
    await setCode(deps.platform, coreId, code, {
      clientId: payload.clientId,
      redirectUri: payload.redirectUri,
      codeChallenge: payload.codeChallenge,
      codeChallengeMethod: payload.codeChallengeMethod,
      userId: user.userId,
      scope: granted,
      expiresAt,
    });

    await audit('oauth.consent.granted', {
      clientId: payload.clientId,
      userId: user.userId,
      requestedScope: payload.scope,
      grantedScope: granted,
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
