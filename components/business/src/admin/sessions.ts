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
import { readRoleRow, effectivePermissions, hasActiveGrant } from './roles.ts';
import type { RoleRow, PermissionContext, DeniedPermission } from './roles.ts';
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
 * rewrite the row (read, then set), so a logout landing between the two
 * would have its delete undone by the renewal's write.
 * Ending therefore first writes a marker `admin-session-ended/<sha256>` that
 * outlives any renewal (24 h and 5 min, past the longest session), then
 * deletes the row: a renewal refuses a marked session before and after its
 * write (deleting what it wrote), and every read refuses it too.
 *
 * "MFA passed in this sign-in" is not recorded on the personal access. The
 * home core stamps it at `mfa.verify` in its core-local key-value store
 * (`recordMfaSignIn`, one entry per account holding the hash of the released
 * token, kept for the admin session TTL); `mfaSignInAt` reads it when the
 * admin session is opened.
 */

export const SETUP_SESSION_TTL_MS = 2 * 3600 * 1000;

export type SetupSession = { createdAt: number; coreId: string; expiresAt: number };

export type AdminSessionRow = { userId: string; homeCore: string; mfaAt: number | null; createdAt: number };
export type AdminSession = AdminSessionRow & { expiresAt: number };

export type ResolvedAdminSession = { session: AdminSession; role: RoleRow; permissions: Set<AdminPermission>; denied: DeniedPermission[] };

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

export const SESSION_REFUSALS_MAX = 10;
export const SESSION_REFUSALS_WINDOW_MS = 15 * 60 * 1000;

/**
 * Count one refused administrator session request of an account (10 per 15
 * min): past it the request answers 429. Accepted requests are not counted, so
 * an administrator is never held back by this counter.
 */
export async function countSessionRefusal (db: AdminStore, opts: { userId: string; now: number }): Promise<{ allowed: true } | { allowed: false; retryAt: number }> {
  const key = KEYS.sessionRefusalsPrefix + checkKeyId('user id', opts.userId);
  const refusedUntil = await db.bumpWindowedCounter(key, SESSION_REFUSALS_MAX, SESSION_REFUSALS_WINDOW_MS, opts.now);
  return refusedUntil == null ? { allowed: true } : { allowed: false, retryAt: refusedUntil };
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
  // Read, then write over: the row stays readable meanwhile, so the other
  // requests of the session go on (an end still wins: the marker is checked
  // before and after the write).
  const entry = await db.getAccessState(key);
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
 * A session, its role row and the permissions it gives on this core now
 * (`ctx`: this core and its local policy; without it, the `platform` grants
 * alone), with the permissions of its roles refused here; null when the
 * session is unknown or expired, its account holds no active grant, or its
 * sessions were revoked after it was created. A session whose grants give
 * nothing on this core resolves, with no permission: it reaches the routes
 * that need none (its own session, the portal context).
 */
export async function resolveAdminSession (db: AdminStore, token: unknown, now: number, ctx?: PermissionContext): Promise<ResolvedAdminSession | null> {
  const session = await readAdminSession(db, token);
  if (session == null) return null;
  const role = await readRoleRow(db, session.userId);
  if (role == null) return null;
  if (role.sessionsRevokedAt != null && session.createdAt <= role.sessionsRevokedAt) return null;
  if (!hasActiveGrant(role, now)) return null;
  const { permissions, denied } = effectivePermissions(role, now, { core: null, ...ctx, userId: session.userId });
  return { session, role, permissions, denied };
}

/** How far in this core's future a second factor may be stamped (the home core's clock ahead of this one). */
export const STEP_UP_CLOCK_SKEW_MS = 60 * 1000;

/** Whether the session's second factor is recent enough for a step-up act. */
export function isStepUpFresh (session: Pick<AdminSessionRow, 'mfaAt'>, now: number, stepUpMs: number): boolean {
  return session.mfaAt != null && session.mfaAt <= now + STEP_UP_CLOCK_SKEW_MS && now - session.mfaAt <= stepUpMs;
}

// --- Second factor of a sign-in (home core, core-local) --- //

/** The core-local key-value store (`messages/src/cluster_kv.ts` client). */
export type LocalKv = {
  get (key: string): Promise<unknown>;
  set (key: string, value: unknown, opts?: { ttlMs?: number; ifUnderPrefix?: { prefix: string; max: number } }): Promise<boolean>;
};

const MFA_SIGN_IN_PREFIX = 'admin-mfa-sign-in/';
/**
 * Most stamps kept at once on a core. One stamp per account (the latest
 * second-factor sign-in), so the family grows with the accounts signing in
 * with a second factor, not with their sign-ins; past the ceiling a new
 * account's stamp is not written (its admin session then sees no second
 * factor), an account's own stamp is always replaced.
 */
const MFA_SIGN_IN_MAX = 100000;

/** Record that the sign-in which released `token` passed its second factor (the account's latest such sign-in). Best-effort. */
export async function recordMfaSignIn (kv: LocalKv, opts: { token: string; userId: string; now: number; ttlMs: number }): Promise<boolean> {
  if (typeof opts.token !== 'string' || opts.token.length === 0 || !(opts.ttlMs > 0) || typeof opts.userId !== 'string') return false;
  return await kv.set(MFA_SIGN_IN_PREFIX + opts.userId, { token: tokenDigest(opts.token), at: opts.now },
    { ttlMs: opts.ttlMs, ifUnderPrefix: { prefix: MFA_SIGN_IN_PREFIX, max: MFA_SIGN_IN_MAX } });
}

/** When the sign-in that released `token` passed its second factor, if this core recorded it as the account's latest. */
export async function mfaSignInAt (kv: LocalKv, opts: { token: string; userId: string }): Promise<number | null> {
  if (typeof opts.token !== 'string' || opts.token.length === 0 || typeof opts.userId !== 'string') return null;
  const value = await kv.get(MFA_SIGN_IN_PREFIX + opts.userId);
  if (!isPlainObject(value) || value.token !== tokenDigest(opts.token) || typeof value.at !== 'number') return null;
  return value.at;
}

function tokenDigest (token: string): string {
  // Personal access tokens are not of the admin token shape: hash them directly.
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
