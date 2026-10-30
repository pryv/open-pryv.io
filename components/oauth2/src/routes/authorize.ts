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
 * Cross-core routing (multi-core deployments): /oauth2/authorize runs on
 * whichever core received the request (the client lookup reads the
 * cluster-wide PlatformDB). The issuer is per core, and nothing is
 * forwarded between cores: the code and refresh exchanges at
 * /oauth2/token must reach the core that issued them (another core
 * answers `invalid_grant`, see grants/authorization_code.ts).
 */

import { createRequire } from 'node:module';

import type { Request, Response } from 'express';
import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { ParsedScope } from '../scopeRegistry.ts';
const require = createRequire(import.meta.url);

// Kept on the require shim: converting these to typed ESM imports surfaces
// pre-existing cross-module type gaps (the cmc ParsedScope extension, nullable
// offer.capabilityId) that belong to the TS-migration track, not here.
const { getClient, validateRedirectUri, isRegistryClient } = require('../clientRegistry.ts');
const { resolveRequestedScope } = require('../scopeGrammar.ts');
const { mapError } = require('../errorMap.ts');
const { parseScopes, ScopeParseError } = require('../scopeRegistry.ts');
const { signState } = require('../signedState.ts');
const { issuerFromConfig } = require('../issuer.ts');
const { audit } = require('../audit.ts');
const { resolveOffer, OfferResolveError } = require('../offerResolver.ts');

/** An S256 code_challenge: base64url (no padding) of a SHA-256 digest. */
const PKCE_S256_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Shape of the inputs the host app injects. */
export type AuthorizeDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB; // raw PlatformDB
  /** Test seam for the cmc offer read (defaults to global fetch). */
  offerFetch?: typeof fetch;
};

/** Express-style handler factory. */
export function handleAuthorize (deps: AuthorizeDeps) {
  return async function authorize (req: Request, res: Response): Promise<void> {
    const issuer = issuerFromConfig(deps.config);
    if (!issuer) return sendServerError(res, 'service:api not configured');
    const adminKey = String(deps.config.get('auth:adminAccessKey') ?? '');
    if (!adminKey) return sendServerError(res, 'auth:adminAccessKey not configured');
    const consentUrl = String(deps.config.get('oauth:consentUrl') ?? '').replace(/\/$/, '');
    if (!consentUrl) return sendServerError(res, 'oauth:consentUrl not configured');

    // GET reads the query, POST a form body (OpenID Connect Core §3.1.2.1).
    // A parameter given twice (or a structured value) is refused on both,
    // before anything else (RFC 6749 §3.1).
    if (req.method === 'POST') {
      const contentType = String(req.headers?.['content-type'] ?? '');
      if (!/^application\/x-www-form-urlencoded\b/i.test(contentType)) {
        return sendHtmlError(res, 400, 'The authorization request must be form-encoded.');
      }
    }
    const raw = ((req.method === 'POST' ? req.body : req.query) ?? {}) as Record<string, unknown>;
    const repeated = Object.keys(raw).filter((k) => raw[k] != null && typeof raw[k] !== 'string');
    if (repeated.length > 0) {
      return sendHtmlError(res, 400, 'Parameter(s) given more than once: ' + repeated.join(', '));
    }
    const q = raw as Record<string, string | undefined>;

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
        'redirect_uri does not match any registered URI for this client.');
    }

    // From here on, errors redirect the user-agent back to the
    // VALIDATED redirect_uri with an RFC 6749 error enum + state + iss.
    const state = isNonEmptyString(q.state) ? String(q.state) : '';
    const redirectError = (errorEnum: string, description?: string): void => {
      sendErrorRedirect(res, String(q.redirect_uri), errorEnum, state, issuer, description);
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
    // An S256 challenge is the base64url SHA-256 of the verifier, unpadded:
    // exactly 43 characters (RFC 7636 §4.2).
    if (!PKCE_S256_CHALLENGE_RE.test(String(q.code_challenge))) {
      return redirectError('invalid_request', 'PKCE code_challenge must be 43 base64url characters (S256)');
    }
    if (!isNonEmptyString(q.state)) {
      return redirectError('invalid_request', 'state parameter is required (CSRF defense)');
    }
    if (client.status === 'suspended') {
      return redirectError('access_denied', 'this client is suspended');
    }

    // Resource indicator: a client registered with a list of audiences must
    // name one of them (trailing slash ignored); no code otherwise.
    let audience: string | undefined;
    if (Array.isArray(client.allowedAudiences) && client.allowedAudiences.length > 0) {
      if (!isNonEmptyString(q.aud)) {
        return redirectError('invalid_request', 'aud is required for this client');
      }
      const wanted = trimSlash(String(q.aud));
      audience = client.allowedAudiences.find((a: string) => trimSlash(a) === wanted);
      if (audience == null) {
        return redirectError('invalid_request', 'aud is not a resource this client may access');
      }
    }

    if (isRegistryClient(client)) {
      return authorizeRegistryClient();
    }

    // Scope validation — must parse cleanly through the registered
    // namespace parsers, and the resulting tokens must be a subset of
    // the client's registered scope set.
    const scopeStr = isNonEmptyString(q.scope) ? String(q.scope) : '';
    let parsedScopes;
    try {
      parsedScopes = parseScopes(scopeStr);
    } catch (e: unknown) {
      if (e instanceof ScopeParseError) {
        return redirectError('invalid_scope', (e as Error).message);
      }
      throw e;
    }
    const requestedScopeTokens = parsedScopes.map((s: ParsedScope) => s.raw);
    const registered = new Set<string>(client.scope ?? []);
    const unrecognised = requestedScopeTokens.filter((t: string) => !registered.has(t));
    if (unrecognised.length > 0) {
      return redirectError('invalid_scope',
        `client is not registered for scope(s): ${unrecognised.join(' ')}`);
    }

    // Every authorization-code grant goes through an explicit granular
    // permission set: scope MUST be exactly one cmc:<offer-name>
    // reference (no coarse wildcard scopes exist; a request mixing or
    // multiplying refs has no coherent grant semantics).
    const cmcScopes = parsedScopes.filter((s: ParsedScope) => s.namespace === 'cmc');
    if (cmcScopes.length !== 1 || parsedScopes.length !== 1) {
      return redirectError('invalid_scope',
        'scope must be exactly one cmc:<offer-name> consent-offer reference');
    }

    // Resolve the referenced offer (registration guarantees the map
    // entry exists) — its granular permissions + consent texts travel
    // to the consent UI inside the signed state, so accept-time
    // minting can only use what the server itself resolved here.
    let offer = null;
    {
      const offerName = cmcScopes[0].offerName;
      const offerRef = client.cmcOffers?.[offerName];
      if (offerRef == null) {
        return redirectError('invalid_scope',
          `client has no registered offer named "${offerName}"`);
      }
      try {
        offer = await resolveOffer({
          offerName,
          capabilityUrl: offerRef.capabilityUrl,
          deps: { fetch: deps.offerFetch },
        });
      } catch (e: unknown) {
        if (e instanceof OfferResolveError) {
          return redirectError('invalid_scope', (e as Error).message);
        }
        throw e;
      }
    }

    // All good — emit consent.shown audit, sign the state, redirect to
    // the consent UI.
    await audit('oauth.consent.shown', {
      clientId: client.clientId,
      requestedScope: requestedScopeTokens,
      ...(offer != null ? { offerName: offer.offerName, offerCapabilityId: offer.capabilityId } : {}),
    });

    const signed = signState(adminKey, {
      clientId: client.clientId,
      redirectUri: q.redirect_uri,
      state,
      codeChallenge: q.code_challenge,
      codeChallengeMethod: 'S256',
      scope: requestedScopeTokens,
      userIdHint: isNonEmptyString(q.login_hint) ? String(q.login_hint) : undefined,
      ...(offer != null ? { offer } : {}),
      ...(audience != null ? { audience } : {}),
    });
    return redirectToConsent(signed);

    // Registry client: the whole scope string goes to the extension's
    // grammar; the synthesised offer is NOT put in the state (its size is
    // unbounded), only its digest: /accept and the consent UI re-derive it.
    async function authorizeRegistryClient (): Promise<void> {
      const resolved = resolveRequestedScope(client, isNonEmptyString(q.scope) ? String(q.scope) : '');
      if (!resolved.ok) return redirectError('invalid_scope', resolved.description);

      await audit('oauth.consent.shown', {
        clientId: client.clientId,
        requestedScope: resolved.requested,
        offerKind: 'synthesised',
      });
      const signed = signState(adminKey, {
        clientId: client.clientId,
        redirectUri: String(q.redirect_uri),
        state,
        codeChallenge: String(q.code_challenge),
        codeChallengeMethod: 'S256',
        scope: resolved.requested,
        userIdHint: isNonEmptyString(q.login_hint) ? String(q.login_hint) : undefined,
        offerRef: { kind: 'synthesised', digest: resolved.digest },
        ...(audience != null ? { audience } : {}),
      });
      return redirectToConsent(signed);
    }

    // Pass the API endpoint to the consent UI as `pryvApi` so the UI
    // can target /oauth2/authorize/accept + /refuse without needing
    // its own config (operators can serve the consent UI from anywhere).
    function redirectToConsent (signed: string): void {
      const sep = consentUrl.indexOf('?') >= 0 ? '&' : '?';
      const consentRedirect = consentUrl + sep +
        'state=' + encodeURIComponent(signed) +
        '&pryvApi=' + encodeURIComponent(issuer);
      res.statusCode = 302;
      res.setHeader('Location', consentRedirect);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.end();
    }
  };
}

function trimSlash (s: string): string {
  return s.replace(/\/+$/, '');
}

function isNonEmptyString (v: unknown): boolean {
  return typeof v === 'string' && v.length > 0;
}

function escapeHtml (s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sendHtmlError (res: Response, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // A page of the authorization server is never framed (clickjacking). The
  // page loads nothing, so `default-src 'none'` costs nothing and neutralises
  // any markup that would get in; its URL carries the client_id and never
  // leaves as a referrer.
  // X-Content-Type-Options comes from the API's express app, like every answer.
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end('<!DOCTYPE html><html><head><title>OAuth error</title></head>' +
    `<body><h1>Authorization failed</h1><p>${escapeHtml(message)}</p></body></html>`);
}

function sendServerError (res: Response, reason: string): void {
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: 'server_error', error_description: reason }));
}

function sendErrorRedirect (
  res: Response,
  redirectUri: string,
  errorEnum: string,
  state: string,
  issuer: string,
  description?: string
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
