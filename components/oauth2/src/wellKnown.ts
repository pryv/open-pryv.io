/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — RFC 8414 `.well-known/oauth-authorization-server` handler.
 *
 * The discovery document is per-deployment, NOT per-core. All cores
 * in a deployment advertise the same `issuer` + endpoints (LB-facing
 * URL), so the operator MUST keep `oauth.*` config in sync across
 * cores. See INTERNALS.md — "Why iss is per-deployment".
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Inputs the discovery doc needs from the surrounding config. The
 * caller (routes.ts) supplies these; the doc is otherwise static
 * for a given deployment.
 */
export type DiscoveryConfig = {
  /** The LB-facing service URL — e.g. `https://reg.pryv.me`. */
  issuer: string;
  /** Supported scope namespaces (rendered as `cmc:*` etc.). */
  scopesSupported: string[];
  /** Grant types currently wired. Defaults conservatively. */
  grantTypesSupported?: string[];
};

/**
 * Build the RFC 8414 doc as a plain JSON-serializable object.
 */
export function buildDiscoveryDocument (cfg: DiscoveryConfig): Record<string, unknown> {
  const issuer = trimTrailingSlash(cfg.issuer);
  return {
    issuer,
    authorization_endpoint: issuer + '/oauth2/authorize',
    token_endpoint: issuer + '/oauth2/token',
    scopes_supported: cfg.scopesSupported,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: cfg.grantTypesSupported ?? ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
    code_challenge_methods_supported: ['S256'],
    // Per RFC 9700 §2.1: no plain, no implicit, no RoPC.
    // PKCE is mandatory for all clients.
    // RFC 9207 — iss parameter in authorization response.
    authorization_response_iss_parameter_supported: true,
    // Cache headers + non-standard `apiEndpoint` extension are
    // implementation details, not advertised in the discovery doc.
  };
}

/**
 * Express-style handler: `GET /.well-known/oauth-authorization-server`.
 * Per-deployment static doc; emits `application/json` with a short
 * cache (5 minutes — discovery doc can change on config update; not
 * frequent but not infinite either).
 */
export function handleWellKnown (cfg: DiscoveryConfig) {
  const doc = buildDiscoveryDocument(cfg);
  const body = JSON.stringify(doc);
  return function (req: unknown, res: any): void {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    // CORS — allow all origins (PKCE
    // is the defence). Same policy as Google/Auth0/Okta.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.statusCode = 200;
    res.end(body);
  };
}

function trimTrailingSlash (url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
