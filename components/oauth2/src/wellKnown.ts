/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — RFC 8414 `.well-known/oauth-authorization-server` handler.
 *
 * `issuer` + endpoints derive from the operator's `oauth.issuer` /
 * topology config; operators MUST keep `oauth.*` in sync across cores.
 *
 * Multi-core routing contract: `/oauth2/authorize`, `/accept`, and the
 * code-grant `/token` all derive from this `issuer`. `/accept` (mints the
 * access) and the refresh grant (re-mints) both touch the user's HOME-CORE
 * per-user storage and cannot run cross-core, and there is no username-based
 * routing on `/oauth2/*`. So for a given user's flow the `issuer` MUST
 * resolve to that user's home core — a bare load balancer spraying across
 * cores cannot serve the login/accept step. The code-grant `/token` is the
 * one core-agnostic step (it returns the already-minted access from the
 * cluster-wide code row), so its storage key is deliberately NOT
 * core-namespaced (see storage.ts) — a stray LB-routed code exchange still
 * resolves. A true shared-LB issuer would require username-aware routing at
 * the LB, which is a deployment concern, not a server change.
 */

import type { Request, Response } from 'express';

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
    // RFC 9449 §5.1 — DPoP proof signing algorithms the server accepts.
    // A client that presents a DPoP proof on /oauth2/token receives a
    // sender-constrained (DPoP) token; omitting it yields a Bearer token.
    dpop_signing_alg_values_supported: ['ES256'],
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
  return function (req: Request, res: Response): void {
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
