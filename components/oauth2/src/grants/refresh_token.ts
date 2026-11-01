/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `grant_type=refresh_token` handler.
 *
 * Exchange flow:
 *   1. Authenticate the client (Basic / `client_id` consistency, secret or
 *      assertion, not suspended) and check, on a NON-consuming read of the
 *      row, that the token was issued to it. None of these refusals consumes
 *      the token: a presenter holding only a leaked refresh token cannot burn
 *      it (which would make the legitimate client's next refresh a "reuse"
 *      and end the user's grant).
 *   2. Consume the row atomically (single-use; rotation always on; key
 *      `oauth-rt/<coreId>/<sha256(token)>`, lazy-expired past
 *      `min(expiresAt, absoluteExpiresAt)`). If the token no longer resolves,
 *      a consumed-marker lookup distinguishes genuine reuse (→
 *      `oauth.token.reuse_detected` + chain revoke past the grace window)
 *      from expired/never-issued (→ `oauth.code.reused`). Both return an
 *      identical `invalid_grant` so the two are not distinguishable on the wire.
 *   3. Re-verify `client_id` against the consumed row (a peek/consume
 *      interleaving); a mismatch then ends the token.
 *   4. Mint a NEW app access under the same user/scope/client via the
 *      injected `mintRefreshedAccess` callback. The grant runs without
 *      a user context (the user is gone by refresh time), so the host
 *      app's callback is expected to use the storage layer directly —
 *      the original `accesses.create` chain ran at /authorize/accept
 *      time and already validated permissions; refresh just rotates
 *      credentials, never widens authority.
 *   5. Mint a NEW refresh token with sliding TTL bounded by the
 *      original absolute cap (a refresh chain cannot outlive the
 *      original consent's hard ceiling — RFC 6749 §6).
 *   6. Return RFC 6749 §5.1 JSON + the Pryv `apiEndpoint` extension.
 *
 * Reuse-detection (T-10 mitigation): a second presentation of an
 * already-deleted refresh token SHOULD trigger a cluster-wide revoke
 * of the entire (clientId, userId) chain. The pubsub fan-out arrives
 * in a follow-up; for now the row simply isn't there and `invalid_grant`
 * is returned, denying the attacker the new tokens but leaving the
 * legitimately rotated chain intact.
 *
 * A chain ended while its rotation is in flight (the session deleted, or the
 * token revoked, between the consume and the response):
 *   - after the consumed marker is written, the end turns the marker
 *     `revoked`; the rotation re-reads it once its new rows are durable and,
 *     if so, ends what it just minted and answers `invalid_grant`;
 *   - between the consume and the marker write, the end finds neither row
 *     nor marker and does nothing: the rotation completes (known residual,
 *     a window of one write; a second deletion of the new session ends it);
 *   - a failed rotation never restores a token ended meanwhile; restoring
 *     re-checks the marker after the write, and a presenter consuming the
 *     restored row in the microseconds between the write and the re-check
 *     is a known residual (it would need the marker read before every mint).
 * When the marker write itself fails (`consumedAt` null), reuse detection is
 * lost for that token, a later server failure cannot restore the row (the
 * client must re-authorize), and a final refusal ends nothing more (its
 * replay is then classified "unknown", the probe signal).
 */

import { createRequire } from 'node:module';

import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { UsernameResolver, AuthCodeAccessRevoker } from './authorization_code.ts';
const require = createRequire(import.meta.url);

// Kept on the require shim: a typed `storage` import surfaces a pre-existing
// GrantPermission vs Record<string,unknown> mismatch at the mint boundary that
// belongs to the TS-migration track, not here.
const { generateToken } = require('../secureToken.ts');
const storage = require('../storage.ts');
const { audit } = require('../audit.ts');
const { logServerError } = require('../serverLog.ts');
const { getClient, isRegistryClient } = require('../clientRegistry.ts');
const { authenticateClient } = require('../clientSecret.ts');
const { tokenEndpointAudiences, issuerFromConfig } = require('../issuer.ts');
const { prepareRegistryResponse } = require('../responseHooks.ts');
const { indexSession } = require('../sessionIndex.ts');

/**
 * Mint a new app access for the resolved (userId, clientId, scope)
 * tuple at refresh time. The host-app wiring uses the storage layer
 * directly (no user context available at this point).
 */
export type MintRefreshedAccess = (params: {
  userId: string;
  username: string;
  clientId: string;
  scope: string[];
  expiresAt: number;
  /**
   * Granular (cmc) grants: the durable data-grant the chain is bound
   * to + this session's granted subset. The mint callback re-reads the
   * data-grant — gone (consent revoked) → it throws an error with
   * `code: 'data-grant-revoked'`, which this grant maps to
   * `invalid_grant` (the whole refresh chain dies); otherwise the new
   * access is minted from `permissions ∩ data-grant.permissions`
   * (consent narrowing propagates on refresh; no widening without a
   * fresh consent).
   */
  dataGrantAccessId?: string;
  permissions?: Array<Record<string, unknown>>;
  /**
   * DPoP-bound chains: the RFC 7638 thumbprint the chain is bound to.
   * The mint callback stamps it onto the new access so the resource
   * server can enforce proof-of-possession on every request.
   */
  jkt?: string;
}) => Promise<{
  accessId: string;
  accessToken: string;
  apiEndpoint: string;
  /** The permissions actually minted (grant ∩ the data-grant's current ones). */
  permissions?: Array<Record<string, unknown>>;
  /** The id a registry client sees for the user (stable internal id, or the grant's alias). */
  subject?: string | null;
  /** Whether `subject` is the grant's alias (then the username is never sent). */
  aliased?: boolean;
}>;

/**
 * Collapse a refresh chain on detected reuse: soft-delete the durable data-grant
 * (kills future refreshes) + all live session accesses for (user, client), and
 * best-effort notify the counterparty app. Storage-direct — wired in the
 * api-server layer where the accesses repository + cache live. Errors are the
 * caller's to swallow (a revoke failure must not turn the reuse response into a 500).
 */
export type RevokeChain = (params: {
  userId: string;
  username: string;
  clientId: string;
  dataGrantAccessId?: string;
}) => Promise<void>;

/**
 * Retire the session a chain backed until this rotation: it expires shortly
 * (`oauth:refreshRetireGraceSeconds`) instead of living out its own lifetime.
 * Storage-direct, wired in the api-server layer. Resolves to whether a live
 * session was retired.
 */
export type RetireSession = (params: {
  userId: string; username: string; accessId: string; clientId: string;
}) => Promise<boolean>;

export type RefreshTokenDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  mintRefreshedAccess: MintRefreshedAccess;
  /** Optional: absent → reuse is detected + audited but the chain is not revoked. */
  revokeChain?: RevokeChain;
  /** Optional: absent → the replaced session lives out its own lifetime. */
  retireSession?: RetireSession;
  /**
   * Canonical username for a user id, from THIS core's local users index;
   * null when the user is no longer on this core. Refresh rows and markers
   * carry the user id only (PlatformDB is replicated and must not hold usernames).
   */
  resolveUsername: UsernameResolver;
  /** Removes a just-minted access when the response cannot be built. */
  revokeAccessLocal?: AuthCodeAccessRevoker;
};

export type RefreshGrantParams = {
  refresh_token?: string;
  client_id?: string;
  scope?: string; // RFC 6749 §6 permits narrowing on refresh; ignored for now
  /** Confidential-client auth (client_secret_post). */
  client_secret?: string;
  /** Decoded Authorization: Basic credentials, when present (client_secret_basic). */
  basic?: { client_id: string; client_secret: string } | null;
  /** Confidential-client auth (private_key_jwt, RFC 7521/7523). */
  client_assertion?: string;
  client_assertion_type?: string;
};

function lifetimes (config: { get (key: string): unknown }) {
  return {
    accessTokenTTL: Number(config.get('oauth:accessTokenTTL') ?? 3600),
    refreshTokenTTL: Number(config.get('oauth:refreshTokenTTL') ?? 30 * 24 * 3600),
  };
}

/**
 * Run the grant. Returns the response body on success, or an OAuth
 * error object on failure. Caller (token.ts route) translates that
 * into HTTP status + headers.
 */
export async function handleRefreshToken (
  deps: RefreshTokenDeps,
  params: RefreshGrantParams,
  /** RFC 7638 thumbprint of a proof VERIFIED by the dispatcher, or null. */
  dpopJkt: string | null = null
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string; description?: string }
> {
  const coreId = String(deps.config.get('core:id') ?? 'single');

  if (typeof params.refresh_token !== 'string' || params.refresh_token === '') {
    return { ok: false, status: 400, error: 'invalid_request', description: 'refresh_token is required' };
  }
  if (typeof params.client_id !== 'string' || params.client_id === '') {
    return { ok: false, status: 400, error: 'invalid_request', description: 'client_id is required' };
  }

  // Client authentication and the token's client binding run BEFORE the row
  // is consumed (RFC 6749 § 10.4: no side effect for a presenter the token is
  // not bound to). A refusal that consumed the row would let anyone holding
  // only a leaked refresh token burn it, and the legitimate client's next
  // refresh would then be a "reuse" that ends the user's grant.
  //
  // Confidential-client authentication (RFC 6749 §6 refers to §3.2.1):
  // a client that has a secret on file must authenticate on refresh too,
  // consistent with the authorization_code + client_credentials paths.
  // Public clients (no secret on file) rely on refresh-token rotation +
  // reuse detection.
  if (params.basic != null && params.basic.client_id !== params.client_id) {
    return { ok: false, status: 401, error: 'invalid_client', description: 'client_id mismatch between request and Basic authorization' };
  }
  const client = await getClient(deps.platform, params.client_id);
  // Suspension is reversible (`resume`): refused without touching the token,
  // so the app's retry after the resume is a plain refresh. Nothing is
  // learned that the client does not already know.
  if (client?.status === 'suspended') {
    return { ok: false, status: 400, error: 'unauthorized_client', description: 'this client is suspended' };
  }
  const auth = await authenticateClient({
    client,
    clientId: params.client_id,
    presentedSecret: params.basic?.client_secret ?? params.client_secret,
    assertion: params.client_assertion,
    assertionType: params.client_assertion_type,
    platform: deps.platform,
    expectedAudiences: tokenEndpointAudiences(deps.config),
  });
  if (!auth.ok) {
    return { ok: false, status: auth.status, error: auth.error, description: auth.description };
  }
  // Non-consuming read: a token issued to another client is refused and left
  // live (the presenter learns nothing it does not hold: it has the token).
  const peek = await storage.getRefresh(deps.platform, coreId, params.refresh_token);
  if (peek != null && peek.clientId !== params.client_id) {
    return { ok: false, status: 400, error: 'invalid_grant', description: 'client_id mismatch' };
  }

  // ATOMIC single-use: consume deletes-and-returns in one linearized op, so
  // two concurrent refreshes of the same token cannot both mint a new chain
  // (which also defeated reuse-detection, since both reads saw the row).
  const row = await storage.consumeRefresh(deps.platform, coreId, params.refresh_token);
  // Uniform failure description for BOTH the never-existed and the reuse branch —
  // a distinct message would let an unauthenticated caller probe whether a token
  // was real + recently consumed (and tell an attacker their theft was detected).
  const INVALID = { ok: false as const, status: 400, error: 'invalid_grant', description: 'refresh_token is invalid or already used' };
  // Audit correlation id of a refresh token: a hash prefix, no token material.
  const tokenRef = (token: string): string => 'refresh:' + storage.hashSecret(token).slice(0, 12);
  if (row == null) {
    // Token no longer resolves. Consult the consumed marker to tell genuine REUSE
    // (a rotated token replayed) from expired/never-issued.
    const marker = await storage.getRefreshConsumed(deps.platform, coreId, params.refresh_token);
    if (marker == null) {
      // Expired or never issued — not reuse. Keep the user-less probe signal.
      await audit('oauth.code.reused', { clientId: params.client_id, codeId: tokenRef(params.refresh_token) });
      return INVALID;
    }
    if (marker.revoked === true) {
      // Ended on purpose (session deleted, revoked, refused for good): never
      // rotated, so its replay is no theft evidence and the chain is left alone.
      await audit('oauth.token.reuse_detected', {
        clientId: marker.clientId,
        userId: marker.userId,
        ...(marker.dataGrantAccessId != null ? { dataGrantAccessId: marker.dataGrantAccessId } : {}),
        codeId: tokenRef(params.refresh_token),
        reason: 'revoked-token',
      });
      return INVALID;
    }
    const graceMs = 1000 * Number(deps.config.get('oauth:refreshReuseGraceSeconds') ?? 10);
    const withinGrace = (Date.now() - marker.consumedAt) < graceMs;
    // Presented by another client than the one it was issued to: refused,
    // recorded, and never a collapse (the same binding rule as a live token).
    const foreign = marker.clientId !== params.client_id;
    await audit('oauth.token.reuse_detected', {
      clientId: marker.clientId,
      userId: marker.userId,
      ...(marker.dataGrantAccessId != null ? { dataGrantAccessId: marker.dataGrantAccessId } : {}),
      codeId: tokenRef(params.refresh_token),
      reason: foreign ? 'foreign-client' : withinGrace ? 'within-grace' : 'chain-revoked',
    });
    if (!foreign && !withinGrace && typeof deps.revokeChain === 'function') {
      let username: string | null;
      try {
        username = await deps.resolveUsername(marker.userId);
      } catch (err: unknown) {
        logServerError('refresh_token: username resolution failed after reuse detection', err);
        return INVALID;
      }
      // A user gone since the rotation has nothing left to revoke.
      if (username == null) return INVALID;
      try {
        await deps.revokeChain({
          userId: marker.userId,
          username,
          clientId: marker.clientId,
          ...(marker.dataGrantAccessId != null ? { dataGrantAccessId: marker.dataGrantAccessId } : {}),
        });
      } catch (err: unknown) {
        logServerError('refresh_token: revokeChain failed after reuse detection', err);
      }
    }
    return INVALID; // never 500 on the reuse path — the audit row carries the signal
  }

  // Mark the just-consumed token so a later replay is detectable as reuse. TTL =
  // the sooner of the row's sliding + absolute expiry (past that, a replay is
  // genuinely expired). Best-effort: a lost marker costs one detection, not the
  // rotation (which already happened atomically above).
  // The marker's `consumedAt` identifies this rotation (see undoConsume).
  let consumedAt: number | null = Date.now();
  try {
    await storage.markRefreshConsumed(deps.platform, coreId, params.refresh_token, {
      clientId: row.clientId,
      userId: row.userId,
      ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
      consumedAt,
    }, Math.min(row.expiresAt, row.absoluteExpiresAt));
  } catch (err: unknown) {
    consumedAt = null;
    logServerError('refresh_token: markRefreshConsumed failed (reuse detection degraded for this token)', err);
  }

  // A refusal that is final for the chain: the token was never rotated, so
  // its marker turns `revoked` and a later replay is refused without
  // collapsing the chain (a reuse would delete the user's grant).
  const endChain = async (): Promise<void> => {
    try {
      await storage.revokeRefresh(deps.platform, coreId, params.refresh_token as string);
    } catch (err: unknown) {
      logServerError('refresh_token: marking the refused token revoked failed', err);
    }
  };

  // Defence for a peek/consume interleaving (checked on the peek above).
  if (params.client_id !== row.clientId) {
    await endChain();
    return { ok: false, status: 400, error: 'invalid_grant', description: 'client_id mismatch' };
  }

  // A server-side failure after the consume means the rotation did not
  // happen: the row goes back and the marker away, so the client's retry is a
  // plain refresh (otherwise a transient failure, e.g. an extension hook
  // timing out, would make the retry a reuse and end the user's grant). Not
  // when the token was ended meanwhile (session deleted, token revoked).
  const undoConsume = async (): Promise<void> => {
    try {
      const restored = await storage.restoreConsumedRefresh(deps.platform, coreId, params.refresh_token as string, row, consumedAt);
      if (!restored) {
        logServerError(consumedAt == null
          ? 'refresh_token: the consumed row was not restored (its consumed marker could not be written): the client must re-authorize'
          : 'refresh_token: the consumed row was not restored (the token was ended meanwhile): the client must re-authorize', null);
      }
    } catch (err: unknown) {
      logServerError('refresh_token: restoring the consumed row failed: the client must re-authorize', err);
    }
  };
  const serverError = async (description: string) => {
    await undoConsume();
    return { ok: false as const, status: 500, error: 'server_error', description };
  };

  if (row.kind === 'registry' && !isRegistryClient(client)) {
    await endChain();
    return { ok: false, status: 400, error: 'invalid_grant', description: 'the client registration changed, re-authorize' };
  }

  // DPoP binding continuity (RFC 9449 §5): a bound chain must rotate
  // with a proof by the SAME key; an unbound chain can never acquire a
  // binding mid-life (the kind is fixed at issuance). Uniform failure
  // body either way. NOTE the row is already consumed above — a failed
  // check burns the rotation, which is the safe direction: a thief
  // holding the refresh token but not the key can at worst force a
  // re-authorization, never take over the chain.
  const boundJkt = typeof row.jkt === 'string' ? row.jkt : null;
  if ((boundJkt != null && dpopJkt !== boundJkt) || (boundJkt == null && dpopJkt != null)) {
    // The row is already consumed (single-use), so this rotation is burned —
    // the safe direction: a thief holding only the refresh token cannot take
    // over the chain. Audit it distinctly so the next legitimate refresh's
    // reuse_detected is not misread as the root cause.
    await audit('oauth.token.dpop_mismatch', {
      clientId: row.clientId,
      userId: row.userId,
      ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
      reason: boundJkt == null ? 'proof-on-unbound-chain' : 'wrong-key',
    });
    return { ok: false, status: 400, error: 'invalid_dpop_proof', description: 'DPoP proof verification failed' };
  }

  // Enforce the absolute-lifetime cap BEFORE minting anything. Checking
  // after the mint would leave an orphan access row behind on a
  // cap-exceeded refresh (the access is minted, then the chain is
  // refused). The row is already consumed above (single-use); a client
  // past the ceiling must re-consent for a new chain.
  const { accessTokenTTL, refreshTokenTTL } = lifetimes(deps.config);
  const now = Date.now();
  const newRefreshExpiresAt = Math.min(now + refreshTokenTTL * 1000, row.absoluteExpiresAt);
  if (newRefreshExpiresAt <= now) {
    await endChain();
    return { ok: false, status: 400, error: 'invalid_grant', description: 'refresh-token absolute lifetime exceeded' };
  }

  // The row carries no username: resolve it on this core (the refresh key
  // is per-core, so a row that resolved here was issued here). A user gone
  // since the last rotation ends the chain; the consumed marker above keeps
  // reuse detection intact.
  let username: string | null;
  try {
    username = await deps.resolveUsername(row.userId);
  } catch (err: unknown) {
    logServerError('refresh_token: username resolution failed', err);
    return await serverError('failed to resolve the authorizing user');
  }
  if (username == null) {
    return { ok: false, status: 400, error: 'invalid_grant', description: 'the authorized access is no longer valid' };
  }

  // Mint a fresh access via the injected callback.
  const accessExpiresAt = now + accessTokenTTL * 1000;
  let access;
  try {
    access = await deps.mintRefreshedAccess({
      userId: row.userId,
      username,
      clientId: row.clientId,
      scope: row.scope,
      expiresAt: accessExpiresAt,
      ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
      ...(row.permissions != null ? { permissions: row.permissions } : {}),
      ...(boundJkt != null ? { jkt: boundJkt } : {}),
    });
  } catch (err: unknown) {
    if ((err as { code?: string } | null)?.code === 'data-grant-revoked') {
      await endChain();
      await audit('oauth.token.revoked', {
        clientId: row.clientId,
        userId: row.userId,
        reason: 'refresh denied: consent data-grant revoked',
      });
      return { ok: false, status: 400, error: 'invalid_grant', description: 'consent has been revoked' };
    }
    logServerError('refresh_token: mintRefreshedAccess failed', err);
    return await serverError('failed to mint refreshed access');
  }

  // Registry client: the scope echo follows the EFFECTIVE permissions (a
  // grant narrowed since the last rotation narrows the answer). Computed
  // before the new refresh row exists; on failure the new access is removed.
  let registry = null;
  if (row.kind === 'registry') {
    try {
      if (typeof access.subject !== 'string' || access.subject.length === 0) {
        throw new Error('the refreshed registry session has no subject');
      }
      registry = await prepareRegistryResponse({
        client,
        grantType: 'refresh_token',
        issuer: issuerFromConfig(deps.config),
        config: deps.config,
        coreTokens: row.coreTokens ?? [],
        grammarTokens: row.grammarTokens ?? [],
        permissions: access.permissions ?? row.permissions ?? [],
        subject: access.subject,
      });
    } catch (err: unknown) {
      logServerError('refresh_token: registry token response failed', err);
      if (typeof deps.revokeAccessLocal === 'function') {
        try {
          await deps.revokeAccessLocal({ userId: row.userId, username, accessId: access.accessId, clientId: row.clientId });
        } catch (revokeErr: unknown) {
          logServerError('refresh_token: revoke of the unanswered access failed', revokeErr);
        }
      }
      return await serverError('failed to build the token response');
    }
  }

  // Mint a new refresh token. Sliding TTL, but never past the original
  // absolute cap (RFC 6749 §6 — refresh chain ≤ original consent ceiling).
  const newRefresh = generateToken();
  await storage.setRefresh(deps.platform, coreId, newRefresh, {
    clientId: row.clientId,
    userId: row.userId,
    scope: row.scope,
    issuedAt: now,
    lastUsedAt: now,
    expiresAt: newRefreshExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
    ...(row.permissions != null ? { permissions: row.permissions } : {}),
    ...(boundJkt != null ? { jkt: boundJkt } : {}),
    ...(row.kind === 'registry'
      ? { kind: 'registry', coreTokens: row.coreTokens ?? [], grammarTokens: row.grammarTokens ?? [] }
      : {}),
    ...(row.audience != null ? { audience: row.audience } : {}),
    accessId: access.accessId,
  });

  await indexSession(deps.platform, access.accessToken, {
    userId: row.userId,
    accessId: access.accessId,
    clientId: row.clientId,
    coreId,
    expiresAt: accessExpiresAt,
    ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
    ...(row.kind === 'registry' ? { coreTokens: row.coreTokens ?? [], grammarTokens: row.grammarTokens ?? [] } : {}),
    ...(row.audience != null ? { audience: row.audience } : {}),
    refreshTokenHash: storage.hashSecret(newRefresh),
  });

  // Ended while this rotation was in flight (the session deleted, the token
  // revoked: the consumed marker turned `revoked`)? Then what was just minted
  // is ended too, the replaced session is left as it is, and the answer is
  // the refusal the client would have had a moment later.
  if (consumedAt != null) {
    let endedMeanwhile = false;
    try {
      endedMeanwhile = (await storage.getRefreshConsumed(deps.platform, coreId, params.refresh_token))?.revoked === true;
    } catch (err: unknown) {
      logServerError('refresh_token: re-reading the consumed marker failed', err);
    }
    if (endedMeanwhile) {
      try {
        await storage.revokeRefresh(deps.platform, coreId, newRefresh);
        await storage.deleteSessionIndex(deps.platform, access.accessToken);
        if (typeof deps.revokeAccessLocal === 'function') {
          await deps.revokeAccessLocal({ userId: row.userId, username, accessId: access.accessId, clientId: row.clientId });
        }
      } catch (err: unknown) {
        logServerError('refresh_token: ending the session minted by a rotation ended meanwhile failed', err);
      }
      await audit('oauth.token.revoked', {
        clientId: row.clientId,
        userId: row.userId,
        accessId: access.accessId,
        reason: 'refresh chain ended during its rotation',
      });
      return INVALID;
    }
  }

  // The new credentials are durable: retire the session this chain backed
  // until now (a row written before refresh rows named it retires nothing).
  // Never fails the refresh: the old session then lives out its own lifetime.
  let retiredAccessId: string | null = null;
  if (typeof row.accessId === 'string' && row.accessId !== access.accessId && typeof deps.retireSession === 'function') {
    try {
      const retired = await deps.retireSession({ userId: row.userId, username, accessId: row.accessId, clientId: row.clientId });
      if (retired) retiredAccessId = row.accessId;
    } catch (err: unknown) {
      logServerError('refresh_token: retiring the previous session failed (it lives out its own lifetime)', err);
    }
  }

  await audit('oauth.token.refreshed', {
    clientId: row.clientId,
    userId: row.userId,
    oldTokenId: tokenRef(params.refresh_token),
    newTokenId: tokenRef(newRefresh),
    ...(retiredAccessId != null ? { retiredAccessId } : {}),
  });
  await audit('oauth.token.issued.authorization_code', {
    clientId: row.clientId,
    userId: row.userId,
    // A registry client: the tokens actually granted (the scope answer).
    grantedScope: registry != null ? registry.scopeTokens : row.scope,
    accessId: access.accessId,
    ...(boundJkt != null ? { dpopJkt: boundJkt } : {}),
  });

  if (registry != null) {
    return {
      ok: true,
      body: {
        ...registry.extra,
        access_token: access.accessToken,
        token_type: boundJkt != null ? 'DPoP' : 'Bearer',
        expires_in: accessTokenTTL,
        refresh_token: newRefresh,
        scope: registry.scopeTokens.join(' '),
        ...(access.aliased === false ? { apiEndpoint: access.apiEndpoint } : {}),
      },
    };
  }
  return {
    ok: true,
    body: {
      access_token: access.accessToken,
      token_type: boundJkt != null ? 'DPoP' : 'Bearer',
      expires_in: accessTokenTTL,
      refresh_token: newRefresh,
      scope: row.scope.join(' '),
      apiEndpoint: access.apiEndpoint,
    },
  };
}
