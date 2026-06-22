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
 * If `service:api` is not configured, the OAuth surface is skipped
 * with a single warn log — the host app boots normally. This lets
 * deployments that do not yet enable OAuth (and the test matrix)
 * load this module without any extra config wiring.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { handleWellKnown } = require('./wellKnown.ts');
const { listNamespaces } = require('./scopeRegistry.ts');
const { handleAuthorize } = require('./routes/authorize.ts');
const { handleAccept } = require('./routes/accept.ts');
const { handleToken } = require('./routes/token.ts');
const { corsMiddleware } = require('./cors.ts');

export type Deps = {
  config: { get (key: string): unknown };
  /**
   * Raw PlatformDB instance (`require('storages').platformDB`). Required
   * for the public auth flow (/oauth2/authorize, /accept, /token);
   * `.well-known` works without it.
   */
  platform?: any;
  /**
   * Resolve a user's personal access token to { userId, username } or
   * null. Wired by the host app from the existing personal-token
   * validation path. Required for /oauth2/authorize/accept.
   */
  resolveUser?: (userToken: string) => Promise<{ userId: string; username: string } | null>;
  /**
   * Mint an access for the given user + client + scope. Wired by the
   * host app to the existing accesses.create path. Required for
   * /oauth2/token.
   */
  issueAccess?: (params: { userId: string; clientId: string; scope: string[]; expiresAt: number }) =>
    Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;
};

/**
 * Mount OAuth2 routes on an Express app. Idempotent across calls
 * (re-mount during hot reload is safe). Soft-degrades to a no-op
 * when `service:api` is not configured. The public auth flow routes
 * (/oauth2/authorize, /accept, /token) mount only when their required
 * deps (platform + resolveUser + issueAccess) are provided.
 */
export function registerRoutes (app: { get?: Function; post?: Function; options?: Function }, deps: Deps): void {
  if (typeof app?.get !== 'function') {
    throw new Error('registerRoutes: app must be an Express-like instance');
  }

  const issuer = String(deps.config.get('service:api') ?? '').replace(/\/$/, '');
  if (!issuer) {
    console.warn('[oauth2] service:api not configured — OAuth routes not mounted');
    return;
  }

  const scopesSupported = buildScopesSupported();

  const grantTypesSupported = (deps.config.get('oauth:grantTypesSupported') as string[] | undefined)
    ?? ['authorization_code'];

  app.get!(
    '/.well-known/oauth-authorization-server',
    handleWellKnown({ issuer, scopesSupported, grantTypesSupported }),
  );

  if (deps.platform == null) {
    console.warn('[oauth2] platform not provided — only the discovery doc is mounted');
    return;
  }
  if (typeof deps.resolveUser !== 'function' || typeof deps.issueAccess !== 'function') {
    console.warn('[oauth2] resolveUser / issueAccess not provided — /oauth2/authorize, /accept, /token not mounted');
    return;
  }

  app.get!('/oauth2/authorize',
    handleAuthorize({ config: deps.config, platform: deps.platform }));

  app.post!('/oauth2/authorize/accept',
    handleAccept({ config: deps.config, platform: deps.platform, resolveUser: deps.resolveUser }));

  if (typeof app.options === 'function') {
    app.options!('/oauth2/token', corsMiddleware);
  }
  app.post!('/oauth2/token', corsMiddleware,
    handleToken({ config: deps.config, platform: deps.platform, issueAccess: deps.issueAccess }));
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
