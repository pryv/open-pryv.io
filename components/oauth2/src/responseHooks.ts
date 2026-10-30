/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: token response for registry clients.
 *
 * The RFC `scope` answer is recomputed from what was actually minted (core
 * tokens granted + the grammar's echo over the minted permissions), so a
 * user who unticked part of the offer, or narrowed the grant later, sees a
 * narrower scope. The same token list is the `scopeTokens` every hook gets.
 * Static per-client extras and the extension's `tokenResponse` fields are
 * added under the core fields.
 *
 * OpenID Connect: when `openid` was granted, the code exchange (never a
 * refresh: the nonce belongs to the authorization request) adds an
 * `id_token`, signed RS256 with the core's first signing key. Its claims are
 * the extension's `idTokenClaims` under the core's own (`iss sub aud azp exp
 * iat auth_time nonce`).
 *
 * App-account clients do not go through here: their response is unchanged.
 */

import type { OAuthClient } from './storage.ts';
import type { HookCtx, ExtPermission } from './extension.ts';
import { runHook, toClientView, RESERVED_KEYS } from './extension.ts';
import { grantedScopeTokens } from './scopeGrammar.ts';
import { loadSigningKeys, signJwt } from './signingKeys.ts';

/** Default id_token lifetime, seconds. */
export const DEFAULT_ID_TOKEN_TTL = 300;

export type RegistryGrant = {
  client: OAuthClient;
  grantType: 'authorization_code' | 'refresh_token';
  issuer: string;
  /** Read for the signing keys and `oauth:idTokenTTL`. */
  config: { get (key: string): unknown };
  coreTokens: string[];
  grammarTokens: string[];
  permissions: ExtPermission[];
  /** The id the app sees for the user (the user's stable internal id). */
  subject: string;
  /** OpenID Connect `nonce` of the authorization request. */
  nonce?: string;
  /** When the consenting user signed in (seconds). */
  authTime?: number;
};

export type RegistryResponseParts = {
  scopeTokens: string[];
  /** Fields to merge into the response (static extras, hook output, id_token). */
  extra: Record<string, unknown>;
  /** Whether a refresh token may be issued (`offline_access` granted). */
  refresh: boolean;
  /** Seconds since epoch at which the id_token expires, when one was signed. */
  idTokenExpiresAt?: number;
};

/**
 * Compute everything a registry token response adds, BEFORE any credential
 * is stored: a throwing (or timed-out) hook must leave no refresh row behind.
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
  const parts: RegistryResponseParts = { scopeTokens, extra, refresh: scopeTokens.includes('offline_access') };
  // No id_token on refresh (OpenID Connect Core §12.2 makes it optional; the
  // nonce of the original request must not be replayed).
  if (g.grantType === 'authorization_code' && scopeTokens.includes('openid')) {
    const signed = await signIdToken(g, ctx);
    extra.id_token = signed.jwt;
    parts.idTokenExpiresAt = signed.exp;
  }
  return parts;
}

/** id_token lifetime in seconds (`oauth:idTokenTTL`, positive integer, default 300). */
export function idTokenTTL (config: { get (key: string): unknown }): number {
  const ttl = Number(config.get('oauth:idTokenTTL'));
  return Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_ID_TOKEN_TTL;
}

async function signIdToken (g: RegistryGrant, ctx: HookCtx): Promise<{ jwt: string; exp: number }> {
  if (typeof g.subject !== 'string' || g.subject.length === 0) throw new Error('id_token: the grant has no subject');
  const keys = loadSigningKeys(g.config);
  if (keys.length === 0) throw new Error('id_token: no signing key configured');
  const now = Math.floor(Date.now() / 1000);
  const exp = now + idTokenTTL(g.config);
  // The hook cannot set a core claim (runHook refuses reserved keys); the core
  // claims are written last all the same.
  const claims = await runHook('idTokenClaims', ctx);
  const jwt = signJwt(keys[0], {
    ...claims,
    iss: g.issuer,
    sub: g.subject,
    aud: g.client.clientId,
    azp: g.client.clientId,
    exp,
    iat: now,
    ...(Number.isFinite(g.authTime) ? { auth_time: g.authTime } : {}),
    ...(g.nonce != null ? { nonce: g.nonce } : {}),
  });
  return { jwt, exp };
}
