/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Access reverse-index — typed rows over PlatformDB's generic key/value
 * primitives (same shape as the oauth2 storage layer).
 *
 * Purpose: resolve a bare `accessId` to its owning user + a little
 * operational metadata, cluster-wide and O(1). An incident responder
 * scoping a breach typically holds only a compromised `accessId` (from a
 * SIEM correlation or a "your app was phished" report) and no username;
 * the per-user audit/access storage is keyed by user, so without this
 * index the only resolution path is an O(N) walk over every user. The
 * index makes `accessId -> user` a single cluster-wide lookup.
 *
 * Key namespace (owned here, per the caller-owns-prefix PlatformDB
 * invariant): `access-index/<baseAccessId>`. The base id (never the
 * composite `<base>:<serial>`) is the stable key across access versions.
 *
 * PII posture: PlatformDB is rqlite/Raft-replicated cluster-wide, so in a
 * multi-region cluster every row crosses every jurisdiction. This module
 * therefore joins the existing PII regime (see PiiHasher / Platform):
 *   - cleartext mode: the row carries the plaintext `username`.
 *   - hashed mode:    the row carries `usernameToken` = hashFor('username',
 *                     …) — the SAME HMAC token the `user-core/` map stores,
 *                     so token -> core resolution reuses the existing
 *                     pre-hashed lookup. No plaintext username is replicated.
 * The access `name` (user-authored free text) is deliberately NOT stored —
 * it is not needed for routing and is recoverable from the home core; and
 * the access `token` (a secret) is NEVER stored.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getLogger } = require('@pryv/boiler');
const logger = getLogger('access-index');

/** Field name used when hashing a username (stable across call sites). */
const USERNAME_FIELD = 'username';

/** Key prefix owned by this module. */
const PREFIX = 'access-index/';

/**
 * The subset of the Platform wrapper this module depends on. Structural, so
 * the module stays decoupled from the Platform class and is trivially
 * faked/injected in tests. Username hashing MUST go through `hashFor`
 * (identity in cleartext mode, HMAC in hashed mode) so the two write paths
 * (this index + `user-core/`) never drift.
 */
export interface PlatformIndexHandle {
  hashFor (field: string, value: string): string;
  readonly piiModeIsHashed: boolean;
  setPlatformKv (key: string, value: string): Promise<void>;
  getPlatformKv (key: string): Promise<string | null>;
  deletePlatformKv (key: string): Promise<void>;
  listPlatformKvKeys (prefix: string): Promise<string[]>;
}

/**
 * A raw access row (storage form) — only the fields the index reads.
 * Timestamps are Pryv unix-timestamps (SECONDS, from `timestamp.now()`), the
 * same unit carried on the access row; the index copies them verbatim so a
 * row's `created` / `lastModified` / `deleted` are all one unit.
 */
export interface AccessRowLike {
  id: string; // base access id
  type: string; // personal | app | shared
  expires?: number | null;
  created?: number; // pryv seconds
  modified?: number; // pryv seconds (last mutation)
  [k: string]: unknown;
}

/** A persisted access-index row. */
export interface AccessIndexEntry {
  accessId: string; // base id (mirrors the key, convenient for consumers)
  username?: string; // cleartext mode only
  usernameToken?: string; // hashed mode only (HMAC of username)
  type: string;
  expires?: number | null;
  created: number; // access `created` timestamp (set once)
  lastModified: number; // timestamp of the last index write (NOT last use)
  deleted?: number | null; // deletion timestamp; row RETAINED when set
  userDeleted?: boolean; // set when the owning user was erased (tombstone)
}

interface PutOptions {
  deleted?: number | null;
  /** Override lastModified (pryv seconds). Defaults to the row's `modified`/`created`. */
  lastModified?: number;
  /** Fallback timestamp (pryv seconds) used only when the row carries no `created`. */
  now?: number;
}

function keyFor (baseAccessId: string): string {
  return PREFIX + baseAccessId;
}

/** The username value stored in a row (token in hashed mode, plaintext otherwise). */
function readStoredUser (entry: AccessIndexEntry): string | null {
  return entry.usernameToken ?? entry.username ?? null;
}

/**
 * Build a complete index entry from an authoritative access row. Stateless
 * (no read-modify-write of the existing index row) so concurrent writers
 * cannot race on field preservation — `created` always comes from the
 * access row, `lastModified` from now.
 */
function buildEntry (platform: PlatformIndexHandle, username: string, row: AccessRowLike, opts: PutOptions = {}): AccessIndexEntry {
  const stored = platform.hashFor(USERNAME_FIELD, username);
  const created = typeof row.created === 'number' ? row.created : (opts.now ?? Date.now());
  const lastModified = opts.lastModified ?? (typeof row.modified === 'number' ? row.modified : created);
  const entry: AccessIndexEntry = {
    accessId: row.id,
    type: row.type,
    expires: row.expires ?? null,
    created,
    lastModified
  };
  if (platform.piiModeIsHashed) entry.usernameToken = stored;
  else entry.username = stored;
  if (opts.deleted != null) entry.deleted = opts.deleted;
  return entry;
}

/**
 * Upsert the index row for an access from its authoritative storage row.
 * Used by the create and update mutation hooks (full-row write), and by the
 * delete hook (via {@link markAccessDeletedInIndex}, which passes `deleted`).
 * Throws on a PlatformDB failure — call sites wrap in {@link safeIndexAccessMutation}.
 */
export async function putAccessIndex (platform: PlatformIndexHandle, username: string, row: AccessRowLike, opts: PutOptions = {}): Promise<void> {
  const entry = buildEntry(platform, username, row, opts);
  await platform.setPlatformKv(keyFor(row.id), JSON.stringify(entry));
}

/**
 * Mark an access deleted in the index while RETAINING the row (a breach is
 * often scoped after the access was revoked, so it must stay resolvable).
 * Writes a complete row from the authoritative access row captured at delete
 * time — so it also covers the pre-backfill case (no prior index row) without
 * a separate upsert path. Throws; wrap in {@link safeMarkAccessDeleted}.
 */
export async function markAccessDeletedInIndex (platform: PlatformIndexHandle, username: string, row: AccessRowLike, ts: number = Date.now()): Promise<void> {
  await putAccessIndex(platform, username, row, { deleted: ts, lastModified: ts });
}

/** Read one index row by BASE access id (composite ids must be normalized by the caller). */
export async function getAccessIndex (platform: PlatformIndexHandle, baseAccessId: string): Promise<AccessIndexEntry | null> {
  if (typeof baseAccessId !== 'string' || baseAccessId.length === 0) return null;
  const raw = await platform.getPlatformKv(keyFor(baseAccessId));
  return raw == null ? null : JSON.parse(raw) as AccessIndexEntry;
}

/** Enumerate every indexed base access id (retention primitive + test/backfill helper). */
export async function listAccessIndexKeys (platform: PlatformIndexHandle): Promise<string[]> {
  const keys = await platform.listPlatformKvKeys(PREFIX);
  return keys.map((k) => k.slice(PREFIX.length));
}

/**
 * Delete every index row owned by a user — the Art.17 default when a user is
 * erased. The key is the accessId, so this is a prefix scan reading each row
 * and matching the stored username token (a one-time cost paid at deletion).
 * Returns the number of rows removed.
 */
export async function deleteAccessIndexForUser (platform: PlatformIndexHandle, username: string): Promise<number> {
  const target = platform.hashFor(USERNAME_FIELD, username);
  const keys = await platform.listPlatformKvKeys(PREFIX);
  let removed = 0;
  for (const key of keys) {
    const raw = await platform.getPlatformKv(key);
    if (raw == null) continue;
    let entry: AccessIndexEntry;
    try { entry = JSON.parse(raw) as AccessIndexEntry; } catch { continue; }
    if (readStoredUser(entry) === target) {
      await platform.deletePlatformKv(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Tombstone every index row owned by a user — used instead of deletion when
 * the operator runs `audit.onUserDelete: keep`. Strips the username/token and
 * sets `userDeleted`, keeping `type` + `deleted` + timestamps so a late-
 * discovered breach can still confirm "this accessId belonged to a since-
 * erased account" (the responder then pivots to the retained home-core audit).
 * No plaintext or token username survives cluster-wide. Returns the count.
 */
export async function tombstoneAccessIndexForUser (platform: PlatformIndexHandle, username: string, ts: number = Date.now()): Promise<number> {
  const target = platform.hashFor(USERNAME_FIELD, username);
  const keys = await platform.listPlatformKvKeys(PREFIX);
  let tombstoned = 0;
  for (const key of keys) {
    const raw = await platform.getPlatformKv(key);
    if (raw == null) continue;
    let entry: AccessIndexEntry;
    try { entry = JSON.parse(raw) as AccessIndexEntry; } catch { continue; }
    if (readStoredUser(entry) !== target) continue;
    delete entry.username;
    delete entry.usernameToken;
    entry.userDeleted = true;
    entry.lastModified = ts;
    await platform.setPlatformKv(key, JSON.stringify(entry));
    tombstoned++;
  }
  return tombstoned;
}

// --- Non-fatal wrappers for the mutation hooks (R4) --- //
//
// The index is a secondary breach-scoping artefact: a PlatformDB write
// failure (e.g. rqlite quorum loss) must NEVER break access CRUD. These
// wrappers swallow errors and log them at WARN with a distinctive,
// greppable `[access-index]` marker so operators can alert on divergence;
// the backfill `--resync` path is the documented repair.

/** Non-fatal create/update index write. Never rejects. */
export async function safeIndexAccessMutation (platform: PlatformIndexHandle, username: string, row: AccessRowLike, opts: PutOptions = {}): Promise<void> {
  try {
    await putAccessIndex(platform, username, row, opts);
  } catch (err) {
    logger.warn(`[access-index] failed to index access ${row?.id} (user ${username}): ${(err as Error).message}`);
  }
}

/** Non-fatal delete index write. Never rejects. */
export async function safeMarkAccessDeleted (platform: PlatformIndexHandle, username: string, row: AccessRowLike, ts: number = Date.now()): Promise<void> {
  try {
    await markAccessDeletedInIndex(platform, username, row, ts);
  } catch (err) {
    logger.warn(`[access-index] failed to mark access ${row?.id} deleted (user ${username}): ${(err as Error).message}`);
  }
}

export { PREFIX as ACCESS_INDEX_PREFIX, keyFor as accessIndexKey, readStoredUser };
