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
 *   1. Load the refresh row (key: `oauth-refresh/<coreId>/<token>`).
 *      `getAccessState` lazy-expires past `min(expiresAt, absoluteExpiresAt)`.
 *   2. Consume the row atomically (single-use; rotation always on). If the
 *      token no longer resolves, a consumed-marker lookup distinguishes genuine
 *      reuse (→ `oauth.token.reuse_detected` + chain revoke past the grace
 *      window) from expired/never-issued (→ `oauth.code.reused`). Both return
 *      an identical `invalid_grant` so the two are not distinguishable on the wire.
 *   3. Verify `client_id` matches the row's clientId.
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
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';

// Kept on the require shim: a typed `storage` import surfaces a pre-existing
// GrantPermission vs Record<string,unknown> mismatch at the mint boundary that
// belongs to the TS-migration track, not here.
const { generateToken } = require('../secureToken.ts');
const storage = require('../storage.ts');
const { audit } = require('../audit.ts');
const { logServerError } = require('../serverLog.ts');
const { getClient } = require('../clientRegistry.ts');
const { authenticateClient } = require('../clientSecret.ts');

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
}) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;

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

export type RefreshTokenDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  mintRefreshedAccess: MintRefreshedAccess;
  /** Optional: absent → reuse is detected + audited but the chain is not revoked. */
  revokeChain?: RevokeChain;
};

export type RefreshGrantParams = {
  refresh_token?: string;
  client_id?: string;
  scope?: string; // RFC 6749 §6 permits narrowing on refresh; ignored for now
  /** Confidential-client auth (client_secret_post). */
  client_secret?: string;
  /** Decoded Authorization: Basic credentials, when present (client_secret_basic). */
  basic?: { client_id: string; client_secret: string } | null;
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
  dpopJkt: string | null = null,
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

  // ATOMIC single-use: consume deletes-and-returns in one linearized op, so
  // two concurrent refreshes of the same token cannot both mint a new chain
  // (which also defeated reuse-detection, since both reads saw the row).
  const row = await storage.consumeRefresh(deps.platform, coreId, params.refresh_token);
  // Uniform failure description for BOTH the never-existed and the reuse branch —
  // a distinct message would let an unauthenticated caller probe whether a token
  // was real + recently consumed (and tell an attacker their theft was detected).
  const INVALID = { ok: false as const, status: 400, error: 'invalid_grant', description: 'refresh_token is invalid or already used' };
  if (row == null) {
    // Token no longer resolves. Consult the consumed marker to tell genuine REUSE
    // (a rotated token replayed) from expired/never-issued.
    const marker = await storage.getRefreshConsumed(deps.platform, coreId, params.refresh_token);
    if (marker == null) {
      // Expired or never issued — not reuse. Keep the user-less probe signal.
      await audit('oauth.code.reused', { clientId: params.client_id, codeId: 'refresh:' + params.refresh_token.slice(0, 6) + '…' });
      return INVALID;
    }
    const graceMs = 1000 * Number(deps.config.get('oauth:refreshReuseGraceSeconds') ?? 10);
    const withinGrace = (Date.now() - marker.consumedAt) < graceMs;
    await audit('oauth.token.reuse_detected', {
      clientId: marker.clientId,
      userId: marker.userId,
      ...(marker.dataGrantAccessId != null ? { dataGrantAccessId: marker.dataGrantAccessId } : {}),
      codeId: 'refresh:' + params.refresh_token.slice(0, 6) + '…',
      reason: withinGrace ? 'within-grace' : 'chain-revoked',
    });
    if (!withinGrace && typeof deps.revokeChain === 'function') {
      try {
        await deps.revokeChain({
          userId: marker.userId,
          username: marker.username,
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
  try {
    await storage.markRefreshConsumed(deps.platform, coreId, params.refresh_token, {
      clientId: row.clientId,
      userId: row.userId,
      username: row.username,
      ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
      consumedAt: Date.now(),
    }, Math.min(row.expiresAt, row.absoluteExpiresAt));
  } catch (err: unknown) {
    logServerError('refresh_token: markRefreshConsumed failed (reuse detection degraded for this token)', err);
  }

  if (params.client_id !== row.clientId) {
    return { ok: false, status: 400, error: 'invalid_grant', description: 'client_id mismatch' };
  }

  // Confidential-client authentication (RFC 6749 §6 refers to §3.2.1):
  // a client that has a secret on file must authenticate on refresh too,
  // consistent with the authorization_code + client_credentials paths.
  // Public clients (no secret on file) rely on refresh-token rotation +
  // reuse detection.
  if (params.basic != null && params.basic.client_id !== params.client_id) {
    return { ok: false, status: 401, error: 'invalid_client', description: 'client_id mismatch between request and Basic authorization' };
  }
  const client = await getClient(deps.platform, params.client_id);
  const presentedSecret = params.basic?.client_secret ?? params.client_secret;
  const auth = await authenticateClient({ client, presentedSecret });
  if (!auth.ok) {
    return { ok: false, status: auth.status, error: auth.error, description: auth.description };
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
    return { ok: false, status: 400, error: 'invalid_grant', description: 'refresh-token absolute lifetime exceeded' };
  }

  // Mint a fresh access via the injected callback.
  const accessExpiresAt = now + accessTokenTTL * 1000;
  let access;
  try {
    access = await deps.mintRefreshedAccess({
      userId: row.userId,
      username: row.username,
      clientId: row.clientId,
      scope: row.scope,
      expiresAt: accessExpiresAt,
      ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
      ...(row.permissions != null ? { permissions: row.permissions } : {}),
      ...(boundJkt != null ? { jkt: boundJkt } : {}),
    });
  } catch (err: unknown) {
    if ((err as { code?: string } | null)?.code === 'data-grant-revoked') {
      await audit('oauth.token.revoked', {
        clientId: row.clientId,
        userId: row.userId,
        reason: 'refresh denied: consent data-grant revoked',
      });
      return { ok: false, status: 400, error: 'invalid_grant', description: 'consent has been revoked' };
    }
    logServerError('refresh_token: mintRefreshedAccess failed', err);
    return {
      ok: false,
      status: 500,
      error: 'server_error',
      description: 'failed to mint refreshed access',
    };
  }

  // Mint a new refresh token. Sliding TTL, but never past the original
  // absolute cap (RFC 6749 §6 — refresh chain ≤ original consent ceiling).
  const newRefresh = generateToken();
  await storage.setRefresh(deps.platform, coreId, newRefresh, {
    clientId: row.clientId,
    userId: row.userId,
    username: row.username,
    scope: row.scope,
    issuedAt: now,
    lastUsedAt: now,
    expiresAt: newRefreshExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
    ...(row.permissions != null ? { permissions: row.permissions } : {}),
    ...(boundJkt != null ? { jkt: boundJkt } : {}),
  });

  await audit('oauth.token.refreshed', {
    clientId: row.clientId,
    userId: row.userId,
    oldTokenId: 'refresh:' + params.refresh_token.slice(0, 6) + '…',
    newTokenId: 'refresh:' + newRefresh.slice(0, 6) + '…',
  });
  await audit('oauth.token.issued.authorization_code', {
    clientId: row.clientId,
    userId: row.userId,
    grantedScope: row.scope,
    accessId: access.accessId,
    ...(boundJkt != null ? { dpopJkt: boundJkt } : {}),
  });

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
