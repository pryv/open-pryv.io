/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';

/**
 * Where the administration features keep their state: the platform store
 * only (replicated to every core), in families that already exist. No row
 * holds a plain code or token: codes and tokens are keys by their SHA-256.
 *
 * | Key                                 | Kind               | TTL                  |
 * |-------------------------------------|--------------------|----------------------|
 * | `setup/state`                       | platform KV        | none                 |
 * | `admin-role/<userId>`               | platform KV        | none                 |
 * | `setup-code/<sha256(code)>`         | access state       | setup.codeTtlHours   |
 * | `setup-session/<sha256(token)>`     | access state       | 2 h                  |
 * | `admin-claim/<sha256(code)>`        | access state       | 15 min (max 24 h)    |
 * | `admin-session/<sha256(token)>`     | access state       | admin.session.ttlMinutes |
 * | `admin-session-ended/<sha256(token)>` | access state     | 24 h 5 min (end marker) |
 * | `setup-attempts/<coreId>`           | windowed counter   | 15 min               |
 * | `admin-claim-attempts/<userId>`     | windowed counter   | 15 min               |
 */
export type AdminStore = Pick<PlatformDB,
  'getPlatformKv' | 'setPlatformKv' | 'setPlatformKvIfAbsent' | 'replacePlatformKvIfValue' | 'deletePlatformKv' | 'listPlatformKvEntries' |
  'setAccessState' | 'getAccessState' | 'deleteAccessState' | 'consumeAccessState' |
  'bumpWindowedCounter'>;

/** How often a compare-and-set update is tried before it gives up. */
const UPDATE_ATTEMPTS = 8;

export class ConcurrentUpdateError extends Error {
  constructor (key: string) {
    super(`the platform store row ${key} kept changing under this update: retry`);
    this.name = 'ConcurrentUpdateError';
  }
}

/**
 * A read-modify-write of one platform KV row that never writes over a
 * change it did not read: `change` gets the stored raw value (null: no row)
 * and answers the next raw value (null: delete the row) with a result, or
 * null to change nothing. The write is a compare-and-set (insert-if-absent
 * for a missing row); on a lost race the row is read again and `change` runs
 * again. Answers `{ result, before, after }`, or null when `change` declined.
 */
export async function updatePlatformKv<T> (db: AdminStore, key: string,
  change: (raw: string | null) => Promise<{ next: string | null; result: T } | null> | { next: string | null; result: T } | null
): Promise<{ result: T; before: string | null; after: string | null } | null> {
  for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
    const raw = await db.getPlatformKv(key);
    const out = await change(raw);
    if (out == null) return null;
    if (out.next === raw) return { result: out.result, before: raw, after: raw };
    const written = raw == null
      ? await db.setPlatformKvIfAbsent(key, out.next as string)
      : await db.replacePlatformKvIfValue(key, raw, out.next);
    if (written) return { result: out.result, before: raw, after: out.next };
  }
  throw new ConcurrentUpdateError(key);
}

/** Put back `before` where this call wrote `after` (no-op when the row changed since). */
export async function undoPlatformKvUpdate (db: AdminStore, key: string, before: string | null, after: string | null): Promise<void> {
  if (before === after) return;
  if (after == null) {
    await db.setPlatformKvIfAbsent(key, before as string);
  } else {
    await db.replacePlatformKvIfValue(key, after, before);
  }
}

export const KEYS = Object.freeze({
  setupState: 'setup/state',
  rolePrefix: 'admin-role/',
  setupCodePrefix: 'setup-code/',
  setupSessionPrefix: 'setup-session/',
  claimCodePrefix: 'admin-claim/',
  adminSessionPrefix: 'admin-session/',
  adminSessionEndedPrefix: 'admin-session-ended/',
  setupAttemptsPrefix: 'setup-attempts/',
  claimAttemptsPrefix: 'admin-claim-attempts/',
  sessionRefusalsPrefix: 'admin-session-refusals/'
});

/** Ids used in keys: a user id or a core id (letters, digits, `-`, `_`, `.`). */
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function checkKeyId (what: string, id: unknown): string {
  if (typeof id !== 'string' || !KEY_ID_RE.test(id)) throw new Error(`invalid ${what}`);
  return id;
}

/** JSON.parse that answers null on a malformed row instead of throwing. */
export function parseJson<T> (raw: string | null): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function isPlainObject (v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}
