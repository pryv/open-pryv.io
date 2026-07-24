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

import crypto from 'node:crypto';
import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import { generateToken } from '../secureToken.ts';
import * as storage from '../storage.ts';
import type { OAuthCode } from '../storage.ts';
import { audit } from '../audit.ts';
import { getClient } from '../clientRegistry.ts';
import { authenticateClient } from '../clientSecret.ts';
import { tokenEndpointAudiences } from '../issuer.ts';
import { revokeOrphanAccess } from '../orphanAccess.ts';

export type AuthCodeDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  /**
   * Required when the exchange carries a verified DPoP proof: writes
   * the key-thumbprint binding onto the access pre-minted at /accept.
   * The dispatcher guarantees it is present whenever dpopJkt is.
   */
  bindAccessDpop?: (params: {
    userId: string; username: string; accessId: string; jkt: string;
  }) => Promise<void>;
};

export type GrantParams = {
  code?: string;
  code_verifier?: string;
  client_id?: string;
  redirect_uri?: string;
  /** Confidential-client auth (client_secret_post). */
  client_secret?: string;
  /** Decoded Authorization: Basic credentials, when present (client_secret_basic). */
  basic?: { client_id: string; client_secret: string } | null;
  /** Confidential-client auth (private_key_jwt, RFC 7521/7523). */
  client_assertion?: string;
  client_assertion_type?: string;
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
  /** RFC 7638 thumbprint of a proof VERIFIED by the dispatcher, or null. */
  dpopJkt: string | null = null,
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

  // ATOMIC single-use: consume deletes-and-returns in one linearized op, so
  // two concurrent `/token` submissions of the same code cannot both win —
  // exactly one gets the row, the other gets null. (getCode + deleteCode
  // raced: both reads saw the row before either deleted.)
  const row = await storage.consumeCode(deps.platform, params.code);
  if (row == null) {
    // Either expired/never-issued OR already-exchanged. We can't tell
    // them apart cheaply; the reuse-detection signal arrives by storing
    // recently-consumed codes in a short-TTL keyspace in a follow-up.
    // Nothing was consumed here, so there is no orphaned access to revoke.
    await audit('oauth.code.reused', { clientId: params.client_id, codeId: params.code });
    return { ok: false, status: 400, error: 'invalid_grant', description: 'code is invalid or already used' };
  }

  // Past this point the code IS consumed (single-use): the access pre-minted
  // at /accept is now orphaned unless this exchange succeeds. completeExchange
  // runs the rest of the flow; the single guarded exit below then revokes that
  // orphan on ANY failure return — present or future branch — so an abandoned
  // access is not left alive until its own TTL. The success path returns the
  // access to the client, so it is (correctly) not revoked. Revoke only when
  // the row carries complete access details (the missing-details 500 has
  // nothing complete to delete).
  const outcome = await completeExchange(row);
  if (!outcome.ok && row.accessId != null && row.accessToken != null && row.apiEndpoint != null) {
    await revokeOrphanAccess({ apiEndpoint: row.apiEndpoint, accessToken: row.accessToken, accessId: row.accessId });
  }
  return outcome;

  async function completeExchange (row: OAuthCode): Promise<
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; status: number; error: string; description?: string }
  > {
    // PKCE: SHA256(code_verifier) base64url == row.codeChallenge.
    const computed = crypto.createHash('sha256').update(params.code_verifier as string).digest('base64')
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

    // Confidential-client authentication (RFC 6749 §4.1.3): a client that
    // has a client_secret on file MUST present it. Discovery advertises
    // `client_secret_basic` + `none`; PKCE is mandatory for every client,
    // so a public client (no secret on file) needs no secret here. When
    // Basic credentials are presented their client_id must match.
    if (params.basic != null && params.basic.client_id !== params.client_id) {
      return { ok: false, status: 401, error: 'invalid_client', description: 'client_id mismatch between request and Basic authorization' };
    }
    const client = await getClient(deps.platform, params.client_id as string);
    const presentedSecret = params.basic?.client_secret ?? params.client_secret;
    const auth = await authenticateClient({
      client,
      clientId: params.client_id as string,
      presentedSecret,
      assertion: params.client_assertion,
      assertionType: params.client_assertion_type,
      platform: deps.platform,
      expectedAudiences: tokenEndpointAudiences(deps.config),
    });
    if (!auth.ok) {
      return { ok: false, status: auth.status, error: auth.error, description: auth.description };
    }

    if (!row.accessToken || !row.accessId || !row.apiEndpoint) {
      // Should not happen if accept.ts ran cleanly. Defensive guard so a
      // future refactor doesn't silently return a half-formed response.
      return { ok: false, status: 500, error: 'server_error', description: 'code row missing access details (accept-time provisioning skipped?)' };
    }

    // DPoP binding (RFC 9449 §5): stamp the pre-minted access with the
    // proof key's thumbprint BEFORE issuing any credential — a binding
    // failure must not leave a bound-looking chain with an unbound
    // access. On failure the code is already consumed (single-use); the
    // client re-authorizes, which is the safe direction.
    if (dpopJkt != null) {
      if (typeof deps.bindAccessDpop !== 'function') {
        return { ok: false, status: 500, error: 'server_error', description: 'DPoP binding is not wired on this deployment' };
      }
      try {
        await deps.bindAccessDpop({ userId: row.userId, username: row.username, accessId: row.accessId, jkt: dpopJkt });
      } catch {
        return { ok: false, status: 500, error: 'server_error', description: 'failed to bind the access to the DPoP key' };
      }
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
      ...(dpopJkt != null ? { jkt: dpopJkt } : {}),
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
      ...(dpopJkt != null ? { dpopJkt } : {}),
    });

    return {
      ok: true,
      body: {
        access_token: row.accessToken,
        token_type: dpopJkt != null ? 'DPoP' : 'Bearer',
        expires_in: accessTokenTTL,
        refresh_token: refreshToken,
        scope: row.scope.join(' '),
        apiEndpoint: row.apiEndpoint,
      },
    };
  }
}
