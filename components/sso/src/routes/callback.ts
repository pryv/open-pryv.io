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

export function handleCallback (deps: CallbackDeps) {
  return async function callback (req: CallbackReq, res: CallbackRes): Promise<void> {
    const provider = req.params.provider ?? '';

    // One uniform coarse failure — no signal on which check tripped.
    const redirectFail = (): void => {
      res.clearCookie(STATE_COOKIE_NAME, { path: STATE_COOKIE_PATH });
      const sep = deps.landingPageURL.includes('?') ? '&' : '?';
      res.redirect(deps.landingPageURL + sep + 'ssoError=sign-in-failed');
    };

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
      if (claims == null || typeof claims.sub !== 'string') return redirectFail();
      const email = typeof claims.email === 'string' ? claims.email : null;
      const emailVerified = claims.email_verified === true;

      const result = await deps.onIdentity({ provider, sub: claims.sub, email, emailVerified });
      res.redirect(result.location);
    } catch (err) {
      // Log the error CLASS only — an openid-client error message can embed
      // attacker-supplied callback query params (error_description), which
      // could inject newlines / forge log lines.
      deps.logger?.warn(`[sso] callback failed for provider "${provider}": ${err instanceof Error ? err.name : 'error'}`);
      return redirectFail();
    }
  };
}
