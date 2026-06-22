/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — Express route mount barrel.
 *
 * Called by `components/api-server` at boot:
 *   import * as oauth2 from 'oauth2';
 *   oauth2.registerRoutes(app, { platform, config });
 *
 * M1 mounts ONLY `.well-known/oauth-authorization-server`. M2 adds
 * `/oauth2/authorize` + `/oauth2/authorize/accept` + `/oauth2/token`;
 * M3 + M4 extend the token endpoint with `refresh_token` +
 * `client_credentials` grants.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { handleWellKnown } = require('./wellKnown.ts');
const { listNamespaces } = require('./scopeRegistry.ts');

/**
 * Shape of the deps the host app injects. `config` is the boiler-
 * style config; `oauth.*` and `service.api` must be populated.
 * PlatformDB is fetched lazily via `require('platform').getPlatform()`
 * inside individual route handlers (M2+) — same pattern as
 * `/reg/access` — so M1's mount path doesn't need it.
 */
export type Deps = {
  config: { get (key: string): unknown };
};

/**
 * Mount OAuth2 routes on an Express app. Idempotent across calls
 * (re-mount during hot reload is safe).
 */
export function registerRoutes (app: { get?: Function }, deps: Deps): void {
  if (typeof app?.get !== 'function') {
    throw new Error('registerRoutes: app must be an Express-like instance');
  }

  const issuer = String(deps.config.get('service.api') ?? '').replace(/\/$/, '');
  if (!issuer) {
    throw new Error('registerRoutes: service.api must be configured for the discovery doc');
  }

  // Scopes-supported derived from the live registry — Plan E.M1 ships
  // `pryv:read pryv:write pryv:manage`; SMART plugin (follow-up plan)
  // will add `smart:*` automatically once it registers.
  const scopesSupported = buildScopesSupported();

  const grantTypesSupported = (deps.config.get('oauth.grantTypesSupported') as string[] | undefined)
    ?? ['authorization_code'];

  app.get!(
    '/.well-known/oauth-authorization-server',
    handleWellKnown({ issuer, scopesSupported, grantTypesSupported }),
  );

  // M2 will mount here:
  //   app.get('/oauth2/authorize', handleAuthorize(deps));
  //   app.post('/oauth2/authorize/accept', handleAccept(deps));
  //   app.post('/oauth2/token', corsMiddleware, handleToken(deps));
  //   app.options('/oauth2/token', corsPreflight);
}

/**
 * Convert the live scope-parser registry into a `scopes_supported`
 * advertisement. Only the `pryv:` namespace ships a closed enum
 * (`read`/`write`/`manage`); other namespaces (SMART, etc.) advertise
 * their namespace + a wildcard hint per RFC 8414 conventions.
 */
function buildScopesSupported (): string[] {
  const namespaces = listNamespaces();
  const result: string[] = [];
  if (namespaces.includes('pryv')) {
    result.push('pryv:read', 'pryv:write', 'pryv:manage');
  }
  for (const ns of namespaces) {
    if (ns === 'pryv') continue;
    result.push(`${ns}:*`); // open-ended; the parser owns the actual grammar
  }
  return result;
}
