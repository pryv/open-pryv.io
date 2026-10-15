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
const timestamp = require('unix-timestamp');
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
  listPlatformKvEntries (prefix: string): Promise<Array<{ key: string, value: string }>>;
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
  const created = typeof row.created === 'number' ? row.created : (opts.now ?? timestamp.now());
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
export async function markAccessDeletedInIndex (platform: PlatformIndexHandle, username: string, row: AccessRowLike, ts: number = timestamp.now()): Promise<void> {
  // Thread `now: ts` so the created-fallback (pre-backfill delete: no prior row,
  // no `row.created`) is written in the SAME pryv-seconds unit as `deleted`.
  await putAccessIndex(platform, username, row, { deleted: ts, lastModified: ts, now: ts });
}

/** Read one index row by BASE access id (composite ids must be normalized by the caller). */
export async function getAccessIndex (platform: PlatformIndexHandle, baseAccessId: string): Promise<AccessIndexEntry | null> {
  if (typeof baseAccessId !== 'string' || baseAccessId.length === 0) return null;
  const raw = await platform.getPlatformKv(keyFor(baseAccessId));
  return raw == null ? null : JSON.parse(raw) as AccessIndexEntry;
}

/** Remove the row of one base access id: its deletion record was purged past the retention. */
export async function deleteAccessIndexRow (platform: Pick<PlatformIndexHandle, 'deletePlatformKv'>, baseAccessId: string): Promise<void> {
  await platform.deletePlatformKv(keyFor(baseAccessId));
}

/** Enumerate every indexed base access id (retention primitive + test/backfill helper). */
export async function listAccessIndexKeys (platform: PlatformIndexHandle): Promise<string[]> {
  const keys = await platform.listPlatformKvKeys(PREFIX);
  return keys.map((k) => k.slice(PREFIX.length));
}

/**
 * Delete every index row owned by a user — the Art.17 default when a user is
 * erased. The key is the accessId, so this is a prefix scan matching the stored
 * username token, read in ONE query: a read per row would cost one network
 * round trip each on a core that is not the PlatformDB leader (minutes for a
 * few thousand rows). Returns the number of rows removed.
 */
export async function deleteAccessIndexForUser (platform: PlatformIndexHandle, username: string): Promise<number> {
  const owned = await entriesOwnedBy(platform, username);
  for (const { key } of owned) await platform.deletePlatformKv(key);
  return owned.length;
}

/** The index rows of one user, from a single prefix read. */
async function entriesOwnedBy (platform: PlatformIndexHandle, username: string): Promise<Array<{ key: string, entry: AccessIndexEntry }>> {
  const target = platform.hashFor(USERNAME_FIELD, username);
  const owned: Array<{ key: string, entry: AccessIndexEntry }> = [];
  for (const { key, value } of await platform.listPlatformKvEntries(PREFIX)) {
    let entry: AccessIndexEntry;
    try { entry = JSON.parse(value) as AccessIndexEntry; } catch { continue; }
    if (entry == null || typeof entry !== 'object') continue;
    if (readStoredUser(entry) === target) owned.push({ key, entry });
  }
  return owned;
}

/**
 * Tombstone every index row owned by a user — used instead of deletion when
 * the operator runs `audit.onUserDelete: keep`. Strips the username/token and
 * sets `userDeleted`, keeping `type` + `deleted` + timestamps so a late-
 * discovered breach can still confirm "this accessId belonged to a since-
 * erased account" (the responder then pivots to the retained home-core audit).
 * No plaintext or token username survives cluster-wide. Returns the count.
 */
export async function tombstoneAccessIndexForUser (platform: PlatformIndexHandle, username: string, ts: number = timestamp.now()): Promise<number> {
  const owned = await entriesOwnedBy(platform, username);
  for (const { key, entry } of owned) {
    delete entry.username;
    delete entry.usernameToken;
    entry.userDeleted = true;
    entry.lastModified = ts;
    await platform.setPlatformKv(key, JSON.stringify(entry));
  }
  return owned.length;
}

/**
 * Move every index row owned by `oldUsername` to `newUsername` (the
 * change-username flow): a row left under the former name would be resolved
 * to whoever holds that name next. Keeps `lastModified` (a routing re-key,
 * not an access change). Returns the number of rows moved.
 */
export async function renameAccessIndexOwner (platform: PlatformIndexHandle, oldUsername: string, newUsername: string): Promise<number> {
  const owned = await entriesOwnedBy(platform, oldUsername);
  const stored = platform.hashFor(USERNAME_FIELD, newUsername);
  for (const { key, entry } of owned) {
    delete entry.username;
    delete entry.usernameToken;
    if (platform.piiModeIsHashed) entry.usernameToken = stored;
    else entry.username = stored;
    await platform.setPlatformKv(key, JSON.stringify(entry));
  }
  return owned.length;
}

/** Non-fatal {@link renameAccessIndexOwner}: a failure leaves rows `--resync` repairs. Never rejects. */
export async function renameAccessIndexOwnerNonFatal (platform: PlatformIndexHandle, oldUsername: string, newUsername: string): Promise<void> {
  try {
    await renameAccessIndexOwner(platform, oldUsername, newUsername);
  } catch (err) {
    logger.warn(`[access-index] failed to move index rows to the new name of user ${platform.hashFor(USERNAME_FIELD, newUsername)}: ${(err as Error).message}`);
  }
}

/** Where an indexed access is held, for a name of one of this core's accounts. */
export type LocalAccessHolder = 'owned' | 'other-account' | 'missing';

/**
 * Index rows to review:
 *  - `stale`: another account of this core holds the access (the row names a
 *    later holder of a renamed account's former name): prunable;
 *  - `orphan`: not an account of this core, and no core holds the name (an
 *    account deleted before deletion removed its rows): prunable;
 *  - `missing`: the name's account has no such access and no other account
 *    of this core holds it: an access removed from storage without a deletion
 *    record (the consent adapter deletes rows outright), storage restored
 *    from an older backup, or the access of an account deleted before
 *    deletion removed its rows, whose name was taken again. Reported only,
 *    never pruned: the row alone does not tell these cases apart.
 * Rows already stripped of their user (tombstones) are never listed.
 * `userCoreOf(stored)` is the core holding a stored name (null when none);
 * `accessHolder(stored, accessId)` answers for names hosted on `coreId`, null
 * when the name is not one of this core's account names (not judged).
 */
export async function findPrunableAccessIndexRows (platform: PlatformIndexHandle, opts: {
  coreId: string;
  userCoreOf: (stored: string) => Promise<string | null>;
  accessHolder: (stored: string, accessId: string) => Promise<LocalAccessHolder | null>;
}): Promise<Array<{ key: string, entry: AccessIndexEntry, reason: 'orphan' | 'stale' | 'missing' }>> {
  const found: Array<{ key: string, entry: AccessIndexEntry, reason: 'orphan' | 'stale' | 'missing' }> = [];
  for (const { key, value } of await platform.listPlatformKvEntries(PREFIX)) {
    let entry: AccessIndexEntry;
    try { entry = JSON.parse(value) as AccessIndexEntry; } catch { continue; }
    const stored = entry != null && typeof entry === 'object' ? readStoredUser(entry) : null;
    if (stored == null) continue;
    // An account of this core is judged by its own accesses first: a live
    // account may lack its `user-core/` row (single-core, older data, a
    // partial restore), which must not make its rows orphans.
    const holder = await opts.accessHolder(stored, entry.accessId);
    if (holder === 'other-account') {
      found.push({ key, entry, reason: 'stale' });
    } else if (holder === 'missing') {
      found.push({ key, entry, reason: 'missing' });
    } else if (holder == null && (await opts.userCoreOf(stored)) == null) {
      found.push({ key, entry, reason: 'orphan' });
    }
  }
  return found;
}

/** Remove a prunable row, or under `audit.onUserDelete: keep` strip its user (tombstone). */
export async function pruneAccessIndexRow (platform: PlatformIndexHandle, key: string, entry: AccessIndexEntry, keepMode: boolean, ts: number = timestamp.now()): Promise<void> {
  if (!keepMode) return await platform.deletePlatformKv(key);
  delete entry.username;
  delete entry.usernameToken;
  entry.userDeleted = true;
  entry.lastModified = ts;
  await platform.setPlatformKv(key, JSON.stringify(entry));
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
    // Log the mode-aware username token (identity in cleartext, HMAC in hashed)
    // so an operator shipping logs off-core never gets plaintext where the
    // STORE was carefully tokenized.
    logger.warn(`[access-index] failed to index access ${row?.id} (user ${platform.hashFor(USERNAME_FIELD, username)}): ${(err as Error).message}`);
  }
}

/** Non-fatal delete index write. Never rejects. */
export async function safeMarkAccessDeleted (platform: PlatformIndexHandle, username: string, row: AccessRowLike, ts: number = timestamp.now()): Promise<void> {
  try {
    await markAccessDeletedInIndex(platform, username, row, ts);
  } catch (err) {
    logger.warn(`[access-index] failed to mark access ${row?.id} deleted (user ${platform.hashFor(USERNAME_FIELD, username)}): ${(err as Error).message}`);
  }
}

// --- Self-contained hooks for mutation call sites --- //
//
// These fetch the platform handle themselves and narrow a loosely-typed
// access row, so the three access-creation sites + the update/delete paths
// call ONE function each without duplicating the platform-fetch + non-fatal
// wiring. Never reject — a PlatformDB (or platform-init) failure is logged
// and swallowed so it can't break access CRUD.

/** A loosely-typed access row as handed by the storage/method layer. */
export type LooseAccessRow = { id?: unknown; type?: unknown; expires?: unknown; created?: unknown; modified?: unknown };

/** Narrow a loose storage row to the fields the index needs, or null if it has no usable id. */
export function coerceAccessRow (input: LooseAccessRow | null | undefined): AccessRowLike | null {
  const id = input?.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return {
    id,
    type: typeof input!.type === 'string' ? input!.type : 'unknown',
    expires: typeof input!.expires === 'number' ? input!.expires : null,
    created: typeof input!.created === 'number' ? input!.created : undefined,
    modified: typeof input!.modified === 'number' ? input!.modified : undefined
  };
}

/** Index one created/updated access (fetches platform, non-fatal). Never rejects. */
export async function reindexAccessNonFatal (username: string, input: LooseAccessRow | null | undefined): Promise<void> {
  const row = coerceAccessRow(input);
  if (row == null) return;
  try {
    const { getPlatform } = require('./index.ts');
    const platform = await getPlatform();
    await putAccessIndex(platform, username, row);
  } catch (err) {
    // platform is unavailable here (the fetch above failed), so no mode-aware
    // token is obtainable — the access id identifies the divergent row.
    logger.warn(`[access-index] platform unavailable, could not index access ${row.id}: ${(err as Error).message}`);
  }
}

/** Tombstone a set of deleted accesses (fetches platform, non-fatal). Never rejects. */
export async function tombstoneAccessesNonFatal (username: string, inputs: Array<LooseAccessRow | null | undefined>, ts: number): Promise<void> {
  const rows = inputs.map(coerceAccessRow).filter((r): r is AccessRowLike => r != null);
  if (rows.length === 0) return;
  try {
    const { getPlatform } = require('./index.ts');
    const platform = await getPlatform();
    for (const row of rows) await markAccessDeletedInIndex(platform, username, row, ts);
  } catch (err) {
    logger.warn(`[access-index] platform unavailable, could not tombstone deleted access(es): ${(err as Error).message}`);
  }
}

/**
 * Clean up a user's index rows on account erasure (non-fatal). Default (Art.17):
 * delete every row the user owns. Under `audit.onUserDelete: keep`: tombstone
 * instead (strip username, keep type + deleted) so a late-discovered breach can
 * still confirm the accessId belonged to a since-erased account. Takes the
 * platform handle the caller already holds. Never rejects — a failure leaves
 * (repairable) rows rather than blocking the user deletion.
 */
export async function cleanupUserAccessIndexNonFatal (platform: PlatformIndexHandle, username: string, keepMode: boolean): Promise<void> {
  try {
    if (keepMode) await tombstoneAccessIndexForUser(platform, username);
    else await deleteAccessIndexForUser(platform, username);
  } catch (err) {
    logger.warn(`[access-index] failed to ${keepMode ? 'tombstone' : 'delete'} index rows for erased user ${platform.hashFor(USERNAME_FIELD, username)}: ${(err as Error).message}`);
  }
}

export { PREFIX as ACCESS_INDEX_PREFIX, keyFor as accessIndexKey, readStoredUser };
