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
 * deployment.
 *
 * `onIdentity` runs the account-linking rule table over the real platform +
 * `:_emails:` container: a proven IdP identity is mapped to a Pryv account
 * (fail-closed), and on a match a first-login `(provider, sub)` binding is
 * persisted. A `login` outcome resolves the account but does NOT yet mint a
 * session (that is the next step) — for now it hands off to the landing page
 * with a pending marker; refusals hand off with a coarse error code.
 */

import type { AppLike } from './_types.ts';
import { getLogger } from '@pryv/boiler';
import { registerRoutes, resolveAccountForIdentity, type IdentityClaims } from 'sso';
import { getPlatform } from 'platform';
import { getUsersRepository } from 'business/src/users/index.ts';
import { buildSsoLinkDeps } from './ssoLinkDeps.ts';

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
  const landingPageURL = config.get('sso:landingPageURL');
  const adminKey = config.get('auth:adminAccessKey');

  // The linking deps are resolved lazily per sign-in (getPlatform /
  // getUsersRepository are cached singletons); SSO is a low-frequency path so
  // there is no need to hoist them at mount time.
  async function onIdentity (claims: IdentityClaims): Promise<{ location: string }> {
    const url = typeof landingPageURL === 'string' ? landingPageURL : '';
    const sep = url.includes('?') ? '&' : '?';
    const deps = buildSsoLinkDeps(await getPlatform(), await getUsersRepository(), logger);
    const outcome = await resolveAccountForIdentity(deps, claims);
    if (outcome.kind === 'login') {
      // Account resolved (+ first-login binding persisted). Session mint lands
      // in the next step; for now hand off with a pending marker. Log the
      // provider only — never the resolved username / claims.
      logger.info(`sso: identity via provider "${claims.provider}" resolved to an account (session mint pending)`);
      return { location: `${url}${sep}ssoStatus=pending` };
    }
    logger.info(`sso: sign-in refused via provider "${claims.provider}" (${outcome.code})`);
    return { location: `${url}${sep}ssoError=${encodeURIComponent(outcome.code)}` };
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
