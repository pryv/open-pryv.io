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
 * cores cannot serve the login/accept step. The code-grant `/token` is bound
 * to the same core: the code row carries the access id and the issuing
 * `coreId`, never the token, so only the core that ran /accept can read the
 * access back, and another core answers `invalid_grant`. A true shared-LB
 * issuer would require username-aware routing at the LB, which is a
 * deployment concern, not a server change.
 */

import type { Request, Response } from 'express';
import { PSEUDONYM_SUBJECTS_AVAILABLE } from './scopeGrammar.ts';

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
  /** OpenID Connect is on (a signing key is configured): the JWK Set is published. */
  oidc?: boolean;
  /** Claims an id_token may carry beyond the core's (the extension's `claimsSupported`). */
  claimsSupported?: string[];
};

/** The id_token claims the core itself sets. */
export const CORE_ID_TOKEN_CLAIMS = ['iss', 'sub', 'aud', 'azp', 'exp', 'iat', 'auth_time', 'nonce'];

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
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'private_key_jwt', 'none'],
    // RFC 7523 §2.2 — JWS algorithms accepted for a `private_key_jwt`
    // client-authentication assertion. ES256 only (no alg confusion).
    token_endpoint_auth_signing_alg_values_supported: ['ES256'],
    code_challenge_methods_supported: ['S256'],
    // Per RFC 9700 §2.1: no plain, no implicit, no RoPC.
    // PKCE is mandatory for all clients.
    // RFC 9207 — iss parameter in authorization response.
    authorization_response_iss_parameter_supported: true,
    // RFC 9449 §5.1 — DPoP proof signing algorithms the server accepts.
    // A client that presents a DPoP proof on /oauth2/token receives a
    // sender-constrained (DPoP) token; omitting it yields a Bearer token.
    dpop_signing_alg_values_supported: ['ES256'],
    ...(cfg.oidc === true ? { jwks_uri: issuer + '/oauth2/jwks' } : {}),
    // Cache headers + non-standard `apiEndpoint` extension are
    // implementation details, not advertised in the discovery doc.
  };
}

/**
 * The OpenID Connect discovery document (`/.well-known/openid-configuration`):
 * the RFC 8414 document plus the OpenID Connect members. Subject types:
 * `public` (the user's stable internal id), and `pairwise` (an alias per
 * grant) only once this core serves pseudonymous subjects (the same switch
 * the /oauth2/authorize refusal reads).
 */
export function buildOpenIdConfiguration (cfg: DiscoveryConfig): Record<string, unknown> {
  return {
    ...buildDiscoveryDocument({ ...cfg, oidc: true }),
    subject_types_supported: ['public', ...(PSEUDONYM_SUBJECTS_AVAILABLE ? ['pairwise'] : [])],
    id_token_signing_alg_values_supported: ['RS256'],
    claims_supported: [...new Set([...CORE_ID_TOKEN_CLAIMS, ...(cfg.claimsSupported ?? [])])],
  };
}

/**
 * Express-style handler serving a JSON document built per request (the
 * builder is cheap and reads live configuration); a null document is a 404
 * (e.g. the OpenID Connect documents while no signing key is configured).
 * Same headers as the discovery document.
 */
export function handleJsonDocument (build: () => Record<string, unknown> | null) {
  return function (req: Request, res: Response): void {
    const doc = build();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (doc == null) {
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found', error_description: 'not available on this server' }));
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.statusCode = 200;
    res.end(JSON.stringify(doc));
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
