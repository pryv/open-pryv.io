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
 *   2. Delete the row atomically (single-use; rotation always on; reuse
 *      → `invalid_grant` + `oauth.refresh.reused` audit signal).
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
}) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;

export type RefreshTokenDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  mintRefreshedAccess: MintRefreshedAccess;
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
  if (row == null) {
    // Either expired/never-issued OR already-rotated. Audit as reuse
    // since the legitimate path always deletes-then-reissues; we can't
    // distinguish locally, but the security-relevant case is reuse.
    await audit('oauth.code.reused', { clientId: params.client_id, codeId: 'refresh:' + params.refresh_token.slice(0, 6) + '…' });
    return { ok: false, status: 400, error: 'invalid_grant', description: 'refresh_token is invalid or already used' };
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
  });

  return {
    ok: true,
    body: {
      access_token: access.accessToken,
      token_type: 'Bearer',
      expires_in: accessTokenTTL,
      refresh_token: newRefresh,
      scope: row.scope.join(' '),
      apiEndpoint: access.apiEndpoint,
    },
  };
}
