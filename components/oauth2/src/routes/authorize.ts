/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `GET /oauth2/authorize` handler.
 *
 * Validates the OAuth client's request, looks up the client metadata,
 * exact-matches the presented `redirect_uri` against the registered
 * set (with loopback-port carve-out per RFC 8252), and either:
 *   - Redirects to the consent UI (signed-state in URL parameter) on
 *     success, or
 *   - Renders an HTML 400 if `redirect_uri` is invalid (open-redirector
 *     defense — never bounce the user-agent to an unverified URL), or
 *   - Redirects to the verified `redirect_uri` with an RFC 6749 error
 *     enum + the client's `state` + `iss` parameter (RFC 9207) for
 *     other validation failures.
 *
 * Cross-core routing (multi-core deployments): see follow-up commit —
 * for now, /oauth2/authorize lands on whichever core received the
 * request; cross-core code/refresh forwarding happens at /oauth2/token.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { getClient, validateRedirectUri } = require('../clientRegistry.ts');
const { mapError } = require('../errorMap.ts');
const { parseScopes, ScopeParseError } = require('../scopeRegistry.ts');
const { signState } = require('../signedState.ts');
const { audit } = require('../audit.ts');

/** Shape of the inputs the host app injects. */
export type AuthorizeDeps = {
  config: { get (key: string): unknown };
  platform: any; // raw PlatformDB
};

/** Express-style handler factory. */
export function handleAuthorize (deps: AuthorizeDeps) {
  return async function authorize (req: any, res: any): Promise<void> {
    const issuer = String(deps.config.get('service:api') ?? '').replace(/\/$/, '');
    if (!issuer) return sendServerError(res, 'service:api not configured');
    const adminKey = String(deps.config.get('auth:adminAccessKey') ?? '');
    if (!adminKey) return sendServerError(res, 'auth:adminAccessKey not configured');
    const consentUrl = String(deps.config.get('oauth:consentUrl') ?? '').replace(/\/$/, '');
    if (!consentUrl) return sendServerError(res, 'oauth:consentUrl not configured');

    const q = req.query ?? {};

    // 1. Parameter shape — these MUST be present before we can do anything
    //    useful, including building an error redirect.
    if (!isNonEmptyString(q.client_id)) {
      return sendHtmlError(res, 400, 'Missing client_id parameter.');
    }
    if (!isNonEmptyString(q.redirect_uri)) {
      return sendHtmlError(res, 400, 'Missing redirect_uri parameter.');
    }

    // 2. Look up the client + validate redirect_uri BEFORE redirecting
    //    anywhere. An invalid redirect_uri renders HTML 400; we never
    //    bounce the user-agent to an unverified URL (open-redirector
    //    defense — T-04).
    const client = await getClient(deps.platform, q.client_id);
    if (client == null) {
      return sendHtmlError(res, 400, `Unknown client_id: ${q.client_id}`);
    }
    if (!validateRedirectUri(client.redirectUris, q.redirect_uri)) {
      return sendHtmlError(res, 400,
        `redirect_uri does not match any registered URI for this client.`);
    }

    // From here on, errors redirect the user-agent back to the
    // VALIDATED redirect_uri with an RFC 6749 error enum + state + iss.
    const state = isNonEmptyString(q.state) ? String(q.state) : '';
    const redirectError = (errorEnum: string, description?: string): void => {
      sendErrorRedirect(res, q.redirect_uri, errorEnum, state, issuer, description);
    };

    if (q.response_type !== 'code') {
      return redirectError('unsupported_response_type', 'only response_type=code is supported');
    }
    if (!isNonEmptyString(q.code_challenge)) {
      return redirectError('invalid_request', 'PKCE code_challenge is required');
    }
    if (q.code_challenge_method !== 'S256') {
      return redirectError('invalid_request', 'PKCE code_challenge_method must be S256');
    }
    if (!isNonEmptyString(q.state)) {
      return redirectError('invalid_request', 'state parameter is required (CSRF defense)');
    }

    // Scope validation — must parse cleanly through the registered
    // namespace parsers, and the resulting tokens must be a subset of
    // the client's registered scope set.
    const scopeStr = isNonEmptyString(q.scope) ? String(q.scope) : '';
    let parsedScopes;
    try {
      parsedScopes = parseScopes(scopeStr);
    } catch (e: any) {
      if (e instanceof ScopeParseError) {
        return redirectError('invalid_scope', e.message);
      }
      throw e;
    }
    const requestedScopeTokens = parsedScopes.map((s: any) => s.raw);
    const registered = new Set<string>(client.scope ?? []);
    const unrecognised = requestedScopeTokens.filter((t: string) => !registered.has(t));
    if (unrecognised.length > 0) {
      return redirectError('invalid_scope',
        `client is not registered for scope(s): ${unrecognised.join(' ')}`);
    }

    // All good — emit consent.shown audit, sign the state, redirect to
    // the consent UI.
    await audit('oauth.consent.shown', {
      clientId: client.clientId,
      requestedScope: requestedScopeTokens,
    });

    const signed = signState(adminKey, {
      clientId: client.clientId,
      redirectUri: q.redirect_uri,
      state,
      codeChallenge: q.code_challenge,
      codeChallengeMethod: 'S256',
      scope: requestedScopeTokens,
      userIdHint: isNonEmptyString(q.login_hint) ? String(q.login_hint) : undefined,
    });

    const sep = consentUrl.indexOf('?') >= 0 ? '&' : '?';
    const consentRedirect = consentUrl + sep + 'state=' + encodeURIComponent(signed);
    res.statusCode = 302;
    res.setHeader('Location', consentRedirect);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.end();
  };
}

function isNonEmptyString (v: unknown): boolean {
  return typeof v === 'string' && v.length > 0;
}

function escapeHtml (s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sendHtmlError (res: any, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!DOCTYPE html><html><head><title>OAuth error</title></head>` +
    `<body><h1>Authorization failed</h1><p>${escapeHtml(message)}</p></body></html>`);
}

function sendServerError (res: any, reason: string): void {
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: 'server_error', error_description: reason }));
}

function sendErrorRedirect (
  res: any,
  redirectUri: string,
  errorEnum: string,
  state: string,
  issuer: string,
  description?: string,
): void {
  const sep = redirectUri.indexOf('?') >= 0 ? '&' : '?';
  let url = redirectUri + sep + 'error=' + encodeURIComponent(errorEnum);
  if (description) url += '&error_description=' + encodeURIComponent(description);
  if (state) url += '&state=' + encodeURIComponent(state);
  url += '&iss=' + encodeURIComponent(issuer);
  res.statusCode = 302;
  res.setHeader('Location', url);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

// `mapError` is re-exported so M3/M4 grant handlers can route Pryv
// `error.id` to RFC 6749 enums consistently with this layer.
export { mapError };
