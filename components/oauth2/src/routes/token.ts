/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `POST /oauth2/token` handler.
 *
 * Dispatches by `grant_type` to a grant-specific handler. CORS is
 * applied by the route mount (corsMiddleware); the body is expected
 * pre-parsed as `application/x-www-form-urlencoded` (api-server's
 * existing body parser handles both that and `application/json`).
 *
 * Wired grants: authorization_code, refresh_token, client_credentials.
 * Each grant handler returns either {ok:true, body} or {ok:false,
 * status, error, description?}; the dispatcher translates to HTTP.
 */

import type { Request, Response } from 'express';
import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import { handleAuthorizationCode } from '../grants/authorization_code.ts';
import { handleRefreshToken } from '../grants/refresh_token.ts';
import { handleClientCredentials } from '../grants/client_credentials.ts';
import { verifyDPoPProof, DPoPProofError } from '../dpop.ts';
import { externalRequestUri } from '../externalUri.ts';
import { markDPoPJtiUsed, getDpopKeyRevokedAt, recordDpopKeySeen } from '../storage.ts';
import { logServerError } from '../serverLog.ts';

export type TokenDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  /**
   * Required for DPoP-bound authorization_code exchanges: write the
   * key-thumbprint binding onto the access that was pre-minted at
   * /authorize/accept (the proof only appears here, at /token).
   * Storage-direct — wired in the api-server layer.
   */
  bindAccessDpop?: (params: {
    userId: string; username: string; accessId: string; jkt: string;
  }) => Promise<void>;
  /** Required when grant_type=refresh_token is dispatched. */
  mintRefreshedAccess?: (params: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
  }) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;
  /** Required when grant_type=client_credentials is dispatched. */
  mintClientAccess?: (params: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
  }) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;
  /** Required when grant_type=client_credentials is dispatched. */
  resolveAccountUserId?: (username: string) => Promise<string | null>;
  /** Optional: collapse a refresh chain on detected reuse (refresh_token grant). */
  revokeChain?: (params: {
    userId: string; username: string; clientId: string; dataGrantAccessId?: string;
  }) => Promise<void>;
};

/**
 * Decode RFC 6749 §2.3.1 Basic credentials from an Authorization
 * header. Returns null if absent or malformed. The values are URL-
 * decoded per spec (the header carries percent-encoded credentials).
 */
function decodeBasicAuth (headerValue: unknown): { client_id: string; client_secret: string } | null {
  if (typeof headerValue !== 'string') return null;
  // RFC 7617 §2: the `Basic` auth-scheme name is case-INSENSITIVE (`basic`,
  // `BASIC`, … are all valid). The base64 credentials stay strict.
  const m = headerValue.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (m == null) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx <= 0) return null;
  try {
    return {
      client_id: decodeURIComponent(decoded.slice(0, idx)),
      client_secret: decodeURIComponent(decoded.slice(idx + 1)),
    };
  } catch {
    return null;
  }
}

export function handleToken (deps: TokenDeps) {
  return async function token (req: Request, res: Response): Promise<void> {
    const body = req.body ?? {};
    const grantType = typeof body.grant_type === 'string' ? body.grant_type : '';
    const basic = decodeBasicAuth(req.headers?.authorization);

    let outcome;
    // DPoP (RFC 9449 §5): a proof on the token request opts this
    // issuance into key binding. Verified BEFORE any grant runs, so a
    // bad proof burns nothing (no code/refresh consumed). The proof
    // covers this endpoint (no ath — no access token exists yet) and
    // its jti is burned atomically: of two concurrent identical proofs
    // exactly one proceeds.
    let dpopJkt: string | null = null;
    const dpopHeader = req.headers?.dpop;
    if (dpopHeader != null) {
      const clockSkewSeconds = Number(deps.config.get('oauth:dpop:clockSkewSeconds') ?? 120);
      try {
        const verified = await verifyDPoPProof(
          Array.isArray(dpopHeader) ? null : dpopHeader,
          { htm: 'POST', htu: externalRequestUri(req), clockSkewSeconds },
        );
        // Refuse issuance for an operator-revoked key BEFORE burning the jti or
        // running any grant: a revoked key must neither mint (authorization_code)
        // nor rotate (refresh_token) tokens. Enforcement at the resource server
        // (MethodContext.checkDpopKeyNotRevoked) kills born-dead tokens anyway —
        // this just prevents minting them and dying the chain promptly. Direct
        // (uncached) read: the token path is low-frequency, so no TTL lag.
        if (await getDpopKeyRevokedAt(deps.platform, verified.jkt) != null) {
          throw new DPoPProofError('key revoked');
        }
        const fresh = await markDPoPJtiUsed(
          deps.platform, verified.jkt, verified.jti, Date.now() + 2 * clockSkewSeconds * 1000,
        );
        if (!fresh) throw new DPoPProofError('jti replayed');
        dpopJkt = verified.jkt;
      } catch (err: unknown) {
        // Uniform response for every proof defect — reasons stay server-side.
        if (err instanceof DPoPProofError) {
          outcome = { ok: false as const, status: 400, error: 'invalid_dpop_proof', description: 'DPoP proof verification failed' };
        } else {
          outcome = { ok: false as const, status: 500, error: 'server_error', description: 'DPoP proof processing failed' };
        }
      }
    }

    if (outcome != null) {
      // fall through to the response section with the DPoP failure
    } else if (grantType === 'authorization_code') {
      if (dpopJkt != null && typeof deps.bindAccessDpop !== 'function') {
        // Advertised-but-not-wired server misconfiguration (see the
        // mint-dep guards below) — refuse BEFORE the grant consumes the
        // code, so the client can retry without re-authorizing.
        outcome = { ok: false, status: 500, error: 'server_error', description: 'DPoP binding is not wired on this deployment' };
      } else {
        outcome = await handleAuthorizationCode(
          {
            config: deps.config,
            platform: deps.platform,
            ...(deps.bindAccessDpop != null ? { bindAccessDpop: deps.bindAccessDpop } : {}),
          },
          { ...body, basic },
          dpopJkt,
        );
      }
    } else if (grantType === 'refresh_token') {
      if (typeof deps.mintRefreshedAccess !== 'function') {
        // Operator misconfiguration, not a client error: the grant handler
        // exists but its mint dep was not wired. `unsupported_grant_type` is a
        // 400-class RFC 6749 §5.2 enum, so pairing it with 501 was
        // self-contradictory (and would mislead a client whose discovery doc
        // advertises the grant). Report a 5xx server fault instead.
        outcome = { ok: false, status: 500, error: 'server_error', description: 'refresh_token grant is advertised but not wired on this deployment' };
      } else {
        outcome = await handleRefreshToken(
          {
            config: deps.config,
            platform: deps.platform,
            mintRefreshedAccess: deps.mintRefreshedAccess,
            ...(deps.revokeChain != null ? { revokeChain: deps.revokeChain } : {}),
          },
          { ...body, basic },
          dpopJkt,
        );
      }
    } else if (dpopJkt != null && grantType === 'client_credentials') {
      // Not supported for this grant in v1 — refuse loudly rather than
      // silently issuing an unbound token to a client that asked for
      // binding.
      outcome = { ok: false, status: 400, error: 'invalid_request', description: 'DPoP is not supported for the client_credentials grant' };
    } else if (grantType === 'client_credentials') {
      if (typeof deps.mintClientAccess !== 'function' || typeof deps.resolveAccountUserId !== 'function') {
        // Server misconfiguration (advertised-but-not-wired), not a client
        // error — see the refresh_token branch above. 5xx, not 501+400-enum.
        outcome = { ok: false, status: 500, error: 'server_error', description: 'client_credentials grant is advertised but not wired on this deployment' };
      } else {
        outcome = await handleClientCredentials(
          {
            config: deps.config,
            platform: deps.platform,
            mintClientAccess: deps.mintClientAccess,
            resolveAccountUserId: deps.resolveAccountUserId,
          },
          { ...body, basic },
        );
      }
    } else if (grantType === '') {
      outcome = { ok: false, status: 400, error: 'invalid_request', description: 'grant_type is required' };
    } else {
      outcome = {
        ok: false,
        status: 400,
        error: 'unsupported_grant_type',
        description: `grant_type "${grantType}" is not supported`,
      };
    }

    // Advisory key inventory (operator `list-keys` discoverability): record the
    // (clientId, jkt) pair on a successful bound issuance. The grant already
    // validated body/basic client_id against the code/refresh row, so it is the
    // authenticated client here. Fire-and-forget — it must NEVER fail or delay
    // issuance; revoke-by-jkt works without it.
    if (outcome.ok && dpopJkt != null) {
      const clientId = typeof body.client_id === 'string' && body.client_id.length > 0
        ? body.client_id
        : basic?.client_id;
      if (typeof clientId === 'string' && clientId.length > 0) {
        recordDpopKeySeen(deps.platform, clientId, dpopJkt)
          .catch((err) => logServerError('recordDpopKeySeen failed', err));
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (outcome.ok) {
      res.statusCode = 200;
      res.end(JSON.stringify(outcome.body));
    } else {
      res.statusCode = outcome.status;
      const resBody: Record<string, unknown> = { error: outcome.error };
      if (outcome.description) resBody.error_description = outcome.description;
      res.end(JSON.stringify(resBody));
    }
  };
}
