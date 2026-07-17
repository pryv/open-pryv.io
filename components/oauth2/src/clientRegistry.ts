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
 * Write side (called only from the operator CLI in this milestone;
 * the HTTP `POST /oauth2/register` endpoint is intentionally deferred)
 * updates BOTH the App-account `:_app:*` streams AND the PlatformDB
 * cache atomically. The stream-write helper is provided by the caller
 * (CLI); this module focuses on the cache-write side + the validation
 * rules.
 *
 * Operator policy: `curated` registration mode only.
 * Errors are mapped at endpoint edge via `errorMap.ts`, NOT
 * auto-derived.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient } from './storage.ts';

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
  validateCmcOffers(client);
  await storage.setClient(platform, { ...client, updatedAt: Date.now() });
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
