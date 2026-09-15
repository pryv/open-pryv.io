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
import { MethodContext } from 'business';
import timestamp from 'unix-timestamp';
import { createId as cuid } from '@paralleldrive/cuid2';

type ExpressApp = { get: (...args: unknown[]) => void };

/** What `auth.ssoLogin` / `sharedSecrets.create` put on the result bag (the
 *  subset this callback reads). MFA-active login returns `mfaToken` in place of
 *  `token`; the handoff create returns the one-time key under `sharedSecret`. */
type SsoMintResult = {
  token?: string;
  apiEndpoint?: string;
  preferredLanguage?: string;
  mfaToken?: string;
  mfaMethod?: string;
  sharedSecret?: { key?: string };
};

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

  // Promisified api dispatch: the dispatcher reads methodId off the context
  // (set here, since we bypass the setMethodId route middleware), mirroring
  // routes/oauth2.ts's apiCall.
  function callMethod (context: unknown, params: unknown): Promise<SsoMintResult> {
    return new Promise((resolve, reject) => {
      app.api.call(context, params, (err: unknown, result: unknown) => {
        if (err != null) return reject(err);
        resolve((result ?? {}) as SsoMintResult);
      });
    });
  }

  // Everything SSO hands back rides the URL FRAGMENT, never the query: the
  // fragment is not written to the landing host's access log or the Referer
  // header (D6, § 2.6).
  function toFragment (params: string): { location: string } {
    const url = typeof landingPageURL === 'string' ? landingPageURL : '';
    return { location: `${url}#${params}` };
  }

  // Dedicated SSO audit row. onIdentity dispatches via a bare api.call that
  // bypasses the method-wrapper audit (same as oauth2), so it must emit its own,
  // and fail-soft: an audit-backend hiccup must never deny a sign-in (mirrors
  // the oauth2 audit policy). `sso.login` is user-resolved (the account's trail);
  // `sso.refused` has no resolvable user (no-account / unproved / mint error) and
  // routes to syslog only. Payload carries the provider + coarse outcome, no PII.
  async function emitSsoAudit (event: 'sso.login' | 'sso.refused', payload: { userId?: string | null; provider: string; code?: string; mfa?: boolean }): Promise<void> {
    try {
      if (config.get('audit:active') !== true) return;
      // Loaded on demand, not at module scope: the audit singleton must not be
      // pulled in before storages have initialised it.
      const auditSingleton = (await import('audit')).default;
      const C = auditSingleton.CONSTANTS;
      const now = timestamp.now();
      const row = {
        id: cuid(),
        createdBy: 'system',
        modifiedBy: 'system',
        streamIds: [C.ACTION_STREAM_ID_PREFIX + event],
        time: now,
        endTime: now,
        created: now,
        modified: now,
        trashed: false,
        type: 'audit-log/sso',
        content: { action: event, source: { name: 'sso', provider: payload.provider }, record: payload }
      };
      await auditSingleton.eventForUser(payload.userId ?? undefined, row, event);
    } catch (err) {
      logger.error(`sso: audit emission failed for "${event}"`, err);
    }
  }

  // The linking deps are resolved lazily per sign-in (getPlatform /
  // getUsersRepository are cached singletons); SSO is a low-frequency path so
  // there is no need to hoist them at mount time.
  async function onIdentity (claims: IdentityClaims): Promise<{ location: string }> {
    const deps = buildSsoLinkDeps(await getPlatform(), await getUsersRepository(), logger);
    const outcome = await resolveAccountForIdentity(deps, claims);
    if (outcome.kind !== 'login') {
      // Coarse code only; detail stayed in the server log/audit. Never a username.
      logger.info(`sso: sign-in refused via provider "${claims.provider}" (${outcome.code})`);
      await emitSsoAudit('sso.refused', { provider: claims.provider, code: outcome.code });
      return toFragment(`ssoError=${encodeURIComponent(outcome.code)}`);
    }

    const username = outcome.username;
    const appId = `sso-${claims.provider}`;
    try {
      // 1) Mint the session. Server-internal, token-less context, exactly the
      //    shape auth.login runs on (init loads the user, no access). No custom
      //    auth step: the identity is already proven by the IdP, and running an
      //    operator hook here is neither needed nor wanted.
      const mintCtx = new MethodContext({ name: 'sso', ip: null }, username, null, null, {}, {}, null);
      await mintCtx.init();
      mintCtx.methodId = 'auth.ssoLogin';
      const login = await callMethod(mintCtx, { username, appId, origin: '' });

      if (login.mfaToken != null) {
        // MFA active: the real token is quarantined in the MFA session; hand off
        // only the short-lived, second-factor-gated mfaToken. AWUA completes
        // mfa.verify. Nothing long-lived is exposed.
        logger.info(`sso: identity via "${claims.provider}" resolved; MFA continuation required`);
        await emitSsoAudit('sso.login', { userId: mintCtx.user.id, provider: claims.provider, mfa: true });
        return toFragment(
          `ssoStatus=mfa&ssoUser=${encodeURIComponent(username)}` +
          `&ssoMfaToken=${encodeURIComponent(login.mfaToken)}` +
          `&ssoMfaMethod=${encodeURIComponent(login.mfaMethod ?? '')}`);
      }

      // 2) No MFA: the 14-day token must NOT appear in a URL. Stash it in a
      //    one-shot 60 s shared secret OWNED by the just-minted access (second
      //    context authenticated AS that token, the oauth2.ts precedent), and
      //    hand off only the one-time key.
      const handoffCtx = new MethodContext({ name: 'sso', ip: null }, username, login.token, null, {}, {}, null);
      await handoffCtx.init();
      await handoffCtx.retrieveExpandedAccess(app.storageLayer);
      handoffCtx.methodId = 'sharedSecrets.create';
      const handoff = await callMethod(handoffCtx, {
        title: 'sso-login-handoff',
        ttl: 60,
        onConsumed: { message: 'consumed' },
        secret: {
          token: login.token,
          apiEndpoint: login.apiEndpoint,
          preferredLanguage: login.preferredLanguage,
          provider: claims.provider
        }
      });
      const key = handoff.sharedSecret?.key;
      if (key == null) throw new Error('sharedSecrets.create returned no key');

      logger.info(`sso: identity via "${claims.provider}" resolved; session minted + one-time handoff created`);
      await emitSsoAudit('sso.login', { userId: mintCtx.user.id, provider: claims.provider, mfa: false });
      return toFragment(
        `ssoStatus=login&ssoUser=${encodeURIComponent(username)}&ssoKey=${encodeURIComponent(key)}`);
    } catch (err) {
      // No downgrade: a mint or handoff failure NEVER falls back to putting the
      // token in the URL. Uniform coarse error; detail to the server trail.
      logger.error(`sso: session mint / handoff failed for provider "${claims.provider}"`, err);
      await emitSsoAudit('sso.refused', { provider: claims.provider, code: 'sso-failed' });
      return toFragment('ssoError=sso-failed');
    }
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
