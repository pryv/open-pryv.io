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
 *   - oauth-code/<code>                — 600s TTL (cluster-wide: code /token is
 *                                        core-agnostic, so any core resolves it)
 *   - oauth-refresh/<coreId>/<token>   — sliding 30d, cap 90d absolute (per-core:
 *                                        refresh re-mints via home-core storage)
 *
 * Per the no-credentials-in-PlatformDB invariant, the client row may
 * carry `clientSecretHash` (Argon2id, one-way) but never plaintext
 * secrets.
 */


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
  /**
   * DPoP binding (RFC 9449): the RFC 7638 thumbprint of the client key
   * this chain is bound to. Set at issuance when the token request
   * carried a valid DPoP proof; every rotation must present a proof by
   * the SAME key, and the re-minted access inherits the binding. Absent
   * on Bearer chains — a chain never changes kind after issuance.
   */
  jkt?: string;
}

/**
 * "Consumed marker" — a short-lived shadow of a refresh row written the moment
 * it is rotated. Its presence when a token no longer resolves distinguishes
 * genuine REUSE (a rotated token replayed) from expired/never-issued. Carries
 * only what reuse-detection needs to revoke the chain — NO live credentials.
 * TTL matches the consumed row's remaining validity (bounded growth, swept by
 * sweepExpiredAccessStates). Cluster-wide storage, per-issuing-core key.
 */
export interface OAuthRefreshUsed {
  clientId: string;
  userId: string;
  username: string;
  dataGrantAccessId?: string;
  consumedAt: number; // Date.now() at rotation — drives the grace window
}

const PREFIX_CLIENT = 'oauth-client/';
const PREFIX_CLIENT_REVOKED = 'oauth-client-revoked/';
const PREFIX_CODE = 'oauth-code/';
const PREFIX_REFRESH = 'oauth-refresh/';
const PREFIX_REFRESH_USED = 'oauth-refresh-used/';
const PREFIX_DPOP_JTI = 'dpop-jti/';
const PREFIX_DPOP_JKT_REVOKED = 'dpop-jkt-revoked/';
const PREFIX_DPOP_JKT_SEEN = 'dpop-jkt-seen/';

// An RFC 7638 thumbprint is base64url(SHA-256(jwk)) — 32 bytes → exactly 43
// unpadded base64url chars. Guarding writes on this shape means a typo'd jkt
// fails loud at the operator CLI instead of silently tombstoning nothing.
const JKT_RE = /^[A-Za-z0-9_-]{43}$/;

// --- Client metadata (indefinite, cluster-wide) --- //

export async function setClient (platform: PlatformDB, client: OAuthClient): Promise<void> {
  const payload = { ...client, clientId: client.clientId, updatedAt: client.updatedAt || Date.now() };
  await platform.setPlatformKv(PREFIX_CLIENT + client.clientId, JSON.stringify(payload));
  // NB: re-registering a revoked client id does NOT clear the tombstone. The
  // revoke is a token EPOCH (`revokedAt`): tokens minted BEFORE it stay dead,
  // tokens minted AFTER (a fresh registration mints new ones) are honoured — so
  // a compromised app's old sessions can't be resurrected by re-using its id,
  // and a concurrent revoke-vs-re-register can't lose the revoke.
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
  // Deleting the client row stops NEW grants + kills refresh; the tombstone
  // (below) is what makes the operator revoke reach LIVE access tokens
  // cluster-wide — the resource server rejects any oauth-session access whose
  // client is tombstoned (checked lazily, per-core cached). Cross-core-safe:
  // it is a PlatformDB write each core reads locally (cores are independent,
  // no cross-core bus).
  await platform.setPlatformKv(PREFIX_CLIENT_REVOKED + clientId, JSON.stringify({ revokedAt: Date.now() }));
  await platform.deletePlatformKv(PREFIX_CLIENT + clientId);
}

export async function listClientIds (platform: PlatformDB): Promise<string[]> {
  const keys = await platform.listPlatformKvKeys(PREFIX_CLIENT);
  return keys.map((k) => k.slice(PREFIX_CLIENT.length)).sort();
}

// --- Client revoke tombstones (indefinite, cluster-wide) --- //
//
// A tombstone marks a clientId whose LIVE access tokens must stop working, even
// before they expire. `deleteClient` writes it; `setClient` (re-register) does
// NOT clear it — the revoke is a token epoch, see the note in `setClient`. The
// resource-server validation path consults these (per-core cached) to reject a
// revoked client's oauth-session accesses minted before the epoch.

/** The revoke epoch (ms) for a clientId, or null if it carries no tombstone. */
export async function getRevokedAt (platform: PlatformDB, clientId: string): Promise<number | null> {
  if (typeof clientId !== 'string' || clientId.length === 0) return null;
  const raw = await platform.getPlatformKv(PREFIX_CLIENT_REVOKED + clientId);
  if (raw == null) return null;
  try { const at = Number(JSON.parse(raw).revokedAt); return Number.isFinite(at) ? at : 0; } catch { return 0; }
}

/** True when the clientId carries a revoke tombstone (any epoch). */
export async function isClientRevoked (platform: PlatformDB, clientId: string): Promise<boolean> {
  return (await getRevokedAt(platform, clientId)) != null;
}

/** All tombstoned clients with their revoke epochs (the per-core cache loads this). */
export async function listRevokedClients (platform: PlatformDB): Promise<Array<{ clientId: string; revokedAt: number }>> {
  const keys = await platform.listPlatformKvKeys(PREFIX_CLIENT_REVOKED);
  const out: Array<{ clientId: string; revokedAt: number }> = [];
  for (const key of keys) {
    const clientId = key.slice(PREFIX_CLIENT_REVOKED.length);
    const raw = await platform.getPlatformKv(key);
    let revokedAt = 0;
    try { revokedAt = Number(JSON.parse(raw ?? '{}').revokedAt) || 0; } catch { revokedAt = 0; }
    out.push({ clientId, revokedAt });
  }
  return out;
}

/** All currently-tombstoned client ids (CLI listing / prune). */
export async function listRevokedClientIds (platform: PlatformDB): Promise<string[]> {
  const keys = await platform.listPlatformKvKeys(PREFIX_CLIENT_REVOKED);
  return keys.map((k) => k.slice(PREFIX_CLIENT_REVOKED.length));
}

/**
 * Drop tombstones older than `maxAgeMs` — a revoked client's tokens are all
 * expired by then, so the marker's job is done. Optional housekeeping; the
 * set is tiny, so this is not required for correctness. Returns the count pruned.
 */
export async function pruneRevokedClients (platform: PlatformDB, maxAgeMs: number, now: number = Date.now()): Promise<number> {
  const keys = await platform.listPlatformKvKeys(PREFIX_CLIENT_REVOKED);
  let pruned = 0;
  for (const key of keys) {
    const raw = await platform.getPlatformKv(key);
    let revokedAt = 0;
    try { revokedAt = Number(JSON.parse(raw ?? '{}').revokedAt) || 0; } catch { revokedAt = 0; }
    if (now - revokedAt > maxAgeMs) { await platform.deletePlatformKv(key); pruned++; }
  }
  return pruned;
}

// --- Authorization codes (CLUSTER-WIDE, ≤10-min TTL) --- //
//
// The code key is intentionally NOT namespaced by core:id. `/oauth2/token`
// (code grant) touches no per-user storage — it returns the access already
// minted at `/accept` (accessToken + home-core apiEndpoint live in this row).
// So the exchange is a pure lookup in the cluster-wide PlatformDB and any core
// can serve it. Keying by the minting core's id would strand a `/token` that a
// load balancer routes to a different core than `/accept` (both derive from the
// same issuer, but the LB need not pin them together). The code value is a
// cryptographically-random token, so a cross-core collision is negligible, and
// single-use stays atomic cluster-wide via consumeAccessState. (Refresh KEEPS
// the per-core key — its exchange re-mints via the user's home-core storage, so
// it is inherently home-core-pinned; see below.)

export async function setCode (
  platform: PlatformDB, code: string, payload: OAuthCode,
): Promise<void> {
  await platform.setAccessState(
    codeKey(code),
    payload,
    payload.expiresAt,
  );
}

export async function getCode (platform: PlatformDB, code: string): Promise<OAuthCode | null> {
  const entry = await platform.getAccessState(codeKey(code));
  return entry == null ? null : (entry.value as OAuthCode);
}

export async function deleteCode (platform: PlatformDB, code: string): Promise<void> {
  await platform.deleteAccessState(codeKey(code));
}

/**
 * Atomic single-use consume of an authorization code: returns the row AND
 * deletes it in one linearized op, or null if absent/expired/already used.
 * Use this instead of getCode + deleteCode — those race, letting two
 * concurrent `/token` submissions of one code both mint a chain.
 */
export async function consumeCode (platform: PlatformDB, code: string): Promise<OAuthCode | null> {
  const entry = await platform.consumeAccessState(codeKey(code));
  return entry == null ? null : (entry.value as OAuthCode);
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

/**
 * Atomic single-use consume of a refresh token: returns the row AND deletes
 * it in one linearized op, or null if absent/expired/already rotated. Use
 * this instead of getRefresh + deleteRefresh — those race, letting two
 * concurrent refreshes both mint a new chain and defeating reuse-detection.
 */
export async function consumeRefresh (platform: PlatformDB, coreId: string, token: string): Promise<OAuthRefresh | null> {
  const entry = await platform.consumeAccessState(refreshKey(coreId, token));
  return entry == null ? null : (entry.value as OAuthRefresh);
}

// --- Reuse-detection consumed marker (short-lived shadow of a rotated refresh) --- //

/**
 * Record that a refresh token was just consumed (rotated). `expiresAt` should be
 * the SOONER of the consumed row's sliding + absolute expiry, so the marker lives
 * exactly as long as the token would have remained valid — past that, a replay is
 * indistinguishable from expired and correctly classified as such.
 */
export async function markRefreshConsumed (
  platform: PlatformDB, coreId: string, token: string, payload: OAuthRefreshUsed, expiresAt: number,
): Promise<void> {
  await platform.setAccessState(refreshUsedKey(coreId, token), payload, expiresAt);
}

/** Non-consuming read of the consumed marker (repeat replays must each re-detect). */
export async function getRefreshConsumed (platform: PlatformDB, coreId: string, token: string): Promise<OAuthRefreshUsed | null> {
  const entry = await platform.getAccessState(refreshUsedKey(coreId, token));
  return entry == null ? null : (entry.value as OAuthRefreshUsed);
}

/**
 * DPoP jti single-use marker (RFC 9449 §11.1 replay prevention). Atomic
 * first-writer-wins: returns true when THIS call recorded the jti,
 * false when it was already seen — two concurrent identical proofs
 * yield exactly one true. TTL covers the proof's iat acceptance window;
 * past it the iat check rejects the replay anyway. Swept with the rest
 * of the access-state keyspace.
 */
export async function markDPoPJtiUsed (
  platform: PlatformDB, jkt: string, jti: string, expiresAt: number,
): Promise<boolean> {
  return platform.setAccessStateIfAbsent(PREFIX_DPOP_JTI + jkt + '/' + jti, 1, expiresAt);
}

// --- DPoP key revoke tombstones (indefinite, cluster-wide) --- //
//
// An operator can revoke a specific DPoP key thumbprint (jkt) — e.g. a leaked
// device key — so every access bound to that key stops working cluster-wide,
// even before its token expires. The tombstone is written to PlatformDB (the
// only cross-core mechanism the independent-cores design allows) and read
// locally by each core (per-core cached, see revokedKeysCache.ts).
//
// Semantics are PRESENCE (blocklist), NOT the token-EPOCH used for client
// revoke: a clientId is a re-assignable name (re-registration is a fresh trust
// decision whose new tokens must live), but a jkt IS the key itself. There is
// no legitimate "re-register the same key" — legitimate rotation means a NEW
// key. So any token bound to a tombstoned jkt is dead regardless of when it was
// minted; a refresh-rotation after the revoke that re-mints on the same key is
// still refused (an epoch check would have honoured it — a fail-open we avoid).
// The stored `revokedAt` is used only for CLI display and the age-based prune.

/**
 * Tombstone a DPoP key thumbprint. Throws on a malformed jkt so an operator
 * typo can't silently write a tombstone that protects nothing.
 */
export async function revokeDpopKey (platform: PlatformDB, jkt: string): Promise<void> {
  if (typeof jkt !== 'string' || !JKT_RE.test(jkt)) {
    throw new Error('revokeDpopKey: jkt must be a 43-char base64url RFC 7638 thumbprint');
  }
  await platform.setPlatformKv(PREFIX_DPOP_JKT_REVOKED + jkt, JSON.stringify({ revokedAt: Date.now() }));
}

/** Remove a DPoP key tombstone — operator recovery from a mistaken revoke. */
export async function unrevokeDpopKey (platform: PlatformDB, jkt: string): Promise<void> {
  if (typeof jkt !== 'string' || !JKT_RE.test(jkt)) {
    throw new Error('unrevokeDpopKey: jkt must be a 43-char base64url RFC 7638 thumbprint');
  }
  await platform.deletePlatformKv(PREFIX_DPOP_JKT_REVOKED + jkt);
}

/** The revoke epoch (ms) for a jkt, or null if it carries no tombstone. */
export async function getDpopKeyRevokedAt (platform: PlatformDB, jkt: string): Promise<number | null> {
  if (typeof jkt !== 'string' || jkt.length === 0) return null;
  const raw = await platform.getPlatformKv(PREFIX_DPOP_JKT_REVOKED + jkt);
  if (raw == null) return null;
  try { const at = Number(JSON.parse(raw).revokedAt); return Number.isFinite(at) ? at : 0; } catch { return 0; }
}

/** True when the jkt carries a revoke tombstone (presence — the enforcement test). */
export async function isDpopKeyRevoked (platform: PlatformDB, jkt: string): Promise<boolean> {
  return (await getDpopKeyRevokedAt(platform, jkt)) != null;
}

/** All tombstoned key thumbprints with their revoke epochs (the per-core cache loads this). */
export async function listRevokedDpopKeys (platform: PlatformDB): Promise<Array<{ jkt: string; revokedAt: number }>> {
  const keys = await platform.listPlatformKvKeys(PREFIX_DPOP_JKT_REVOKED);
  const out: Array<{ jkt: string; revokedAt: number }> = [];
  for (const key of keys) {
    const jkt = key.slice(PREFIX_DPOP_JKT_REVOKED.length);
    const raw = await platform.getPlatformKv(key);
    let revokedAt = 0;
    try { revokedAt = Number(JSON.parse(raw ?? '{}').revokedAt) || 0; } catch { revokedAt = 0; }
    out.push({ jkt, revokedAt });
  }
  return out;
}

/**
 * Drop key tombstones older than `maxAgeMs`. Past the max token lifetime every
 * credential the revoke could have killed is already expired, so the marker's
 * job is done. Optional housekeeping; the set is tiny. Returns the count pruned.
 */
export async function pruneRevokedDpopKeys (platform: PlatformDB, maxAgeMs: number, now: number = Date.now()): Promise<number> {
  const keys = await platform.listPlatformKvKeys(PREFIX_DPOP_JKT_REVOKED);
  let pruned = 0;
  for (const key of keys) {
    const raw = await platform.getPlatformKv(key);
    let revokedAt = NaN;
    try { revokedAt = Number(JSON.parse(raw ?? '{}').revokedAt); } catch { revokedAt = NaN; }
    // A corrupt/unparseable tombstone is ENFORCED as revoked (fail-closed:
    // getDpopKeyRevokedAt → 0, still non-null). Keep it here too — only prune
    // rows with a real, aged epoch. Parsing a bad value to 0 would make
    // `now - 0 > maxAgeMs` always true and silently un-revoke the key.
    if (Number.isFinite(revokedAt) && revokedAt > 0 && now - revokedAt > maxAgeMs) {
      await platform.deletePlatformKv(key); pruned++;
    }
  }
  return pruned;
}

// --- DPoP key inventory (advisory, cluster-wide, pruned) --- //
//
// A denormalized record of which key thumbprints an operator has seen bound for
// each client, so `bin/oauth-client.js list-keys` can show the operator a
// pick-list to revoke from. ADVISORY ONLY — revoke-by-jkt works without it, so
// writes are best-effort (fire-and-forget at the token endpoint) and reads
// never throw. Key: `dpop-jkt-seen/<clientId>/<jkt>` (jkt is a fixed 43-char
// base64url with no '/', so it parses back unambiguously even if a clientId
// contained a '/'). Bounded by the master sweep (pruneDpopKeysSeen).

/**
 * Upsert the seen-record for (clientId, jkt): stamp `lastSeenAt`, preserve the
 * original `firstSeenAt`. Advisory — silently no-ops on a malformed input
 * rather than throwing (it must never break issuance).
 */
export async function recordDpopKeySeen (platform: PlatformDB, clientId: string, jkt: string): Promise<void> {
  if (typeof clientId !== 'string' || clientId.length === 0 || typeof jkt !== 'string' || !JKT_RE.test(jkt)) return;
  const key = PREFIX_DPOP_JKT_SEEN + clientId + '/' + jkt;
  const now = Date.now();
  let firstSeenAt = now;
  const raw = await platform.getPlatformKv(key);
  if (raw != null) {
    try { const f = Number(JSON.parse(raw).firstSeenAt); if (Number.isFinite(f) && f > 0) firstSeenAt = f; } catch { /* keep now */ }
  }
  await platform.setPlatformKv(key, JSON.stringify({ firstSeenAt, lastSeenAt: now }));
}

/** All seen (clientId, jkt) records, optionally scoped to one client. */
export async function listDpopKeysSeen (
  platform: PlatformDB, clientId?: string,
): Promise<Array<{ clientId: string; jkt: string; firstSeenAt: number; lastSeenAt: number }>> {
  const scan = clientId != null && clientId.length > 0
    ? PREFIX_DPOP_JKT_SEEN + clientId + '/'
    : PREFIX_DPOP_JKT_SEEN;
  const keys = await platform.listPlatformKvKeys(scan);
  const out: Array<{ clientId: string; jkt: string; firstSeenAt: number; lastSeenAt: number }> = [];
  for (const key of keys) {
    const rest = key.slice(PREFIX_DPOP_JKT_SEEN.length); // <clientId>/<jkt>
    if (rest.length < 45) continue; // at least 1-char clientId + '/' + 43-char jkt
    const jkt = rest.slice(-43);
    const cid = rest.slice(0, -44); // drop the '/' + 43-char jkt
    const raw = await platform.getPlatformKv(key);
    let firstSeenAt = 0; let lastSeenAt = 0;
    try { const o = JSON.parse(raw ?? '{}'); firstSeenAt = Number(o.firstSeenAt) || 0; lastSeenAt = Number(o.lastSeenAt) || 0; } catch { /* zeros */ }
    out.push({ clientId: cid, jkt, firstSeenAt, lastSeenAt });
  }
  return out;
}

/**
 * Drop seen-records not touched within `maxAgeMs` — past the max token lifetime
 * a key with no recent issuance has no live tokens, so its inventory row is
 * stale. Keeps the (per-session-key) set bounded over the cluster's life.
 * Returns the count pruned.
 */
export async function pruneDpopKeysSeen (platform: PlatformDB, maxAgeMs: number, now: number = Date.now()): Promise<number> {
  const keys = await platform.listPlatformKvKeys(PREFIX_DPOP_JKT_SEEN);
  let pruned = 0;
  for (const key of keys) {
    const raw = await platform.getPlatformKv(key);
    let lastSeenAt = 0;
    try { lastSeenAt = Number(JSON.parse(raw ?? '{}').lastSeenAt) || 0; } catch { lastSeenAt = 0; }
    if (now - lastSeenAt > maxAgeMs) { await platform.deletePlatformKv(key); pruned++; }
  }
  return pruned;
}

// --- Key helpers (owned here, NOT in the engine) --- //

function codeKey (code: string): string {
  return PREFIX_CODE + code;
}

function refreshKey (coreId: string, token: string): string {
  return PREFIX_REFRESH + coreId + '/' + token;
}

function refreshUsedKey (coreId: string, token: string): string {
  return PREFIX_REFRESH_USED + coreId + '/' + token;
}
