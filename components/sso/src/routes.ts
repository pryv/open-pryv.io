/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Third-party sign-in — route mount + soft-degrade gate.
 *
 * `registerRoutes` progressively soft-degrades so the host boots unchanged:
 *   - `sso:enabled` not `true` (the default) → silent, no routes;
 *   - enabled but `sso:providers` empty → warn, no routes;
 *   - enabled + providers but the wiring deps (adminKey / callbackBaseURL /
 *     landingPageURL / onIdentity) are absent → warn, no routes.
 * Only with the full set does it mount `GET /auth/sso/:provider/{start,callback}`.
 */

import type { ConfigLike } from '@pryv/boiler';
import { createRegistry } from './providers.ts';
import { handleStart } from './routes/start.ts';
import { handleCallback, type IdentityClaims } from './routes/callback.ts';

/** Everything the component needs from the host, injected by the api-server. */
export type SsoDeps = {
  config: ConfigLike;
  /** Operator admin key — the state-cookie signing root. */
  adminKey?: string;
  /** Absolute base whose `/auth/sso/<provider>/callback` is registered at IdPs. */
  callbackBaseURL?: string;
  /** Where a finished (or failed) sign-in hands off. */
  landingPageURL?: string;
  /** Completion seam invoked with the proven identity (account resolution + mint). */
  onIdentity?: (claims: IdentityClaims) => Promise<{ location: string }>;
  logger?: { warn: (msg: string) => void };
};

/** Minimal Express surface used at mount time. */
type ExpressLike = { get?: (path: string, handler: (...args: unknown[]) => void) => void };

/** The configured provider ids — the operator's IdP allow-list (may be empty). */
function configuredProviderIds (config: ConfigLike): string[] {
  const providers = config.get('sso:providers');
  if (providers == null || typeof providers !== 'object' || Array.isArray(providers)) return [];
  return Object.keys(providers as Record<string, unknown>);
}

/**
 * Mount the SSO routes on an Express app. No-op (host boots unchanged) unless
 * `sso:enabled` is true, at least one provider is configured, AND the wiring
 * deps are present.
 */
export function registerRoutes (app: ExpressLike, deps: SsoDeps): void {
  if (typeof app?.get !== 'function') {
    throw new Error('registerRoutes: app must be an Express-like instance');
  }
  const { config } = deps;

  // Disabled is the default: mount nothing, no warning (opt-in feature).
  if (config.get('sso:enabled') !== true) return;

  const providerIds = configuredProviderIds(config);
  if (providerIds.length === 0) {
    console.warn('[sso] sso.enabled is true but no providers are configured — no SSO routes mounted');
    return;
  }

  if (deps.adminKey == null || deps.adminKey === '' ||
      deps.callbackBaseURL == null || deps.callbackBaseURL === '' ||
      deps.landingPageURL == null || deps.landingPageURL === '' ||
      typeof deps.onIdentity !== 'function') {
    console.warn('[sso] enabled with providers but wiring is incomplete ' +
      '(adminKey / callbackBaseURL / landingPageURL / onIdentity) — no SSO routes mounted');
    return;
  }

  const registry = createRegistry(config);
  const base = deps.callbackBaseURL.replace(/\/+$/, '');
  const callbackUrl = (provider: string): string => `${base}/auth/sso/${provider}/callback`;

  app.get!('/auth/sso/:provider/start',
    handleStart({ registry, adminKey: deps.adminKey, callbackUrl, logger: deps.logger }) as (...a: unknown[]) => void);

  app.get!('/auth/sso/:provider/callback',
    handleCallback({
      registry,
      adminKey: deps.adminKey,
      callbackUrl,
      landingPageURL: deps.landingPageURL,
      onIdentity: deps.onIdentity,
      logger: deps.logger
    }) as (...a: unknown[]) => void);
}
