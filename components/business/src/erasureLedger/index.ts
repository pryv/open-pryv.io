/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The erasure ledger: a durable record, kept after the account is gone, that
 * an account was erased, when, by what decision and on which core. It is the
 * proof of an erasure (who asks "was this account erased?" gets an answer),
 * and what keeps a restore from bringing an erased account back unnoticed.
 *
 * One row per account in the platform's replicated key/value store, key
 * `account-erasure/<userIdHash>`. The account is named only by keyed hashes
 * (HMAC-SHA256) of its user id and of its username: no username, email,
 * address, access or content is kept. The hashes are pseudonymous while the
 * key exists (whoever holds the key can test a known id or name against
 * them); destroying the key anonymises the ledger.
 *
 * The key is `accountErasure.ledger.hmacKey` when set, else derived from
 * `auth.adminAccessKey` with its own purpose label (identical on every core).
 * Each row carries the `keyId` of the key that wrote it: after a key change
 * the older rows are still listed, but no longer matched by an id or a name.
 *
 * This is not the record of an erasure in progress (`../auth/erasures.ts`,
 * per core, removed once the erasure completes).
 */

import { createHmac } from 'node:crypto';
import { deriveKey } from '../acme/AtRestEncryption.ts';
import { explicitKeyBytes } from './config.ts';

export const LEDGER_PREFIX = 'account-erasure/';
export const LEDGER_KEY_PURPOSE = 'erasure-ledger-v1';
export const ROW_VERSION = 1;
export const MAX_LIST_LIMIT = 1000;
export const DEFAULT_LIST_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const HASH_RE = /^[0-9a-f]{64}$/;
const CURSOR_RE = /^([0-9]+):([0-9a-f]{64})$/;

/** The platform key/value primitives the ledger uses (the Platform and the raw platform engines both have them). */
export type LedgerKv = {
  getPlatformKv (key: string): Promise<string | null>;
  setPlatformKv (key: string, value: string): Promise<void>;
  deletePlatformKv (key: string): Promise<void>;
  listPlatformKvEntries (prefix: string): Promise<Array<{ key: string, value: string }>>;
};

export type LedgerKey = { key: Buffer; keyId: string };

export type ErasureLedgerRow = {
  v: number;
  keyId: string;
  usernameHash: string;
  startedAt: number;
  deletedAt: number;
  trigger: string;
  coreId: string | null;
  stepsCompleted: string[];
  auditMode: 'erase' | 'keep';
  attempts: number;
  serverVersion: string | null;
  restoredAt?: number;
  /**
   * When a later erasure replaced a record no restore had marked (an account
   * brought back by a storage restore, erased again by `bin/erasures.js
   * --replay`): the date and trigger of the first erasure, the one asked for.
   */
  firstDeletedAt?: number;
  firstTrigger?: string;
};

export type ErasureLedgerEntry = ErasureLedgerRow & { userIdHash: string };

let cachedKey: { source: string, value: LedgerKey } | null = null;

/**
 * The ledger key and its id. Throws when neither `accountErasure.ledger.hmacKey`
 * (valid) nor `auth.adminAccessKey` is set: no row can be written then.
 */
export function ledgerKey (config: { get (key: string): unknown }): LedgerKey {
  const explicit = config.get('accountErasure:ledger:hmacKey');
  if (explicit != null && explicit !== '') {
    const bytes = explicitKeyBytes(explicit);
    if (bytes == null) throw new Error('accountErasure.ledger.hmacKey is not base64 of 32 bytes');
    const source = 'explicit:' + String(explicit).trim();
    if (cachedKey?.source !== source) cachedKey = { source, value: withKeyId(bytes) };
    return cachedKey.value;
  }
  const adminKey = config.get('auth:adminAccessKey');
  if (typeof adminKey !== 'string' || adminKey.length === 0) {
    throw new Error('the erasure ledger has no key: set accountErasure.ledger.hmacKey or auth.adminAccessKey');
  }
  const source = 'derived:' + adminKey;
  if (cachedKey?.source !== source) cachedKey = { source, value: withKeyId(deriveKey(adminKey, LEDGER_KEY_PURPOSE)) };
  return cachedKey.value;
}

function withKeyId (key: Buffer): LedgerKey {
  return { key, keyId: createHmac('sha256', key).update('key-id').digest('hex').slice(0, 8) };
}

export function userIdHash (k: LedgerKey, userId: string): string {
  return createHmac('sha256', k.key).update('user-id:' + userId).digest('hex');
}

/** Usernames are matched whatever their case. */
export function usernameHash (k: LedgerKey, username: string): string {
  return createHmac('sha256', k.key).update('username:' + username.toLowerCase()).digest('hex');
}

/** A stored row, or null when the value is not one (skipped, never thrown). */
export function parseRow (value: unknown): ErasureLedgerRow | null {
  if (typeof value !== 'string') return null;
  let row: Record<string, unknown>;
  try { row = JSON.parse(value); } catch { return null; }
  if (row == null || typeof row !== 'object' || row.v !== ROW_VERSION) return null;
  if (typeof row.deletedAt !== 'number' || typeof row.usernameHash !== 'string' || typeof row.keyId !== 'string') return null;
  return row as unknown as ErasureLedgerRow;
}

function hashOfKey (key: string): string | null {
  if (!key.startsWith(LEDGER_PREFIX)) return null;
  const hash = key.slice(LEDGER_PREFIX.length);
  return HASH_RE.test(hash) ? hash : null;
}

export type ErasureFacts = {
  userId: string;
  username: string;
  startedAt: number;
  deletedAt: number;
  trigger: string;
  coreId: string | null;
  stepsCompleted: string[];
  auditMode: 'erase' | 'keep';
  attempts: number;
  serverVersion: string | null;
  /** Set only for a record written already marked restored (an unfinished erasure a restore overrode). */
  restoredAt?: number;
};

/**
 * Write the record of an erasure. A row already there for the same id:
 *  - of the same erasure (same `startedAt`, not marked restored: the step ran
 *    twice, its completion was not recorded) is kept as it is;
 *  - marked restored (an account restored, then erased again) is replaced,
 *    its `restoredAt` goes;
 *  - otherwise (an account brought back without a restore marking it, then
 *    erased again) is replaced, keeping the date and trigger of the first
 *    erasure in `firstDeletedAt` / `firstTrigger`.
 */
export async function writeErasureRecord (kv: LedgerKv, k: LedgerKey, facts: ErasureFacts): Promise<ErasureLedgerEntry> {
  const hash = userIdHash(k, facts.userId);
  const existing = parseRow(await kv.getPlatformKv(LEDGER_PREFIX + hash));
  if (existing != null && existing.keyId === k.keyId && existing.restoredAt == null && existing.startedAt === facts.startedAt && facts.restoredAt == null) {
    return { userIdHash: hash, ...existing };
  }
  const row: ErasureLedgerRow = {
    v: ROW_VERSION,
    keyId: k.keyId,
    usernameHash: usernameHash(k, facts.username),
    startedAt: facts.startedAt,
    deletedAt: facts.deletedAt,
    trigger: facts.trigger,
    coreId: facts.coreId,
    stepsCompleted: [...facts.stepsCompleted],
    auditMode: facts.auditMode,
    attempts: facts.attempts,
    serverVersion: facts.serverVersion
  };
  if (existing != null && existing.restoredAt == null) {
    row.firstDeletedAt = existing.firstDeletedAt ?? existing.deletedAt;
    row.firstTrigger = existing.firstTrigger ?? existing.trigger;
  }
  if (facts.restoredAt != null) row.restoredAt = facts.restoredAt;
  await kv.setPlatformKv(LEDGER_PREFIX + hash, JSON.stringify(row));
  return { userIdHash: hash, ...row };
}

/** How many rows were written under another key than `k` (no longer matched by an id or a name). */
export async function otherKeyRecordCount (kv: Pick<LedgerKv, 'listPlatformKvEntries'>, k: LedgerKey): Promise<number> {
  return (await allErasureRecords(kv)).filter((e) => e.keyId !== k.keyId).length;
}

/** The warning a reader of the ledger prints when it holds rows of another key; null when none. */
export function otherKeyWarning (count: number): string | null {
  if (count === 0) return null;
  return `the erasure ledger holds ${count} record(s) written under another key (accountErasure.ledger.hmacKey, or auth.adminAccessKey ` +
    'it is derived from, changed since, or differs between cores): they are listed but no longer matched by an id or a name, so a ' +
    'restore does not refuse those accounts and a replay does not find them. They are matched again only under the key that wrote them.';
}

/** The record of the account `userId`, or null. */
export async function readErasureRecord (kv: Pick<LedgerKv, 'getPlatformKv'>, k: LedgerKey, userId: string): Promise<ErasureLedgerEntry | null> {
  const hash = userIdHash(k, userId);
  const row = parseRow(await kv.getPlatformKv(LEDGER_PREFIX + hash));
  return row == null ? null : { userIdHash: hash, ...row };
}

/** Every row of the ledger, ordered by (deletedAt, userIdHash). */
export async function allErasureRecords (kv: Pick<LedgerKv, 'listPlatformKvEntries'>): Promise<ErasureLedgerEntry[]> {
  // Reads the prefix whole. Beyond about 100,000 rows, a secondary key
  // ordered by deletedAt would avoid it (not built).
  const out: ErasureLedgerEntry[] = [];
  for (const { key, value } of await kv.listPlatformKvEntries(LEDGER_PREFIX)) {
    const hash = hashOfKey(key);
    const row = parseRow(value);
    if (hash != null && row != null) out.push({ userIdHash: hash, ...row });
  }
  out.sort(compareEntries);
  return out;
}

function compareEntries (a: { deletedAt: number, userIdHash: string }, b: { deletedAt: number, userIdHash: string }): number {
  if (a.deletedAt !== b.deletedAt) return a.deletedAt - b.deletedAt;
  return a.userIdHash < b.userIdHash ? -1 : a.userIdHash > b.userIdHash ? 1 : 0;
}

export function cursorOf (entry: { deletedAt: number, userIdHash: string }): string {
  return `${entry.deletedAt}:${entry.userIdHash}`;
}

/** The position a cursor names, or null when it is not one. */
export function parseCursor (cursor: unknown): { deletedAt: number, userIdHash: string } | null {
  if (typeof cursor !== 'string') return null;
  const m = CURSOR_RE.exec(cursor);
  return m == null ? null : { deletedAt: Number(m[1]), userIdHash: m[2] };
}

/**
 * The rows with `deletedAt >= since`, after the `after` cursor, at most
 * `limit`; `next` is the cursor of the last row returned when more follow.
 */
export async function listErasureRecords (kv: Pick<LedgerKv, 'listPlatformKvEntries'>, options: { since?: number, limit?: number, after?: { deletedAt: number, userIdHash: string } | null } = {}): Promise<{ erasures: ErasureLedgerEntry[], next: string | null }> {
  const since = options.since ?? 0;
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const after = options.after ?? null;
  const matching = (await allErasureRecords(kv)).filter((e) => e.deletedAt >= since && (after == null || compareEntries(e, after) > 0));
  const erasures = matching.slice(0, limit);
  const next = matching.length > limit ? cursorOf(erasures[erasures.length - 1]) : null;
  return { erasures, next };
}

/** The rows of the account with this id, or of the accounts that held this name (any case). */
export async function lookupErasureRecords (kv: Pick<LedgerKv, 'getPlatformKv' | 'listPlatformKvEntries'>, k: LedgerKey, who: { userId?: string, username?: string }): Promise<ErasureLedgerEntry[]> {
  if (typeof who.userId === 'string') {
    const entry = await readErasureRecord(kv, k, who.userId);
    return entry == null ? [] : [entry];
  }
  if (typeof who.username === 'string') {
    const hash = usernameHash(k, who.username);
    return (await allErasureRecords(kv)).filter((e) => e.usernameHash === hash);
  }
  return [];
}

/**
 * True when `row` says the account was erased after `snapshotMs` and not
 * restored since that erasure.
 */
export function erasedAfter (row: Pick<ErasureLedgerRow, 'deletedAt' | 'restoredAt'>, snapshotMs: number | null): boolean {
  if (row.restoredAt != null && row.restoredAt >= row.deletedAt) return false;
  // A backup of unknown date: an id still in the ledger was erased after it
  // (an account keeps its id; one of the same id exists again only once restored).
  if (snapshotMs == null) return true;
  return row.deletedAt > snapshotMs;
}

/** Stamp `restoredAt` on the record of `userId` (kept, never removed). False when there is none. */
export async function markRestored (kv: LedgerKv, k: LedgerKey, userId: string, at: number): Promise<boolean> {
  const hash = userIdHash(k, userId);
  const key = LEDGER_PREFIX + hash;
  const row = parseRow(await kv.getPlatformKv(key));
  if (row == null) return false;
  await kv.setPlatformKv(key, JSON.stringify({ ...row, restoredAt: at }));
  return true;
}

/** Remove the rows whose erasure is older than `retentionDays` (0: none). Returns how many. */
export async function purgeExpiredErasureRecords (kv: LedgerKv, retentionDays: number, now: number): Promise<number> {
  if (!(retentionDays > 0)) return 0;
  const cutoff = now - retentionDays * DAY_MS;
  let removed = 0;
  for (const { key, value } of await kv.listPlatformKvEntries(LEDGER_PREFIX)) {
    const row = parseRow(value);
    if (row == null || row.deletedAt >= cutoff) continue;
    await kv.deletePlatformKv(key);
    removed++;
  }
  return removed;
}

// ------------------------------------------------------------ backup / restore

/** A ledger row as exported by a platform backup. */
export function isErasureLedgerEntry (entry: { key?: unknown }): entry is { key: string, value: string } {
  return typeof entry.key === 'string' && entry.key.startsWith(LEDGER_PREFIX);
}

/** The ledger rows, for a platform backup (`{ key, value }` each). */
export async function exportErasureLedgerRows (kv: Pick<LedgerKv, 'listPlatformKvEntries'>): Promise<Array<{ key: string, value: string }>> {
  return await kv.listPlatformKvEntries(LEDGER_PREFIX);
}

/**
 * Merge the rows of a backup into the live ledger. Nothing is removed: a row
 * absent here is written, a row present is replaced only by a newer erasure
 * of the same account (a later `deletedAt`), or completed by a later
 * `restoredAt` of the same erasure. Malformed rows are skipped.
 */
export async function mergeErasureLedgerRows (kv: LedgerKv, rows: Array<{ key: string, value: string }>): Promise<{ written: number, kept: number, skipped: number }> {
  const counts = { written: 0, kept: 0, skipped: 0 };
  for (const { key, value } of rows) {
    const incoming = hashOfKey(key) != null ? parseRow(value) : null;
    if (incoming == null) { counts.skipped++; continue; }
    const live = parseRow(await kv.getPlatformKv(key));
    let next: ErasureLedgerRow | null = null;
    if (live == null || incoming.deletedAt > live.deletedAt) {
      next = incoming;
    } else if (incoming.deletedAt === live.deletedAt && incoming.restoredAt != null && (live.restoredAt == null || incoming.restoredAt > live.restoredAt)) {
      next = { ...live, restoredAt: incoming.restoredAt };
    }
    if (next == null) { counts.kept++; continue; }
    await kv.setPlatformKv(key, JSON.stringify(next));
    counts.written++;
  }
  return counts;
}
