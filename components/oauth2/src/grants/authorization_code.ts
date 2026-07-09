/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `grant_type=authorization_code` handler.
 *
 * Exchange flow:
 *   1. Load the code row (key: `oauth-code/<coreId>/<code>`). The row
 *      carries the already-minted access details — see accept.ts for
 *      why creation happens at /accept, not here.
 *   2. Delete the row atomically (single-use; reuse → invalid_grant).
 *   3. Verify PKCE: SHA256(code_verifier) base64url == codeChallenge.
 *   4. Verify client_id + redirect_uri match the row.
 *   5. Mint a refresh token CUID, persist via storage.setRefresh.
 *   6. Return RFC 6749 §5.1 JSON + Pryv `apiEndpoint` extension for the
 *      multi-core home-core hint, both pulled from the stored row.
 *
 * Reuse-detection (T-05 mitigation): a second presentation of an
 * already-deleted code SHOULD trigger a cluster-wide revoke of every
 * access derived from it. That fan-out depends on the pubsub channel
 * shipped in a follow-up commit; this handler emits the audit signal
 * (`oauth.code.reused`) but does not yet revoke.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const crypto = require('node:crypto');
const { generateToken } = require('../secureToken.ts');
const storage = require('../storage.ts');
const { audit } = require('../audit.ts');

export type AuthCodeDeps = {
  config: { get (key: string): unknown };
  platform: any;
};

export type GrantParams = {
  code?: string;
  code_verifier?: string;
  client_id?: string;
  redirect_uri?: string;
};

/** Lifetimes (seconds). Operator can override via oauth.* config. */
function lifetimes (config: { get (key: string): unknown }) {
  return {
    accessTokenTTL: Number(config.get('oauth:accessTokenTTL') ?? 3600),
    refreshTokenTTL: Number(config.get('oauth:refreshTokenTTL') ?? 30 * 24 * 3600),
    refreshTokenAbsoluteTTL: Number(config.get('oauth:refreshTokenAbsoluteTTL') ?? 90 * 24 * 3600),
  };
}

/**
 * Run the grant. Returns the response body on success, or an OAuth
 * error object on failure. The caller (token.ts route) translates that
 * into the appropriate HTTP status + headers.
 */
export async function handleAuthorizationCode (
  deps: AuthCodeDeps,
  params: GrantParams,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string; description?: string }
> {
  const coreId = String(deps.config.get('core:id') ?? 'single');
  if (typeof params.code !== 'string' || params.code === '') {
    return { ok: false, status: 400, error: 'invalid_request', description: 'code is required' };
  }
  if (typeof params.code_verifier !== 'string' || params.code_verifier === '') {
    return { ok: false, status: 400, error: 'invalid_request', description: 'code_verifier is required (PKCE mandatory)' };
  }
  if (typeof params.client_id !== 'string' || params.client_id === '') {
    return { ok: false, status: 400, error: 'invalid_request', description: 'client_id is required' };
  }
  if (typeof params.redirect_uri !== 'string' || params.redirect_uri === '') {
    return { ok: false, status: 400, error: 'invalid_request', description: 'redirect_uri is required' };
  }

  const row = await storage.getCode(deps.platform, coreId, params.code);
  if (row == null) {
    // Either expired/never-issued OR already-exchanged. We can't tell
    // them apart cheaply; the reuse-detection signal arrives by storing
    // recently-consumed codes in a short-TTL keyspace in a follow-up.
    await audit('oauth.code.reused', { clientId: params.client_id, codeId: params.code });
    return { ok: false, status: 400, error: 'invalid_grant', description: 'code is invalid or already used' };
  }

  // Delete BEFORE issuing anything — first exchange wins, reuse fails.
  await storage.deleteCode(deps.platform, coreId, params.code);

  // PKCE: SHA256(code_verifier) base64url == row.codeChallenge.
  const computed = crypto.createHash('sha256').update(params.code_verifier).digest('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (computed !== row.codeChallenge) {
    return { ok: false, status: 400, error: 'invalid_grant', description: 'PKCE verification failed' };
  }

  if (params.client_id !== row.clientId) {
    return { ok: false, status: 400, error: 'invalid_grant', description: 'client_id mismatch' };
  }
  if (params.redirect_uri !== row.redirectUri) {
    return { ok: false, status: 400, error: 'invalid_grant', description: 'redirect_uri mismatch' };
  }

  if (!row.accessToken || !row.accessId || !row.apiEndpoint) {
    // Should not happen if accept.ts ran cleanly. Defensive guard so a
    // future refactor doesn't silently return a half-formed response.
    return { ok: false, status: 500, error: 'server_error', description: 'code row missing access details (accept-time provisioning skipped?)' };
  }

  // Mint refresh token. Sliding TTL with absolute cap.
  const { accessTokenTTL, refreshTokenTTL, refreshTokenAbsoluteTTL } = lifetimes(deps.config);
  const now = Date.now();
  const refreshToken = generateToken();
  await storage.setRefresh(deps.platform, coreId, refreshToken, {
    clientId: row.clientId,
    userId: row.userId,
    username: row.username,
    scope: row.scope,
    issuedAt: now,
    lastUsedAt: now,
    expiresAt: now + refreshTokenTTL * 1000,
    absoluteExpiresAt: now + refreshTokenAbsoluteTTL * 1000,
    // Granular (cmc) grants: the refresh chain stays bound to the
    // durable data-grant — refresh dies when the consent is revoked —
    // and carries this session's granted subset for the re-mints.
    ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
    ...(row.permissions != null ? { permissions: row.permissions } : {}),
  });

  await audit('oauth.code.exchanged', {
    clientId: row.clientId,
    userId: row.userId,
    codeId: params.code,
    grantedScope: row.scope,
  });
  await audit('oauth.token.issued.authorization_code', {
    clientId: row.clientId,
    userId: row.userId,
    grantedScope: row.scope,
    accessId: row.accessId,
  });

  return {
    ok: true,
    body: {
      access_token: row.accessToken,
      token_type: 'Bearer',
      expires_in: accessTokenTTL,
      refresh_token: refreshToken,
      scope: row.scope.join(' '),
      apiEndpoint: row.apiEndpoint,
    },
  };
}
