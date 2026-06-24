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

const cuid = require('cuid');
const storage = require('../storage.ts');
const { audit } = require('../audit.ts');

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
}) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;

export type RefreshTokenDeps = {
  config: { get (key: string): unknown };
  platform: any;
  mintRefreshedAccess: MintRefreshedAccess;
};

export type RefreshGrantParams = {
  refresh_token?: string;
  client_id?: string;
  scope?: string; // RFC 6749 §6 permits narrowing on refresh; ignored for now
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

  const row = await storage.getRefresh(deps.platform, coreId, params.refresh_token);
  if (row == null) {
    // Either expired/never-issued OR already-rotated. Audit as reuse
    // since the legitimate path always deletes-then-reissues; we can't
    // distinguish locally, but the security-relevant case is reuse.
    await audit('oauth.code.reused', { clientId: params.client_id, codeId: 'refresh:' + params.refresh_token.slice(0, 6) + '…' });
    return { ok: false, status: 400, error: 'invalid_grant', description: 'refresh_token is invalid or already used' };
  }

  // Delete BEFORE issuing anything — first exchange wins, reuse fails.
  await storage.deleteRefresh(deps.platform, coreId, params.refresh_token);

  if (params.client_id !== row.clientId) {
    return { ok: false, status: 400, error: 'invalid_grant', description: 'client_id mismatch' };
  }

  // Mint a fresh access via the injected callback.
  const { accessTokenTTL, refreshTokenTTL } = lifetimes(deps.config);
  const now = Date.now();
  const accessExpiresAt = now + accessTokenTTL * 1000;
  let access;
  try {
    access = await deps.mintRefreshedAccess({
      userId: row.userId,
      username: row.username,
      clientId: row.clientId,
      scope: row.scope,
      expiresAt: accessExpiresAt,
    });
  } catch (err: any) {
    return {
      ok: false,
      status: 500,
      error: 'server_error',
      description: 'failed to mint refreshed access: ' + (err && err.message ? err.message : String(err)),
    };
  }

  // Mint a new refresh token. Sliding TTL, but never past the original
  // absolute cap (RFC 6749 §6 — refresh chain ≤ original consent ceiling).
  const newRefresh = cuid();
  const newRefreshExpiresAt = Math.min(now + refreshTokenTTL * 1000, row.absoluteExpiresAt);
  if (newRefreshExpiresAt <= now) {
    // Absolute cap already past — refuse to mint a new one. The fresh
    // access we just created is still returned; the client will need to
    // re-consent for the next chain.
    return { ok: false, status: 400, error: 'invalid_grant', description: 'refresh-token absolute lifetime exceeded' };
  }
  await storage.setRefresh(deps.platform, coreId, newRefresh, {
    clientId: row.clientId,
    userId: row.userId,
    username: row.username,
    scope: row.scope,
    issuedAt: now,
    lastUsedAt: now,
    expiresAt: newRefreshExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
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
