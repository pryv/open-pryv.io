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
  'getPlatformKv' | 'setPlatformKv' | 'setPlatformKvIfAbsent' | 'deletePlatformKv' | 'listPlatformKvEntries' |
  'setAccessState' | 'getAccessState' | 'deleteAccessState' | 'consumeAccessState' |
  'bumpWindowedCounter'>;

export const KEYS = Object.freeze({
  setupState: 'setup/state',
  rolePrefix: 'admin-role/',
  setupCodePrefix: 'setup-code/',
  setupSessionPrefix: 'setup-session/',
  claimCodePrefix: 'admin-claim/',
  adminSessionPrefix: 'admin-session/',
  adminSessionEndedPrefix: 'admin-session-ended/',
  setupAttemptsPrefix: 'setup-attempts/',
  claimAttemptsPrefix: 'admin-claim-attempts/'
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
