/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `GET /auth/sso/:provider/start` — begin a third-party sign-in.
 *
 * Mints `state` + `nonce` + a PKCE verifier, stashes them (plus the provider)
 * in the signed one-shot state cookie, and 302s the browser to the IdP's
 * authorization endpoint requesting the minimum scope (`openid email`). An
 * unknown / unconfigured provider is a flat 404 with no enumeration detail.
 *
 * An optional `ssoReturn` query parameter lets the auth app remember where the
 * user came from. It is shape-checked (length + alphabet) and stored in the
 * state cookie verbatim: it is never parsed here, never sent to the IdP, and
 * comes back on the landing fragment only once the cookie has verified. A value
 * that is too long or out of alphabet is refused with 400 rather than dropped,
 * so a broken link fails visibly instead of silently losing the context.
 */

import * as oidc from 'openid-client';
import type { Registry } from '../providers.ts';
import { signStateCookie, STATE_COOKIE_NAME, cookieOptions, isValidReturnState } from '../stateCookie.ts';

export type StartDeps = {
  registry: Registry;
  adminKey: string;
  /** Absolute redirect_uri for a provider — registered verbatim at the IdP. */
  callbackUrl: (provider: string) => string;
  logger?: { warn: (msg: string) => void };
};

type StartReq = { params: { provider?: string }; query?: Record<string, unknown> };
type StartRes = {
  cookie: (name: string, value: string, options: object) => void;
  redirect: (url: string) => void;
  status: (code: number) => StartRes;
  end: (body?: string) => void;
};

export function handleStart (deps: StartDeps) {
  return async function start (req: StartReq, res: StartRes): Promise<void> {
    const provider = req.params.provider ?? '';
    try {
      const configuration = await deps.registry.getConfiguration(provider);
      if (configuration == null) {
        res.status(404).end('Not found');
        return;
      }

      // A duplicated `ssoReturn` arrives as an array and an extended query
      // parser can yield an object: both fail the string check below.
      const rawReturn = req.query?.ssoReturn;
      let returnState: string | undefined;
      if (rawReturn !== undefined) {
        if (!isValidReturnState(rawReturn)) {
          res.status(400).end('Sign-in could not be started');
          return;
        }
        // An empty value carries nothing; treat it as absent so the cookie
        // payload stays exactly what a start without the parameter produces.
        if (rawReturn !== '') returnState = rawReturn;
      }

      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const pkceVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(pkceVerifier);

      // The return state is deliberately absent here: the IdP never sees it.
      const authUrl = oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: deps.callbackUrl(provider),
        scope: 'openid email',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });

      // `returnState` is omitted when absent, so a start without it signs a
      // payload byte-identical to the one this route produced before.
      const cookie = signStateCookie(deps.adminKey, returnState === undefined
        ? { provider, state, nonce, pkceVerifier }
        : { provider, state, nonce, pkceVerifier, returnState });
      res.cookie(STATE_COOKIE_NAME, cookie, cookieOptions());
      res.redirect(authUrl.href);
    } catch (err) {
      // Log the error CLASS only (message can carry attacker-influenced text).
      deps.logger?.warn(`[sso] start failed for provider "${provider}": ${err instanceof Error ? err.name : 'error'}`);
      res.status(500).end('Sign-in could not be started');
    }
  };
}
