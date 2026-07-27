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
 */

import * as oidc from 'openid-client';
import type { Registry } from '../providers.ts';
import { signStateCookie, STATE_COOKIE_NAME, cookieOptions } from '../stateCookie.ts';

export type StartDeps = {
  registry: Registry;
  adminKey: string;
  /** Absolute redirect_uri for a provider — registered verbatim at the IdP. */
  callbackUrl: (provider: string) => string;
  logger?: { warn: (msg: string) => void };
};

type StartReq = { params: { provider?: string } };
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
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const pkceVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(pkceVerifier);

      const authUrl = oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: deps.callbackUrl(provider),
        scope: 'openid email',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });

      const cookie = signStateCookie(deps.adminKey, { provider, state, nonce, pkceVerifier });
      res.cookie(STATE_COOKIE_NAME, cookie, cookieOptions());
      res.redirect(authUrl.href);
    } catch (err) {
      // Log the error CLASS only (message can carry attacker-influenced text).
      deps.logger?.warn(`[sso] start failed for provider "${provider}": ${err instanceof Error ? err.name : 'error'}`);
      res.status(500).end('Sign-in could not be started');
    }
  };
}
