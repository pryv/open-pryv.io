/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `GET /auth/sso/:provider/callback` — finish a third-party sign-in.
 *
 * Reads the state cookie and issues a clear before using it (best-effort with
 * a cooperating browser; genuine replay defence is the IdP's one-time `code` +
 * the cookie's 10-min TTL), verifies it, and runs openid-client's
 * `authorizationCodeGrant` — which validates the id_token `iss`, `aud`, `exp`,
 * the `nonce`, the returned `state`, and completes the PKCE code exchange
 * server-side. (The id_token JWS SIGNATURE is NOT checked in the code flow: the
 * token arrives over the direct TLS + client-secret channel; see providers.ts
 * for the posture + the defense-in-depth option.) On success it extracts
 * `{ sub, email, email_verified }` and hands them to the injected `onIdentity`
 * seam (P2: a placeholder; later: account resolution + session mint). Every
 * failure mode collapses to ONE coarse error redirect — no oracle.
 *
 * When the start carried an `ssoReturn`, it is appended unchanged to the
 * fragment of whatever location we redirect to, on every outcome. It is read
 * from the cookie ONLY after that cookie's signature, TTL and provider binding
 * have verified, so a third party cannot inject a return context into an
 * in-flight sign-in; the callback never reads it from its own query.
 */

import * as oidc from 'openid-client';
import type { Registry } from '../providers.ts';
import { verifyStateCookie, STATE_COOKIE_NAME, STATE_COOKIE_PATH } from '../stateCookie.ts';

/** The proven identity handed to the completion seam. */
export type IdentityClaims = {
  provider: string;
  sub: string;
  email: string | null;
  emailVerified: boolean;
};

export type CallbackDeps = {
  registry: Registry;
  adminKey: string;
  callbackUrl: (provider: string) => string;
  landingPageURL: string;
  /** Completion seam: resolve the account + mint a session, return where to go. */
  onIdentity: (claims: IdentityClaims) => Promise<{ location: string }>;
  logger?: { warn: (msg: string) => void };
};

type CallbackReq = { params: { provider?: string }; headers?: { cookie?: string }; url?: string; originalUrl?: string };
type CallbackRes = {
  redirect: (url: string) => void;
  clearCookie: (name: string, options: object) => void;
  status: (code: number) => CallbackRes;
  end: (body?: string) => void;
};

/** Minimal, dependency-free cookie-header parser (cookie-parser is not mounted
 *  on the root `/auth/sso/*` routes). Returns the first value for each name. */
function parseCookies (header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '' || Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Append the verified return state to a redirect target's FRAGMENT. Encoded as
 * one value, so it can neither introduce a second key nor a second `#` nor
 * otherwise alter the URL the core decided to redirect to.
 */
function withReturn (location: string, returnState?: string): string {
  if (returnState == null || returnState === '') return location;
  const separator = location.includes('#') ? '&' : '#';
  return location + separator + 'ssoReturn=' + encodeURIComponent(returnState);
}

export function handleCallback (deps: CallbackDeps) {
  return async function callback (req: CallbackReq, res: CallbackRes): Promise<void> {
    const provider = req.params.provider ?? '';

    // One uniform coarse failure. The code + the FRAGMENT delivery match the
    // success/refusal path (onIdentity): the auth app reads `location.hash`
    // only, and nothing SSO-related must reach the landing host's access log or
    // Referer. Using the query here would be silently swallowed client-side and
    // would leak the marker to logs.
    // `returnState` is passed only by callers that run AFTER the cookie has
    // verified: an unverified value is never reflected back to the browser.
    const redirectFail = (returnState?: string): void => {
      res.clearCookie(STATE_COOKIE_NAME, { path: STATE_COOKIE_PATH });
      res.redirect(withReturn(deps.landingPageURL + '#ssoError=sso-failed', returnState));
    };

    // Stays undefined until the cookie has verified, so the catch below reflects
    // it only for failures that happened after that point.
    let returnState: string | undefined;

    try {
      const configuration = await deps.registry.getConfiguration(provider);
      if (configuration == null) {
        res.status(404).end('Not found');
        return;
      }

      // One-shot: read the cookie, then clear it before using it.
      const raw = parseCookies(req.headers?.cookie)[STATE_COOKIE_NAME];
      res.clearCookie(STATE_COOKIE_NAME, { path: STATE_COOKIE_PATH });
      if (raw == null) return redirectFail();

      const verified = verifyStateCookie(deps.adminKey, raw);
      if (!verified.ok) return redirectFail();
      // Anti-mixup: the cookie was minted for THIS provider.
      if (verified.payload.provider !== provider) return redirectFail();
      // Signature, TTL and provider binding all hold: the return state is now
      // trusted enough to be handed back (still never interpreted).
      returnState = verified.payload.returnState;

      // Reconstruct the full callback URL (openid-client reads code + state
      // from its query). Take the path+query the IdP redirected us to.
      const requestTarget = req.originalUrl ?? req.url ?? '';
      const queryIndex = requestTarget.indexOf('?');
      const currentUrl = new URL(deps.callbackUrl(provider));
      currentUrl.search = queryIndex >= 0 ? requestTarget.slice(queryIndex) : '';

      const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
        expectedState: verified.payload.state,
        expectedNonce: verified.payload.nonce,
        pkceCodeVerifier: verified.payload.pkceVerifier
      });

      const claims = tokens.claims();
      if (claims == null || typeof claims.sub !== 'string') return redirectFail(returnState);
      const email = typeof claims.email === 'string' ? claims.email : null;
      const emailVerified = claims.email_verified === true;

      const result = await deps.onIdentity({ provider, sub: claims.sub, email, emailVerified });
      res.redirect(withReturn(result.location, returnState));
    } catch (err) {
      // Log the error CLASS only — an openid-client error message can embed
      // attacker-supplied callback query params (error_description), which
      // could inject newlines / forge log lines.
      deps.logger?.warn(`[sso] callback failed for provider "${provider}": ${err instanceof Error ? err.name : 'error'}`);
      return redirectFail(returnState);
    }
  };
}
