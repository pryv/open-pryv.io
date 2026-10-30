/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — App-account client registry.
 *
 * Reads from the PlatformDB cache row at key `oauth-client/<clientId>`
 * via the storage.ts wrapper (NOT directly from the App-account
 * `:_app:*` streams). The cache row is the cluster-wide source of
 * truth for /oauth2/authorize validation on ANY core (the multi-core
 * discovery-before-session-creation invariant).
 *
 * Write side (called only from the operator CLI, `bin/oauth-client.js`;
 * the HTTP `POST /oauth2/register` endpoint is intentionally deferred)
 * writes the PlatformDB row only: this module validates it and forwards
 * it to storage. No App-account stream is written.
 *
 * Operator policy: `curated` registration mode only.
 * Errors are mapped at endpoint edge via `errorMap.ts`, NOT
 * auto-derived.
 */

import { createRequire } from 'node:module';

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient } from './storage.ts';
import { validatePublicJwkSet } from './jwks.ts';
const require = createRequire(import.meta.url);

const storage = require('./storage.ts');

/**
 * Look up a client by `client_id`. Returns null if no such client
 * is registered (caller maps to `invalid_client` / `unknown-client`).
 */
export async function getClient (platform: PlatformDB, clientId: string): Promise<OAuthClient | null> {
  return storage.getClient(platform, clientId);
}

/**
 * Validate a presented redirect_uri against a client's registered set.
 * RFC 9700 §2.1 + RFC 8252 §7.5: exact string match, ONE carve-out:
 * loopback addresses (`127.0.0.1`, `[::1]`) may vary port.
 *
 * No regex, no prefix matching, no scheme normalization. Phishers
 * exploit lax matching.
 */
export function validateRedirectUri (registered: string[], presented: string): boolean {
  if (!Array.isArray(registered) || registered.length === 0) return false;
  if (typeof presented !== 'string' || presented.length === 0) return false;
  // RFC 6749 §3.1.2: a redirect_uri MUST NOT carry a fragment. Reject at the
  // authorize gate too (registration already rejects it) — defense-in-depth so
  // a fragment URI can never be accepted even if one slipped into storage.
  if (presented.includes('#')) return false;

  for (const r of registered) {
    if (r === presented) return true;
    if (matchLoopback(r, presented)) return true;
  }
  return false;
}

/**
 * Loopback carve-out — `http://127.0.0.1/cb` registered matches
 * `http://127.0.0.1:<any-port>/cb` presented. Same for `[::1]`.
 * Exact match on everything else (scheme, host, userinfo, path,
 * query, fragment) — RFC 8252 §7.3 relaxes ONLY the port.
 */
function matchLoopback (registered: string, presented: string): boolean {
  let r: URL; let p: URL;
  try { r = new URL(registered); p = new URL(presented); } catch { return false; }
  if (r.protocol !== 'http:') return false; // loopback carve-out is HTTP only (RFC 8252 §7.3)
  if (r.protocol !== p.protocol) return false;
  if (r.hostname !== p.hostname) return false;
  if (r.hostname !== '127.0.0.1' && r.hostname !== '[::1]') return false;
  // port may differ — that's the carve-out.
  if (r.username !== p.username) return false;
  if (r.password !== p.password) return false;
  if (r.pathname !== p.pathname) return false;
  if (r.search !== p.search) return false;
  if (r.hash !== p.hash) return false;
  return true;
}

/**
 * Persist a client (cluster-wide) — called from the CLI write path
 * AFTER the App-account `:_app:*` streams have been updated. The
 * dual-write is atomic at the CLI layer; this module owns the
 * cache-row format + validation.
 */
export async function persistClient (platform: PlatformDB, client: OAuthClient): Promise<void> {
  if (typeof client?.clientId !== 'string' || client.clientId.length === 0) {
    throw new Error('clientId required');
  }
  if (!Array.isArray(client.redirectUris) || client.redirectUris.length === 0) {
    throw new Error('redirectUris required (at least one)');
  }
  for (const uri of client.redirectUris) {
    if (typeof uri !== 'string' || uri.length === 0) {
      throw new Error('redirectUris: each entry must be a non-empty string');
    }
    // RFC 6749 §3.1.2: the redirection endpoint URI MUST NOT include a
    // fragment. authorize appends `?code=…&state=…`; on a fragment URI that
    // query lands INSIDE the fragment (`…#frag?code=…`) and the browser never
    // sends `code` to the server — the flow silently breaks. Reject at
    // registration so a mis-registered client fails loud, not at redeem time.
    if (uri.includes('#')) {
      throw new Error(`redirectUris: "${uri}" must not contain a fragment (#) — RFC 6749 §3.1.2`);
    }
  }
  if (!Array.isArray(client.grantTypes) || client.grantTypes.length === 0) {
    throw new Error('grantTypes required (at least one)');
  }
  if (client.kind === 'registry') {
    validateRegistryClient(client);
  } else {
    validateCmcOffers(client);
  }
  const validated = { ...client, updatedAt: Date.now() };
  // Inline public JWK Set (private_key_jwt): validate on write — EC P-256
  // public keys ONLY; any key carrying a private `d` is rejected outright,
  // so the no-credentials-in-PlatformDB invariant holds. Store the
  // sanitized set (only accepted members survive).
  if (validated.jwks != null) {
    try {
      validated.jwks = validatePublicJwkSet(validated.jwks);
    } catch (err) {
      throw new Error(`jwks: ${(err as Error).message}`);
    }
  }
  await storage.setClient(platform, validated);
}

/**
 * `cmcOffers` consistency rules, enforced at registration so authorize
 * never hits a dangling reference:
 *   - each offer name matches the `cmc:<name>` token grammar;
 *   - each capabilityUrl is an absolute https URL carrying the
 *     capability token as userinfo (`https://<token>@<host>/`);
 *   - every `cmc:<name>` token in `scope` has a matching offer entry.
 */
function validateCmcOffers (client: OAuthClient): void {
  const { isValidCmcOfferName } = require('./scopeRegistry.ts');
  const offers = client.cmcOffers ?? {};
  if (typeof offers !== 'object' || Array.isArray(offers)) {
    throw new Error('cmcOffers must be an object map of name → { capabilityUrl }');
  }
  for (const [name, entry] of Object.entries(offers)) {
    if (!isValidCmcOfferName(name)) {
      throw new Error(`cmcOffers: invalid offer name "${name}"`);
    }
    const capabilityUrl = (entry as { capabilityUrl?: unknown })?.capabilityUrl;
    if (typeof capabilityUrl !== 'string' || capabilityUrl.length === 0) {
      throw new Error(`cmcOffers["${name}"]: capabilityUrl required`);
    }
    let u: URL;
    try { u = new URL(capabilityUrl); } catch {
      throw new Error(`cmcOffers["${name}"]: capabilityUrl is not a valid URL`);
    }
    if (u.protocol !== 'https:' || u.username.length === 0) {
      throw new Error(`cmcOffers["${name}"]: capabilityUrl must be https with the capability token as userinfo (https://<token>@<host>/)`);
    }
  }
  for (const token of (client.scope ?? [])) {
    if (typeof token === 'string' && token.startsWith('cmc:')) {
      const name = token.slice('cmc:'.length);
      if (offers[name] == null) {
        throw new Error(`scope token "${token}" has no matching cmcOffers["${name}"] entry`);
      }
    }
  }
}

const AUTH_METHODS = ['none', 'client_secret_basic', 'private_key_jwt'];

/**
 * Rules for a registry client (operator-registered, no app account). Its
 * `scope` is a maximum scope set in the installed extension's grammar, which
 * the CLI process does not load: it is checked at /authorize.
 */
function validateRegistryClient (client: OAuthClient): void {
  if (client.accountUserId != null) throw new Error('registry client: accountUserId is not allowed (no app account)');
  if (client.cmcOffers != null && Object.keys(client.cmcOffers).length > 0) {
    throw new Error('registry client: cmcOffers are not allowed (offers are synthesised from the scope)');
  }
  if (!AUTH_METHODS.includes(client.tokenEndpointAuthMethod as string)) {
    throw new Error('registry client: tokenEndpointAuthMethod must be one of ' + AUTH_METHODS.join(', '));
  }
  if (client.tokenEndpointAuthMethod === 'client_secret_basic' && client.clientSecretHash == null) {
    throw new Error('registry client: client_secret_basic needs a client secret');
  }
  if (client.tokenEndpointAuthMethod === 'private_key_jwt' && client.jwks == null) {
    throw new Error('registry client: private_key_jwt needs a jwks');
  }
  if (client.grantTypes.includes('client_credentials')) {
    throw new Error('registry client: client_credentials is not available (no app account)');
  }
  if (client.subjectType != null && client.subjectType !== 'public' && client.subjectType !== 'pairwise') {
    throw new Error('registry client: subjectType must be public or pairwise');
  }
  if (client.dpopBoundAccessTokens === true) {
    throw new Error('registry client: DPoP-bound tokens are not available for this kind of client');
  }
  if (!Array.isArray(client.scope) || client.scope.length === 0) {
    throw new Error('registry client: scope (the maximum scope set) is required');
  }
  const audiences = client.allowedAudiences ?? [];
  if (!Array.isArray(audiences)) throw new Error('allowedAudiences must be an array');
  if (audiences.length === 0 && client.anyAudience !== true) {
    throw new Error('registry client: at least one audience is required (or register it explicitly for any audience)');
  }
  if (audiences.length > 0 && client.anyAudience === true) {
    throw new Error('registry client: an audience list and "any audience" exclude each other');
  }
  for (const a of audiences) {
    let u: URL;
    try { u = new URL(a); } catch { throw new Error(`allowedAudiences: "${a}" is not a valid URL`); }
    if (u.protocol !== 'https:' || u.hash !== '') throw new Error(`allowedAudiences: "${a}" must be an absolute https URL without fragment`);
  }
  const insecure = insecureRedirectUris(client.redirectUris);
  if (insecure.length > 0 && client.allowInsecureRedirect !== true) {
    throw new Error('registry client: plain http redirect URIs are allowed on loopback hosts only (' + insecure.join(', ') +
      '); register the client explicitly for insecure redirects to keep them');
  }
  for (const [k, v] of Object.entries(client.tokenResponseExtras ?? {})) {
    if (!['string', 'boolean', 'number'].includes(typeof v)) throw new Error(`tokenResponseExtras["${k}"] must be a string, boolean or number`);
  }
  if (client.status != null && client.status !== 'active' && client.status !== 'suspended') {
    throw new Error('status must be active or suspended');
  }
  if (client.allowFeatures != null) {
    if (!Array.isArray(client.allowFeatures) ||
        client.allowFeatures.some((f) => !REGISTRY_DEFAULT_FORBIDDEN_FEATURES.includes(f))) {
      throw new Error('registry client: allowFeatures may only list ' + REGISTRY_DEFAULT_FORBIDDEN_FEATURES.join(', '));
    }
  }
}

/**
 * Features a registry client's grant forbids unless the client row lists them
 * in `allowFeatures`: the core applies them after every consent (never shown
 * on the consent screen; a forbid always wins over an allow).
 */
export const REGISTRY_DEFAULT_FORBIDDEN_FEATURES: readonly string[] = Object.freeze(['webhooks', 'secretSharing']);

/** The default forbids that apply to this registry client. */
export function defaultForbiddenFeatures (client: OAuthClient): string[] {
  const allowed = Array.isArray(client.allowFeatures) ? client.allowFeatures : [];
  return REGISTRY_DEFAULT_FORBIDDEN_FEATURES.filter((f) => !allowed.includes(f));
}

const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];

/**
 * The plain-http redirect URIs of a list that do not point at the loopback
 * host (anything an on-path attacker could read the code from). Other
 * schemes (https, a native app's private scheme) are not concerned.
 */
export function insecureRedirectUris (uris: string[] | undefined): string[] {
  return (uris ?? []).filter((uri) => {
    let u: URL;
    try { u = new URL(uri); } catch { return false; }
    return u.protocol === 'http:' && !LOOPBACK_HOSTS.includes(u.hostname);
  });
}

/** Whether a client is registered without an app account. */
export function isRegistryClient (client: OAuthClient | null | undefined): boolean {
  return client?.kind === 'registry';
}

/**
 * Remove a client from the cache — called from the CLI revoke path.
 * Idempotent on a missing client.
 */
export async function removeClient (platform: PlatformDB, clientId: string): Promise<void> {
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new Error('clientId required');
  }
  await storage.deleteClient(platform, clientId);
}

/**
 * List registered clientIds. Used by the CLI `list` subcommand.
 */
export async function listClientIds (platform: PlatformDB): Promise<string[]> {
  return storage.listClientIds(platform);
}
