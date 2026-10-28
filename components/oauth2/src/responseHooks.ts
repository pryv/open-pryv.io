/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — token response for registry clients.
 *
 * The RFC `scope` answer is recomputed from what was actually minted (core
 * tokens granted + the grammar's echo over the minted permissions), so a
 * user who unticked part of the offer, or narrowed the grant later, sees a
 * narrower scope. The same token list is the `scopeTokens` every hook gets.
 * Static per-client extras and the extension's `tokenResponse` fields are
 * added under the core fields; `apiEndpoint` (it names the account) is sent
 * only when the app sees the username, never with a pseudonym; `id_token` is
 * added when `openid` was granted.
 *
 * App-account clients do not go through here: their response is unchanged.
 */

import { createRequire } from 'node:module';
import type { OAuthClient } from './storage.ts';
import type { HookCtx, ExtPermission } from './extension.ts';
const require = createRequire(import.meta.url);

const { runHook, toClientView, RESERVED_KEYS } = require('./extension.ts');
const { grantedScopeTokens } = require('./scopeGrammar.ts');
const { loadSigningKeys, signJwt } = require('./signingKeys.ts');

export type RegistryGrant = {
  client: OAuthClient;
  grantType: 'authorization_code' | 'refresh_token';
  issuer: string;
  config: { get (key: string): unknown };
  coreTokens: string[];
  grammarTokens: string[];
  permissions: ExtPermission[];
  /** The id the app sees for the user (alias or username); null when none. */
  subject: string | null;
  nonce?: string;
};

export type RegistryResponseParts = {
  scopeTokens: string[];
  /** Fields to merge into the response (extras, hook output, id_token). */
  extra: Record<string, unknown>;
  /** Whether a refresh token may be issued (`offline_access` granted). */
  refresh: boolean;
};

/**
 * Compute everything a registry token response adds, BEFORE any credential
 * is stored: a throwing hook must leave no refresh row behind.
 */
export async function prepareRegistryResponse (g: RegistryGrant): Promise<RegistryResponseParts> {
  const scopeTokens: string[] = grantedScopeTokens(g.client, g.coreTokens, g.grammarTokens, g.permissions);
  const ctx: HookCtx = {
    clientId: g.client.clientId,
    client: toClientView(g.client),
    subject: g.subject,
    grantType: g.grantType,
    scopeTokens,
    permissions: g.permissions,
    issuer: g.issuer,
  };
  const staticExtras = { ...(g.client.tokenResponseExtras ?? {}) } as Record<string, unknown>;
  for (const k of RESERVED_KEYS.tokenResponse) delete staticExtras[k];
  const extra: Record<string, unknown> = { ...staticExtras, ...(await runHook('tokenResponse', ctx)) };

  // No id_token on refresh: OpenID Connect would want the original nonce.
  if (g.grantType === 'authorization_code' && scopeTokens.includes('openid')) {
    extra.id_token = await signIdToken(g, ctx);
  }
  return { scopeTokens, extra, refresh: scopeTokens.includes('offline_access') };
}

async function signIdToken (g: RegistryGrant, ctx: HookCtx): Promise<string> {
  if (g.subject == null) throw new Error('id_token: the grant has no subject');
  const keys = loadSigningKeys(g.config);
  if (keys.length === 0) throw new Error('id_token: no signing key configured');
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(g.config.get('oauth:idTokenTTL') ?? 300);
  const claims = await runHook('idTokenClaims', ctx);
  return signJwt(keys[0], {
    ...claims,
    iss: g.issuer,
    sub: g.subject,
    aud: g.client.clientId,
    exp: now + ttl,
    iat: now,
    ...(g.nonce != null ? { nonce: g.nonce } : {}),
  });
}
