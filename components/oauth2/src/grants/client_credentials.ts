/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `grant_type=client_credentials` handler.
 *
 * Server-to-server flow. The OAuth client authenticates with its
 * client_id + client_secret (HTTP Basic per RFC 6749 §2.3.1, OR
 * client_secret_post in the body — both supported). The minted access
 * targets the App account's OWN underlying user — the app accesses
 * its own data; no end-user is involved.
 *
 * Per RFC 6749 §4.4.3: no refresh token issued. Repeat client_credentials
 * if the access expires.
 *
 * Scope (opaque raw tokens — the minted access always targets the
 * app's OWN account; permissions are fixed by the mint callback):
 *   - Body MAY include `scope` to request a narrower subset of the
 *     client's registered scopes.
 *   - Empty / missing → granted = registered scope minus cmc:* refs.
 *   - Anything outside the registered set, or any cmc:<offer-name>
 *     user-consent reference → invalid_scope.
 */

import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import { verifySecret } from '../clientSecret.ts';
import { getClient } from '../clientRegistry.ts';
import { audit } from '../audit.ts';
import { logServerError } from '../serverLog.ts';

/** Callback shape — same as refresh's mintRefreshedAccess (storage-direct). */
export type MintClientAccess = (params: {
  userId: string;
  username: string;
  clientId: string;
  scope: string[];
  expiresAt: number;
}) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;

/** Resolve the App account's username → userId. */
export type ResolveAccountUserId = (username: string) => Promise<string | null>;

export type ClientCredentialsDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  mintClientAccess: MintClientAccess;
  resolveAccountUserId: ResolveAccountUserId;
};

export type ClientCredentialsParams = {
  /** From body (client_secret_post) — may also arrive via Authorization: Basic. */
  client_id?: string;
  client_secret?: string;
  scope?: string;
  /** Decoded Basic credentials if Authorization: Basic was used (the route extracts). */
  basic?: { client_id: string; client_secret: string } | null;
};

function lifetimes (config: { get (key: string): unknown }) {
  return {
    accessTokenTTL: Number(config.get('oauth:accessTokenTTL') ?? 3600),
  };
}

export async function handleClientCredentials (
  deps: ClientCredentialsDeps,
  params: ClientCredentialsParams,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string; description?: string }
> {
  // Auth-method precedence per RFC 6749 §2.3.1: if both Basic and body
  // are present, Basic wins.
  const clientId = params.basic?.client_id ?? params.client_id;
  const clientSecret = params.basic?.client_secret ?? params.client_secret;

  if (typeof clientId !== 'string' || clientId.length === 0) {
    return { ok: false, status: 401, error: 'invalid_client', description: 'client_id required' };
  }
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
    return { ok: false, status: 401, error: 'invalid_client', description: 'client_secret required' };
  }

  const client = await getClient(deps.platform, clientId);
  if (client == null) {
    return { ok: false, status: 401, error: 'invalid_client', description: 'unknown client' };
  }
  if (typeof client.clientSecretHash !== 'string' || client.clientSecretHash.length === 0) {
    return { ok: false, status: 401, error: 'invalid_client', description: 'client has no client_secret configured — run `bin/oauth-client.js rotate-secret`' };
  }
  if (!Array.isArray(client.grantTypes) || !client.grantTypes.includes('client_credentials')) {
    return { ok: false, status: 400, error: 'unauthorized_client', description: 'client is not registered for client_credentials grant' };
  }
  if (typeof client.accountUsername !== 'string' || client.accountUsername.length === 0) {
    return { ok: false, status: 500, error: 'server_error', description: 'client metadata missing accountUsername' };
  }

  const secretOk = await verifySecret(clientSecret, client.clientSecretHash);
  if (!secretOk) {
    return { ok: false, status: 401, error: 'invalid_client', description: 'client_secret verification failed' };
  }

  // Scope tokens are OPAQUE for this grant: the minted access always
  // manages the app's OWN account (permissions are fixed by the mint
  // callback, not scope-derived), so narrowing is a plain raw-token
  // subset check against the registered set — no grammar parse.
  const registered = new Set<string>(client.scope ?? []);
  let granted: string[];
  if (typeof params.scope === 'string' && params.scope.length > 0) {
    granted = params.scope.split(/\s+/).filter((s) => s.length > 0);
    for (const g of granted) {
      if (!registered.has(g)) {
        return { ok: false, status: 400, error: 'invalid_scope', description: `requested scope "${g}" is not registered for this client` };
      }
    }
    // cmc offer references are user-consent grants — meaningless on
    // the app's own account. Reject them when explicitly requested.
    if (granted.some((g) => g.startsWith('cmc:'))) {
      return { ok: false, status: 400, error: 'invalid_scope', description: 'cmc:<offer-name> scopes are user-consent grants; not available to client_credentials' };
    }
  } else {
    granted = [...registered].filter((g) => !g.startsWith('cmc:'));
  }

  // Resolve the App-account username → userId. The minted access
  // targets THIS user's per-user storage.
  const userId = await deps.resolveAccountUserId(client.accountUsername);
  if (userId == null) {
    return { ok: false, status: 500, error: 'server_error', description: 'accountUsername does not resolve to a known user' };
  }

  const { accessTokenTTL } = lifetimes(deps.config);
  const expiresAt = Date.now() + accessTokenTTL * 1000;
  let access;
  try {
    access = await deps.mintClientAccess({
      userId,
      username: client.accountUsername,
      clientId,
      scope: granted,
      expiresAt,
    });
  } catch (err: unknown) {
    logServerError('client_credentials: mintClientAccess failed', err);
    return {
      ok: false,
      status: 500,
      error: 'server_error',
      description: 'failed to mint access',
    };
  }

  await audit('oauth.token.issued.client_credentials', {
    clientId,
    userId, // app-account principal — this grant is user-scoped (its own trail)
    grantedScope: granted,
    accessId: access.accessId,
  });

  return {
    ok: true,
    body: {
      access_token: access.accessToken,
      token_type: 'Bearer',
      expires_in: accessTokenTTL,
      scope: granted.join(' '),
      apiEndpoint: access.apiEndpoint,
      // Per RFC 6749 §4.4.3 — no refresh_token for this grant.
    },
  };
}
