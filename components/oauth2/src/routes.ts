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
const { handleRefuse } = require('./routes/refuse.ts');
const { handleToken } = require('./routes/token.ts');
const { corsMiddleware } = require('./cors.ts');
const { issuerFromConfig } = require('./issuer.ts');

export type Deps = {
  config: { get (key: string): unknown };
  /**
   * Raw PlatformDB instance (`require('storages').platformDB`). Required
   * for the public auth flow (/oauth2/authorize, /accept, /token);
   * `.well-known` works without it.
   */
  platform?: any;
  /**
   * Resolve a user's personal access token to a session handle, or
   * null on failure. Wired by the host app from the existing
   * personal-token validation path. Required for /oauth2/authorize/accept.
   */
  resolveUser?: (params: { username: string; userToken: string })
    => Promise<{ userId: string; username: string; [key: string]: unknown } | null>;
  /**
   * Mint an app access under the resolved user. Wired by the host app
   * to api.call('accesses.create', ...) (or equivalent). Required for
   * /oauth2/authorize/accept.
   */
  createAccess?: (params: {
    session: { userId: string; username: string; [key: string]: unknown };
    clientId: string;
    scope: string[];
    expiresAt: number;
  }) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;
  /**
   * Mint a refreshed app access at /oauth2/token refresh-grant time.
   * The user is gone by then, so the host app uses the storage layer
   * directly (no user-context-auth available). The original
   * accesses.create chain ran at /accept time and already validated
   * permissions; refresh rotates credentials, never widens authority.
   * If not provided, refresh_token grant returns 501 unsupported_grant_type.
   */
  mintRefreshedAccess?: (params: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
  }) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;
  /**
   * Mint an app access at /oauth2/token client_credentials-grant time.
   * Storage-layer-direct (same shape as mintRefreshedAccess). Targets
   * the App account's own underlying user — no end-user involved. If
   * not provided alongside `resolveAccountUserId`, client_credentials
   * grant returns 501 unsupported_grant_type.
   */
  mintClientAccess?: (params: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
  }) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;
  /** Resolve the App account's username to its userId. Required for client_credentials. */
  resolveAccountUserId?: (username: string) => Promise<string | null>;
};

/**
 * Mount OAuth2 routes on an Express app. Idempotent across calls
 * (re-mount during hot reload is safe). Soft-degrades to a no-op
 * when `service:api` is not configured. The public auth flow routes
 * (/oauth2/authorize, /accept, /token) mount only when their required
 * deps (platform + resolveUser + createAccess) are provided.
 */
export function registerRoutes (app: { get?: Function; post?: Function; options?: Function }, deps: Deps): void {
  if (typeof app?.get !== 'function') {
    throw new Error('registerRoutes: app must be an Express-like instance');
  }

  const issuer = issuerFromConfig(deps.config);
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
  if (typeof deps.resolveUser !== 'function' || typeof deps.createAccess !== 'function') {
    console.warn('[oauth2] resolveUser / createAccess not provided — /oauth2/authorize, /accept, /token not mounted');
    return;
  }

  app.get!('/oauth2/authorize',
    handleAuthorize({ config: deps.config, platform: deps.platform }));

  app.post!('/oauth2/authorize/accept',
    handleAccept({
      config: deps.config,
      platform: deps.platform,
      resolveUser: deps.resolveUser,
      createAccess: deps.createAccess,
    }));

  app.post!('/oauth2/authorize/refuse',
    handleRefuse({ config: deps.config }));

  if (typeof app.options === 'function') {
    app.options!('/oauth2/token', corsMiddleware);
  }
  app.post!('/oauth2/token', corsMiddleware,
    handleToken({
      config: deps.config,
      platform: deps.platform,
      mintRefreshedAccess: deps.mintRefreshedAccess,
      mintClientAccess: deps.mintClientAccess,
      resolveAccountUserId: deps.resolveAccountUserId,
    }));
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
