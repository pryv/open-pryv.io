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
 * applied on the whole OAuth surface (corsMiddleware, mounted by the app
 * before the body parsers and by registerRoutes); the body is expected
 * pre-parsed as `application/x-www-form-urlencoded` (api-server's
 * existing body parser handles both that and `application/json`).
 *
 * Wired grants: authorization_code, refresh_token, client_credentials, and
 * token exchange (RFC 8693) for registry clients registered for it.
 * Each grant handler returns either {ok:true, body} or {ok:false,
 * status, error, description?}; the dispatcher translates to HTTP.
 */

import type { Request, Response } from 'express';
import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import { handleAuthorizationCode } from '../grants/authorization_code.ts';
import type { AuthCodeAccessResolver, AuthCodeAccessRevoker, UsernameResolver, GrantSubjectResolver } from '../grants/authorization_code.ts';
import { handleRefreshToken } from '../grants/refresh_token.ts';
import type { MintRefreshedAccess, RetireSession } from '../grants/refresh_token.ts';
import { handleClientCredentials } from '../grants/client_credentials.ts';
import { handleTokenExchange, TOKEN_EXCHANGE } from '../grants/token_exchange.ts';
import type { ReadSubjectSession, IssueDerivedSession } from '../grants/token_exchange.ts';
import { verifyDPoPProof, DPoPProofError } from '../dpop.ts';
import { externalRequestUri } from '../externalUri.ts';
import { markDPoPJtiUsed, getDpopKeyRevokedAt, recordDpopKeySeen } from '../storage.ts';
import { logServerError } from '../serverLog.ts';
import { getClient, isRegistryClient } from '../clientRegistry.ts';
import { decodeBasicAuth, clientIdFromAssertion, hasKeySet } from '../clientAuth.ts';
import { clientKeyOf } from '../clientMetadataId.ts';
import { reportClientAuthRefusal } from '../clientMetadata.ts';

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
  mintRefreshedAccess?: MintRefreshedAccess;
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
  /** Optional: retire the session a refresh rotation replaces (refresh_token grant). */
  retireSession?: RetireSession;
  /** Required for authorization_code: read the pre-minted access back by id. */
  resolveAccess?: AuthCodeAccessResolver;
  /** authorization_code: delete an orphaned pre-minted access locally. */
  revokeAccessLocal?: AuthCodeAccessRevoker;
  /** Canonical username for a user id on this core (rows carry the id only). */
  resolveUsername: UsernameResolver;
  /** Registry clients: the id the app sees for the user. */
  resolveGrantSubject?: GrantSubjectResolver;
  /** Token exchange: the subject session re-read on its home core. */
  readSubjectSession?: ReadSubjectSession;
  /** Token exchange: find or mint the derived session. */
  issueDerivedSession?: IssueDerivedSession;
  /** Public URL of a core (token exchange's wrong-core answer). */
  coreUrlFor?: (coreId: string) => string | Promise<string>;
};

type TokenOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string; description?: string; extra?: Record<string, unknown> };

export function handleToken (deps: TokenDeps) {
  return async function token (req: Request, res: Response): Promise<void> {
    const basic = decodeBasicAuth(req.headers?.authorization);
    // RFC 6749 §2.3.1 / §3.2.1: a client authenticating with HTTP Basic is
    // identified by it, so client_id in the body is optional then. When both
    // are given and differ, the grant refuses the request (invalid_client).
    const rawBody = req.body ?? {};
    const noBodyClientId = typeof rawBody.client_id !== 'string' || rawBody.client_id === '';
    // A metadata-document client names itself by its URL (never in Basic: it
    // has no secret); from here on it is its row key.
    let body = basic != null && noBodyClientId
      ? { ...rawBody, client_id: basic.client_id }
      : (noBodyClientId ? rawBody : { ...rawBody, client_id: clientKeyOf(rawBody.client_id) });
    const grantType = typeof body.grant_type === 'string' ? body.grant_type : '';

    let outcome: TokenOutcome | undefined;
    // RFC 7521 §4.2 / RFC 7523 §3: next to a client_assertion, client_id is
    // optional; the client is then the one the assertion names (its iss, read
    // unverified here). The grant authenticates that client exactly as it
    // would a body client_id. An assertion that names no client, or names one
    // without a key set on file, is refused here with the uniform answer,
    // before anything is used up (a code, a DPoP proof jti). A known client
    // named this way then runs the grant as with a body client_id, so on the
    // code grant a bad code answers 400 invalid_grant where an unknown iss
    // answers 401: that tells whether a client id exists. Accepted: client ids
    // are public (every authorization URL carries one), and the refresh and
    // client_credentials grants already tell it apart for a body client_id.
    let assertedClient: Awaited<ReturnType<typeof getClient>> | undefined;
    if (basic == null && noBodyClientId && typeof rawBody.client_assertion === 'string' && rawBody.client_assertion !== '') {
      // A metadata-document client's assertion names its URL: its row key here.
      const assertedIss = clientIdFromAssertion(rawBody.client_assertion, rawBody.client_assertion_type);
      const assertedId = assertedIss != null ? clientKeyOf(assertedIss) : null;
      const asserted = assertedId != null ? await getClient(deps.platform, assertedId) : null;
      if (assertedId == null || !hasKeySet(asserted)) {
        // Recorded for a metadata-document client (its row may be gone: the URL the assertion named is the hint).
        if (assertedId != null) await reportClientAuthRefusal(deps.platform, assertedId, 'token', grantType, assertedIss);
        outcome = { ok: false as const, status: 401, error: 'invalid_client', description: 'client authentication failed' };
      } else {
        assertedClient = asserted;
        body = { ...rawBody, client_id: assertedId };
      }
    }
    // DPoP (RFC 9449 §5): a proof on the token request opts this
    // issuance into key binding. Verified BEFORE any grant runs, so a
    // bad proof burns nothing (no code/refresh consumed). The proof
    // covers this endpoint (no ath — no access token exists yet) and
    // its jti is burned atomically: of two concurrent identical proofs
    // exactly one proceeds.
    let dpopJkt: string | null = null;
    const dpopHeader = req.headers?.dpop;
    // Registry clients cannot bind their tokens to a key in this version:
    // refused before the proof is verified (its jti is not burned) and before
    // any grant runs (the code or refresh token is not consumed). The proof
    // itself is not at fault, so this is invalid_request, as for
    // client_credentials below, not invalid_dpop_proof.
    if (outcome != null) {
      // refused above: the request names no client that can authenticate
    } else if (dpopHeader != null && typeof body.client_id === 'string' && body.client_id !== '' &&
        isRegistryClient(assertedClient ?? await getClient(deps.platform, body.client_id))) {
      outcome = { ok: false as const, status: 400, error: 'invalid_request', description: 'DPoP is not available for this client' };
    } else if (dpopHeader != null) {
      const clockSkewSeconds = Number(deps.config.get('oauth:dpop:clockSkewSeconds') ?? 120);
      try {
        const verified = await verifyDPoPProof(
          Array.isArray(dpopHeader) ? null : dpopHeader,
          { htm: 'POST', htu: externalRequestUri(req), clockSkewSeconds }
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
          deps.platform, verified.jkt, verified.jti, Date.now() + 2 * clockSkewSeconds * 1000
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
            ...(deps.resolveAccess != null ? { resolveAccess: deps.resolveAccess } : {}),
            ...(deps.revokeAccessLocal != null ? { revokeAccessLocal: deps.revokeAccessLocal } : {}),
            ...(deps.resolveGrantSubject != null ? { resolveGrantSubject: deps.resolveGrantSubject } : {}),
            resolveUsername: deps.resolveUsername,
          },
          { ...body, basic },
          dpopJkt
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
            ...(deps.retireSession != null ? { retireSession: deps.retireSession } : {}),
            ...(deps.revokeAccessLocal != null ? { revokeAccessLocal: deps.revokeAccessLocal } : {}),
            resolveUsername: deps.resolveUsername,
          },
          { ...body, basic },
          dpopJkt
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
            resolveUsername: deps.resolveUsername,
          },
          { ...body, basic }
        );
      }
    } else if (grantType === TOKEN_EXCHANGE) {
      // RFC 8693. A DPoP proof never reaches here: the exchanging client is a
      // registry client, refused above.
      if (typeof deps.readSubjectSession !== 'function' || typeof deps.issueDerivedSession !== 'function') {
        outcome = { ok: false, status: 500, error: 'server_error', description: 'token exchange is not wired on this deployment' };
      } else {
        outcome = await handleTokenExchange(
          {
            config: deps.config,
            platform: deps.platform,
            readSubjectSession: deps.readSubjectSession,
            issueDerivedSession: deps.issueDerivedSession,
            ...(deps.coreUrlFor != null ? { coreUrlFor: deps.coreUrlFor } : {}),
          },
          { ...body, basic }
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
      if (outcome.error === 'invalid_client' && typeof body.client_id === 'string') {
        await reportClientAuthRefusal(deps.platform, body.client_id, 'token', grantType);
      }
      res.statusCode = outcome.status;
      const resBody: Record<string, unknown> = { error: outcome.error };
      if (outcome.description) resBody.error_description = outcome.description;
      // e.g. the wrong-core answer's `coreUrl`
      if (outcome.extra != null) Object.assign(resBody, outcome.extra);
      res.end(JSON.stringify(resBody));
    }
  };
}
