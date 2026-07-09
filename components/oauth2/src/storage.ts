/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — typed storage layer over PlatformDB's generic primitives.
 *
 * This module owns the OAuth-specific row shapes + key namespaces and
 * consumes the engine ONLY via two generic primitives:
 *
 *   - `setAccessState` / `getAccessState` / `deleteAccessState` /
 *     `sweepExpiredAccessStates` — for TTL'd ephemeral state
 *     (authorization codes, refresh tokens). Lazy-expire built-in.
 *
 *   - `setPlatformKv` / `getPlatformKv` / `deletePlatformKv` /
 *     `listPlatformKvKeys` — for indefinite cluster-wide kv
 *     (client metadata). No TTL.
 *
 * Key prefixes are owned here, not the engine:
 *   - oauth-client/<clientId>          — indefinite
 *   - oauth-code/<coreId>/<code>       — 600s TTL
 *   - oauth-refresh/<coreId>/<token>   — sliding 30d, cap 90d absolute
 *
 * Per the no-credentials-in-PlatformDB invariant, the client row may
 * carry `clientSecretHash` (Argon2id, one-way) but never plaintext
 * secrets.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';

/** A granular Pryv permission entry, as in `accesses.create`. */
export interface GrantPermission {
  streamId: string;
  level: string;
}

/** App-account-metadata cache row (cluster-wide, indefinite). */
export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  scope: string[];
  clientName?: string;
  clientUri?: string;
  logoUri?: string;
  grantTypes: string[];
  applicationType?: 'web' | 'native';
  /**
   * bcrypt hash of the client_secret (used for client_credentials
   * grant + future confidential-client auth on the auth-code grant).
   * One-way; cluster-wide caching is safe — by design.
   */
  clientSecretHash?: string;
  jwksRef?: string;
  /**
   * Username of the Pryv user account this OAuth client is promoted
   * from (set by `bin/oauth-client.js create <username>`). Required
   * for client_credentials grant — the minted access targets THIS
   * user's per-user storage (the app's own data, no end-user involved).
   */
  accountUsername?: string;
  /**
   * Named consent-offer references for the `cmc:<name>` scope
   * namespace. Each entry points at the capability URL of an
   * open-link `consent/request-cmc` offer published by the app's
   * account; /oauth2/authorize resolves the name through this map and
   * reads the offer's granular permissions + consent texts. The
   * `cmc:<name>` token must ALSO appear in `scope` to be requestable
   * (the standard registered-scope subset check applies).
   */
  cmcOffers?: Record<string, { capabilityUrl: string }>;
  updatedAt: number;
}

/** Authorization code row (per-issuing-core, ≤10-min TTL). */
export interface OAuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  userId: string;
  username: string;
  scope: string[];
  expiresAt: number;
  /**
   * The access is created at /accept time (when the user is
   * authenticated) and these fields carry the result through to the
   * /token exchange. Optional so legacy/test rows that don't carry
   * them still parse; the grant handler defends against missing.
   */
  accessId?: string;
  accessToken?: string;
  apiEndpoint?: string;
  /**
   * Granular-grant binding (cmc scopes): the durable consent record is
   * a data-grant access on the user's account; `permissions` is the
   * granted subset the short-TTL OAuth accesses are minted with.
   * Absent on coarse-scope rows.
   */
  dataGrantAccessId?: string;
  permissions?: GrantPermission[];
}

/** Refresh-token row (per-issuing-core, sliding 30d + 90d absolute). */
export interface OAuthRefresh {
  clientId: string;
  userId: string;
  username: string;
  scope: string[];
  issuedAt: number;
  lastUsedAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  /**
   * Granular-grant binding (cmc scopes) — see OAuthCode. The refresh
   * grant re-reads the data-grant before re-minting: if it is gone
   * (revoked), the refresh chain dies with `invalid_grant`; otherwise
   * the re-mint uses `permissions` (this session's granted subset)
   * INTERSECTED with the data-grant's CURRENT permissions — consent
   * narrowing propagates at the next refresh, widening never happens
   * without a fresh consent.
   */
  dataGrantAccessId?: string;
  permissions?: GrantPermission[];
}

const PREFIX_CLIENT = 'oauth-client/';
const PREFIX_CODE = 'oauth-code/';
const PREFIX_REFRESH = 'oauth-refresh/';

// --- Client metadata (indefinite, cluster-wide) --- //

export async function setClient (platform: PlatformDB, client: OAuthClient): Promise<void> {
  const payload = { ...client, clientId: client.clientId, updatedAt: client.updatedAt || Date.now() };
  await platform.setPlatformKv(PREFIX_CLIENT + client.clientId, JSON.stringify(payload));
}

export async function getClient (platform: PlatformDB, clientId: string): Promise<OAuthClient | null> {
  if (typeof clientId !== 'string' || clientId.length === 0) return null;
  const raw = await platform.getPlatformKv(PREFIX_CLIENT + clientId);
  return raw == null ? null : JSON.parse(raw) as OAuthClient;
}

export async function deleteClient (platform: PlatformDB, clientId: string): Promise<void> {
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new Error('deleteClient: clientId required');
  }
  await platform.deletePlatformKv(PREFIX_CLIENT + clientId);
}

export async function listClientIds (platform: PlatformDB): Promise<string[]> {
  const keys = await platform.listPlatformKvKeys(PREFIX_CLIENT);
  return keys.map((k) => k.slice(PREFIX_CLIENT.length)).sort();
}

// --- Authorization codes (per-core, ≤10-min TTL) --- //

export async function setCode (
  platform: PlatformDB, coreId: string, code: string, payload: OAuthCode,
): Promise<void> {
  await platform.setAccessState(
    codeKey(coreId, code),
    payload,
    payload.expiresAt,
  );
}

export async function getCode (platform: PlatformDB, coreId: string, code: string): Promise<OAuthCode | null> {
  const entry = await platform.getAccessState(codeKey(coreId, code));
  return entry == null ? null : (entry.value as OAuthCode);
}

export async function deleteCode (platform: PlatformDB, coreId: string, code: string): Promise<void> {
  await platform.deleteAccessState(codeKey(coreId, code));
}

// --- Refresh tokens (per-core, sliding TTL with absolute cap) --- //

export async function setRefresh (
  platform: PlatformDB, coreId: string, token: string, payload: OAuthRefresh,
): Promise<void> {
  // Use the SOONER of expiresAt (sliding) and absoluteExpiresAt as the
  // access-state ttl boundary — lazy-expire then enforces both.
  const ttl = Math.min(
    typeof payload.expiresAt === 'number' ? payload.expiresAt : Number.POSITIVE_INFINITY,
    typeof payload.absoluteExpiresAt === 'number' ? payload.absoluteExpiresAt : Number.POSITIVE_INFINITY,
  );
  await platform.setAccessState(refreshKey(coreId, token), payload, ttl);
}

export async function getRefresh (platform: PlatformDB, coreId: string, token: string): Promise<OAuthRefresh | null> {
  const entry = await platform.getAccessState(refreshKey(coreId, token));
  return entry == null ? null : (entry.value as OAuthRefresh);
}

export async function deleteRefresh (platform: PlatformDB, coreId: string, token: string): Promise<void> {
  await platform.deleteAccessState(refreshKey(coreId, token));
}

// --- Key helpers (owned here, NOT in the engine) --- //

function codeKey (coreId: string, code: string): string {
  return PREFIX_CODE + coreId + '/' + code;
}

function refreshKey (coreId: string, token: string): string {
  return PREFIX_REFRESH + coreId + '/' + token;
}
