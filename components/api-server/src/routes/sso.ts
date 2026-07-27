/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Third-party sign-in (OIDC relying party) — route mount + host wiring.
 *
 * Builds the deps the `sso` component needs from the app and hands them to
 * `registerRoutes`. The component soft-degrades to a no-op when SSO is disabled
 * (the default) or incompletely configured, so this mount is inert on a stock
 * deployment. The `onIdentity` seam is a placeholder here: it proves the
 * end-to-end flow but does not yet resolve an account or mint a session — that
 * lands with the account-linking + session-mint work.
 */

import type { AppLike } from './_types.ts';
import { getLogger } from '@pryv/boiler';
import { registerRoutes, type IdentityClaims } from 'sso';

type ExpressApp = { get: (...args: unknown[]) => void };

/**
 * Callback base = explicit `sso:callbackBaseURL` (boot-validated https), else
 * the core's API origin. The derived fallback is NOT boot-validated, so reject
 * a non-https origin here (a Secure state cookie would never come back over
 * http, breaking the flow obscurely) — mirrors `checkSsoConfig`.
 */
function deriveCallbackBase (config: AppLike['config']): string {
  const explicit = config.get('sso:callbackBaseURL');
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  const api = config.get('service:api');
  if (typeof api === 'string' && api !== '') {
    try {
      const origin = new URL(api).origin;
      if (new URL(origin).protocol === 'https:') return origin;
    } catch { /* fall through */ }
  }
  return '';
}

export default function mountSso (expressApp: ExpressApp, app: AppLike): void {
  const config = app.config;
  const logger = getLogger('routes:sso');

  const adminKey = config.get('auth:adminAccessKey');
  const landingPageURL = config.get('sso:landingPageURL');

  // Placeholder completion: the identity is proven (id_token validated), but
  // account resolution + session mint are not wired yet — hand off to the
  // landing page with a coarse pending marker. Log NO identifiers (provider +
  // the email-verified boolean only).
  async function onIdentity (claims: IdentityClaims): Promise<{ location: string }> {
    const url = typeof landingPageURL === 'string' ? landingPageURL : '';
    logger.info(`identity verified via provider "${claims.provider}" (emailVerified=${claims.emailVerified}); ` +
      'account linking not yet available');
    const sep = url.includes('?') ? '&' : '?';
    return { location: url + sep + 'ssoStatus=pending' };
  }

  registerRoutes(expressApp, {
    config,
    adminKey: typeof adminKey === 'string' ? adminKey : undefined,
    callbackBaseURL: deriveCallbackBase(config),
    landingPageURL: typeof landingPageURL === 'string' ? landingPageURL : undefined,
    onIdentity,
    logger
  });
}
