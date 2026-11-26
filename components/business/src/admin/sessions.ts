/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createHash } from 'node:crypto';
import { generateToken, hashToken, isTokenShape } from './codes.ts';
import { KEYS, checkKeyId, isPlainObject } from './store.ts';
import type { AdminStore } from './store.ts';
import { readRoleRow, permissionsOf } from './roles.ts';
import type { RoleRow } from './roles.ts';
import type { AdminPermission } from './permissions.ts';

/**
 * Setup sessions and administrator sessions: bearer tokens of 256 bits whose
 * SHA-256 is the key of a TTL access state in the platform store, so any core
 * validates one with a local read. The token itself is answered once and
 * never stored or logged.
 *
 * - Setup session (`setup-session/<sha256>`, 2 h): what a redeemed setup code
 *   gives; it can create the first administrator and finish setup.
 * - Admin session (`admin-session/<sha256>`): issued by the account's home
 *   core from a personal access, `{ userId, homeCore, mfaAt, createdAt }`.
 *   Every request reads `admin-role/<userId>` too: deleting the role row (or
 *   setting its `sessionsRevokedAt`) ends the sessions everywhere on the next
 *   request. No write per request: the portal does the idle lock.
 *
 * Ending a session wins over a renewal racing it. Renewal and step-up
 * rewrite the row (consume, then set), so a logout landing between the two
 * would find no row to delete and the renewal would bring the session back.
 * Ending therefore first writes a marker `admin-session-ended/<sha256>` that
 * outlives any renewal (24 h and 5 min, past the longest session), then
 * deletes the row: a renewal refuses a marked session before and after its
 * write (deleting what it wrote), and every read refuses it too.
 *
 * "MFA passed in this sign-in" is not recorded on the personal access. The
 * home core stamps it at `mfa.verify` in its core-local key-value store
 * (`recordMfaSignIn`, keyed by the hash of the released token, kept for the
 * admin session TTL); `mfaSignInAt` reads it when the admin session is opened.
 */

export const SETUP_SESSION_TTL_MS = 2 * 3600 * 1000;

export type SetupSession = { createdAt: number; coreId: string; expiresAt: number };

export type AdminSessionRow = { userId: string; homeCore: string; mfaAt: number | null; createdAt: number };
export type AdminSession = AdminSessionRow & { expiresAt: number };

export type ResolvedAdminSession = { session: AdminSession; role: RoleRow; permissions: Set<AdminPermission> };

export type IssuedToken = { token: string; expiresAt: number };

function keyOf (prefix: string, token: unknown): string | null {
  return isTokenShape(token) ? prefix + hashToken(token) : null;
}

// --- Setup sessions --- //

export async function createSetupSession (db: AdminStore, opts: { coreId: string; now: number; ttlMs?: number }): Promise<IssuedToken> {
  const token = generateToken();
  const expiresAt = opts.now + (opts.ttlMs ?? SETUP_SESSION_TTL_MS);
  await db.setAccessState(KEYS.setupSessionPrefix + hashToken(token),
    { createdAt: opts.now, coreId: checkKeyId('core id', opts.coreId) }, expiresAt);
  return { token, expiresAt };
}

export async function readSetupSession (db: AdminStore, token: unknown): Promise<SetupSession | null> {
  const key = keyOf(KEYS.setupSessionPrefix, token);
  if (key == null) return null;
  const entry = await db.getAccessState(key);
  if (entry == null || !isPlainObject(entry.value)) return null;
  const v = entry.value as { createdAt: number; coreId: string };
  return { createdAt: v.createdAt, coreId: v.coreId, expiresAt: entry.expiresAt };
}

export async function endSetupSession (db: AdminStore, token: unknown): Promise<void> {
  const key = keyOf(KEYS.setupSessionPrefix, token);
  if (key != null) await db.deleteAccessState(key);
}

// --- Admin sessions --- //

export async function createAdminSession (db: AdminStore, opts: {
  userId: string; homeCore: string; mfaAt: number | null; now: number; ttlMs: number;
}): Promise<IssuedToken> {
  if (!(opts.ttlMs > 0)) throw new Error('createAdminSession: ttlMs must be positive');
  const token = generateToken();
  const row: AdminSessionRow = {
    userId: checkKeyId('user id', opts.userId),
    homeCore: checkKeyId('core id', opts.homeCore),
    mfaAt: opts.mfaAt ?? null,
    createdAt: opts.now
  };
  const expiresAt = opts.now + opts.ttlMs;
  await db.setAccessState(KEYS.adminSessionPrefix + hashToken(token), row, expiresAt);
  return { token, expiresAt };
}

/** How long the end marker of a session lives: past the longest session a renewal can make. */
export const ENDED_SESSION_MARK_MS = (24 * 60 + 5) * 60 * 1000;

function endedKeyOf (token: unknown): string | null {
  return keyOf(KEYS.adminSessionEndedPrefix, token);
}

async function isEnded (db: AdminStore, token: unknown): Promise<boolean> {
  const key = endedKeyOf(token);
  return key == null || (await db.getAccessState(key)) != null;
}

export async function readAdminSession (db: AdminStore, token: unknown): Promise<AdminSession | null> {
  const key = keyOf(KEYS.adminSessionPrefix, token);
  if (key == null) return null;
  const entry = await db.getAccessState(key);
  if (entry == null || !isPlainObject(entry.value)) return null;
  const v = entry.value as AdminSessionRow;
  if (typeof v.userId !== 'string') return null;
  if (await isEnded(db, token)) return null;
  return { userId: v.userId, homeCore: v.homeCore, mfaAt: v.mfaAt ?? null, createdAt: v.createdAt, expiresAt: entry.expiresAt };
}

/**
 * Extend a session to `now + ttlMs` (and record a fresh second factor when
 * `mfaAt` is given). Answers the new expiry, or null when the session is gone
 * or was ended, even by an end racing this renewal.
 */
export async function renewAdminSession (db: AdminStore, token: unknown, opts: { now: number; ttlMs: number; mfaAt?: number }): Promise<number | null> {
  const key = keyOf(KEYS.adminSessionPrefix, token);
  if (key == null || !(opts.ttlMs > 0)) return null;
  if (await isEnded(db, token)) return null;
  const entry = await db.consumeAccessState(key);
  if (entry == null || !isPlainObject(entry.value)) return null;
  const row = { ...(entry.value as AdminSessionRow) };
  if (opts.mfaAt != null) row.mfaAt = opts.mfaAt;
  const expiresAt = opts.now + opts.ttlMs;
  await db.setAccessState(key, row, expiresAt);
  // An end that landed after the check above found no row to delete, or
  // deleted the row before this write: what was written goes.
  if (await isEnded(db, token)) {
    await db.deleteAccessState(key);
    return null;
  }
  return expiresAt;
}

/** End a session: marked ended first (so a racing renewal cannot bring it back), then deleted. */
export async function endAdminSession (db: AdminStore, token: unknown, opts: { now?: number } = {}): Promise<void> {
  const key = keyOf(KEYS.adminSessionPrefix, token);
  const endedKey = endedKeyOf(token);
  if (key == null || endedKey == null) return;
  const now = opts.now ?? Date.now();
  await db.setAccessState(endedKey, { endedAt: now }, now + ENDED_SESSION_MARK_MS);
  await db.deleteAccessState(key);
}

/**
 * A session, its role row and the permissions it gives on this core now; null
 * when the session is unknown or expired, its account holds no role (or no
 * longer an active one), or its sessions were revoked after it was created.
 */
export async function resolveAdminSession (db: AdminStore, token: unknown, now: number): Promise<ResolvedAdminSession | null> {
  const session = await readAdminSession(db, token);
  if (session == null) return null;
  const role = await readRoleRow(db, session.userId);
  if (role == null) return null;
  if (role.sessionsRevokedAt != null && session.createdAt <= role.sessionsRevokedAt) return null;
  const permissions = permissionsOf(role, now);
  if (permissions.size === 0) return null;
  return { session, role, permissions };
}

/** Whether the session's second factor is recent enough for a step-up act. */
export function isStepUpFresh (session: Pick<AdminSessionRow, 'mfaAt'>, now: number, stepUpMs: number): boolean {
  return session.mfaAt != null && session.mfaAt <= now && now - session.mfaAt <= stepUpMs;
}

// --- Second factor of a sign-in (home core, core-local) --- //

/** The core-local key-value store (`messages/src/cluster_kv.ts` client). */
export type LocalKv = {
  get (key: string): Promise<unknown>;
  set (key: string, value: unknown, opts?: { ttlMs?: number; ifUnderPrefix?: { prefix: string; max: number } }): Promise<boolean>;
};

const MFA_SIGN_IN_PREFIX = 'admin-mfa-sign-in/';
/** Most stamps kept at once on a core; past it a stamp is not written (the admin session then sees no second factor). */
const MFA_SIGN_IN_MAX = 20000;

/** Record that the sign-in which released `token` passed its second factor. Best-effort. */
export async function recordMfaSignIn (kv: LocalKv, opts: { token: string; userId: string; now: number; ttlMs: number }): Promise<boolean> {
  if (typeof opts.token !== 'string' || opts.token.length === 0 || !(opts.ttlMs > 0)) return false;
  return await kv.set(MFA_SIGN_IN_PREFIX + tokenDigest(opts.token), { userId: opts.userId, at: opts.now },
    { ttlMs: opts.ttlMs, ifUnderPrefix: { prefix: MFA_SIGN_IN_PREFIX, max: MFA_SIGN_IN_MAX } });
}

/** When the sign-in that released `token` passed its second factor, if this core recorded it. */
export async function mfaSignInAt (kv: LocalKv, opts: { token: string; userId: string }): Promise<number | null> {
  if (typeof opts.token !== 'string' || opts.token.length === 0) return null;
  const value = await kv.get(MFA_SIGN_IN_PREFIX + tokenDigest(opts.token));
  if (!isPlainObject(value) || value.userId !== opts.userId || typeof value.at !== 'number') return null;
  return value.at;
}

function tokenDigest (token: string): string {
  // Personal access tokens are not of the admin token shape: hash them directly.
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
