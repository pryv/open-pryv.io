/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Third-party sign-in — route mount + soft-degrade gate.
 *
 * `registerRoutes` establishes the component seam and the enable gate. It
 * soft-degrades to a no-op in two cases, so the host boots unchanged:
 *   - `sso:enabled` is not `true` (the default) — silent, no routes;
 *   - enabled but `sso:providers` is empty — warns, no routes.
 *
 * The `GET /auth/sso/:provider/{start,callback}` handlers, provider registry,
 * and state-cookie machinery land in a subsequent change; this scaffold wires
 * the seam and the gate so the enable path exists and is validated end-to-end.
 */

import type { ConfigLike } from '@pryv/boiler';

/** Everything the component needs from the host, injected by the api-server. */
export type SsoDeps = { config: ConfigLike };

/** Minimal Express surface used at mount time. */
type ExpressLike = { get?: (...args: unknown[]) => void };

/** The configured provider ids — the operator's IdP allow-list (may be empty). */
function configuredProviderIds (config: ConfigLike): string[] {
  const providers = config.get('sso:providers');
  if (providers == null || typeof providers !== 'object') return [];
  return Object.keys(providers as Record<string, unknown>);
}

/**
 * Mount the SSO routes on an Express app. No-op (host boots unchanged) unless
 * `sso:enabled` is true AND at least one provider is configured.
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

  // The route handlers mount in a subsequent change. Announce the configured
  // providers so an operator enabling the feature early sees it took effect.
  console.warn(`[sso] ${providerIds.length} provider(s) configured (${providerIds.join(', ')}); ` +
    'route handlers are not yet available in this build');
}
