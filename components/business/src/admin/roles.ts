/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { PERMISSIONS } from './permissions.ts';
import type { AdminPermission } from './permissions.ts';
import { generateCode, formatCode, hashCode, normalizeCode } from './codes.ts';
import { KEYS, checkKeyId, parseJson, isPlainObject, updatePlatformKv, undoPlatformKvUpdate } from './store.ts';
import type { AdminStore } from './store.ts';
import type { MintedCode } from './setupState.ts';

/**
 * Administrator roles. The authority is the platform KV row
 * `admin-role/<userId>` (the account id in clear, never a username or an
 * email): every core reads it locally and computes the caller's permissions.
 * No credential is stored in it.
 *
 * Roles: `owner` (every permission). Scopes: `platform`. Other roles and
 * scopes are added by name; an unknown role or scope in a row grants nothing.
 *
 * Claim codes (`admin-claim/<sha256(code)>`, TTL 15 min by default, 24 h at
 * most) carry a role and a scope fixed at mint time: whoever redeems one while
 * signed in gets that grant (`via: claim-code`). Redeeming consumes the row
 * atomically: of two concurrent claims exactly one wins.
 */

export const ROLES = Object.freeze(['owner'] as const);
export type Role = typeof ROLES[number];
export const ROLE_OWNER: Role = 'owner';
export const SCOPE_PLATFORM = 'platform';

export type GrantVia = 'setup' | 'claim-code' | 'admin-key' | 'grant';

export type RoleGrant = {
  role: string;
  scope: string;
  grantedAt: number;
  /** An account id, `admin-key`, or `setup`. */
  grantedBy: string;
  via: GrantVia;
  expiresAt?: number | null;
};

export type RoleRow = {
  grants: RoleGrant[];
  updatedAt: number;
  /** Admin sessions created before this time are refused (sessions cannot be listed to delete them). */
  sessionsRevokedAt?: number | null;
};

export type ClaimCodeRow = { role: string; scope: string; mintedBy: string; mintedAt: number };

export const CLAIM_TTL_DEFAULT_MS = 15 * 60 * 1000;
export const CLAIM_TTL_MAX_MS = 24 * 3600 * 1000;
export const CLAIM_ATTEMPTS_MAX = 10;
export const CLAIM_ATTEMPTS_WINDOW_MS = 15 * 60 * 1000;

const ROLE_PERMISSIONS: Record<Role, readonly AdminPermission[]> = {
  owner: PERMISSIONS
};

const VIAS = new Set<string>(['setup', 'claim-code', 'admin-key', 'grant']);

export function isRole (name: unknown): name is Role {
  return typeof name === 'string' && (ROLES as readonly string[]).includes(name);
}

export function isScope (scope: unknown): scope is string {
  return scope === SCOPE_PLATFORM;
}

function checkActor (by: unknown): string {
  if (typeof by !== 'string' || by.length === 0 || by.length > 128) throw new Error('invalid actor');
  return by;
}

function roleKey (userId: string): string {
  return KEYS.rolePrefix + checkKeyId('user id', userId);
}

function parseRow (raw: string | null): RoleRow | null {
  const parsed = parseJson<unknown>(raw);
  if (!isPlainObject(parsed) || !Array.isArray(parsed.grants)) return null;
  return parsed as RoleRow;
}

export async function readRoleRow (db: AdminStore, userId: string): Promise<RoleRow | null> {
  return parseRow(await db.getPlatformKv(roleKey(userId)));
}

/** Every role row, by account id. */
export async function listRoleRows (db: AdminStore): Promise<Array<{ userId: string; row: RoleRow }>> {
  const out: Array<{ userId: string; row: RoleRow }> = [];
  for (const { key, value } of await db.listPlatformKvEntries(KEYS.rolePrefix)) {
    const row = parseRow(value);
    if (row != null) out.push({ userId: key.slice(KEYS.rolePrefix.length), row });
  }
  return out;
}

/**
 * Refused: the change would leave the platform without a lasting `owner`
 * grant (one at scope `platform` with no expiry). `bin/admin.js --force`
 * passes `force` to do it anyway; recovery is then the admin key and a claim
 * code.
 */
export class LastOwnerError extends Error {
  readonly id = 'last-owner';
  constructor () {
    super('This is the last lasting owner grant of the platform: grant the owner role to another account first.');
    this.name = 'LastOwnerError';
  }
}

/** Whether a grant keeps the platform owned: `owner` at scope `platform`, no expiry. */
function isLastingOwnerGrant (g: RoleGrant): boolean {
  return isPlainObject(g) && g.role === ROLE_OWNER && g.scope === SCOPE_PLATFORM && g.expiresAt == null;
}

/** The accounts holding a lasting owner grant. */
export async function lastingOwners (db: AdminStore): Promise<string[]> {
  return (await listRoleRows(db))
    .filter(({ row }) => row.grants.some(isLastingOwnerGrant))
    .map(({ userId }) => userId);
}

/**
 * Throws LastOwnerError when `userId` holds a lasting owner grant now, would
 * not after the change (`grantsAfter`), and no other account holds one. A
 * platform with no lasting owner at all (one that predates setup) is not
 * blocked: there is nothing to protect.
 */
async function checkLastOwner (db: AdminStore, userId: string, before: RoleGrant[], after: RoleGrant[]): Promise<void> {
  if (!before.some(isLastingOwnerGrant)) return;
  if (after.some(isLastingOwnerGrant)) return;
  const others = (await lastingOwners(db)).filter((id) => id !== userId);
  if (others.length === 0) throw new LastOwnerError();
}

/**
 * Add a grant (replacing one of the same role and scope). Answers the row
 * written. Replacing the last lasting owner grant by one that expires throws
 * LastOwnerError unless `force`.
 */
export async function grantRole (db: AdminStore, userId: string, opts: {
  role: Role; scope: string; grantedBy: string; via: GrantVia; now: number; expiresAt?: number | null; force?: boolean;
}): Promise<RoleRow> {
  if (!isRole(opts.role)) throw new Error('unknown role');
  if (!isScope(opts.scope)) throw new Error('unknown scope');
  if (!VIAS.has(opts.via)) throw new Error('invalid via');
  const grant: RoleGrant = { role: opts.role, scope: opts.scope, grantedAt: opts.now, grantedBy: checkActor(opts.grantedBy), via: opts.via };
  if (opts.expiresAt != null) grant.expiresAt = opts.expiresAt;
  const key = roleKey(userId);
  const done = await updatePlatformKv(db, key, async (raw) => {
    const current = parseRow(raw);
    const grants = (current?.grants ?? []).filter((g) => !(g.role === grant.role && g.scope === grant.scope));
    grants.push(grant);
    if (opts.force !== true) await checkLastOwner(db, userId, current?.grants ?? [], grants);
    // A new row (the account held no role): a session left from a role this
    // account held before (its row deleted, the session row not yet
    // expired) stays refused.
    const row: RoleRow = current == null
      ? { grants, updatedAt: opts.now, sessionsRevokedAt: opts.now - 1 }
      : { ...current, grants, updatedAt: opts.now };
    return { next: JSON.stringify(row), result: { row, lostOwner: current?.grants.some(isLastingOwnerGrant) === true && !grants.some(isLastingOwnerGrant) } };
  });
  if (done == null) throw new Error('grantRole: no change made');
  if (done.result.lostOwner && opts.force !== true) await recheckOwners(db, key, done.before, done.after);
  return done.result.row;
}

/**
 * After a write that removed `userId`'s lasting owner grant: when a racing
 * change elsewhere left the platform without any lasting owner, the write is
 * undone and refused. Two racing removals of the last two owners then both
 * fail (the safe side).
 */
async function recheckOwners (db: AdminStore, key: string, before: string | null, after: string | null): Promise<void> {
  if ((await lastingOwners(db)).length > 0) return;
  await undoPlatformKvUpdate(db, key, before, after);
  throw new LastOwnerError();
}

/**
 * Remove grants: all of them (the row is deleted) when no role is given, else
 * those of that role (and scope, when given). True when something was removed.
 * Removing the last lasting owner grant of the platform throws LastOwnerError
 * unless `force`.
 */
export async function revokeRole (db: AdminStore, userId: string, opts: { role?: string; scope?: string; now: number; force?: boolean }): Promise<boolean> {
  const key = roleKey(userId);
  const done = await updatePlatformKv(db, key, async (raw) => {
    const current = parseRow(raw);
    if (current == null) return null;
    const keep = opts.role == null
      ? []
      : current.grants.filter((g) => !(g.role === opts.role && (opts.scope == null || g.scope === opts.scope)));
    if (keep.length === current.grants.length) return null;
    if (opts.force !== true) await checkLastOwner(db, userId, current.grants, keep);
    const next = keep.length === 0 ? null : JSON.stringify({ ...current, grants: keep, updatedAt: opts.now });
    return { next, result: current.grants.some(isLastingOwnerGrant) && !keep.some(isLastingOwnerGrant) };
  });
  if (done == null) return false;
  if (done.result && opts.force !== true) await recheckOwners(db, key, done.before, done.after);
  return true;
}

/** Refuse every admin session of this account created before `now`. False when it holds no role. */
export async function revokeSessionsOf (db: AdminStore, userId: string, now: number): Promise<boolean> {
  const done = await updatePlatformKv(db, roleKey(userId), (raw) => {
    const current = parseRow(raw);
    if (current == null) return null;
    return { next: JSON.stringify({ ...current, sessionsRevokedAt: now, updatedAt: now }), result: true };
  });
  return done != null;
}

/** The grants that count now: known role and scope, not expired. */
export function activeGrants (row: RoleRow | null, now: number): RoleGrant[] {
  if (row == null) return [];
  return row.grants.filter((g) => isPlainObject(g) && isRole(g.role) && isScope(g.scope) &&
    (g.expiresAt == null || g.expiresAt > now));
}

/** The permissions a role row gives on this core now. */
export function permissionsOf (row: RoleRow | null, now: number): Set<AdminPermission> {
  const out = new Set<AdminPermission>();
  for (const grant of activeGrants(row, now)) {
    for (const p of ROLE_PERMISSIONS[grant.role as Role]) out.add(p);
  }
  return out;
}

/** Mint a claim code for a role and scope. The code is answered once and never stored. */
export async function mintClaimCode (db: AdminStore, opts: {
  role: string; scope: string; mintedBy: string; now: number; ttlMs?: number;
}): Promise<MintedCode> {
  if (!isRole(opts.role)) throw new Error('unknown role');
  if (!isScope(opts.scope)) throw new Error('unknown scope');
  const ttlMs = opts.ttlMs ?? CLAIM_TTL_DEFAULT_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > CLAIM_TTL_MAX_MS) throw new Error('claim code TTL must be more than 0 and at most 24 h');
  const code = generateCode();
  const row: ClaimCodeRow = { role: opts.role, scope: opts.scope, mintedBy: checkActor(opts.mintedBy), mintedAt: opts.now };
  const expiresAt = opts.now + ttlMs;
  await db.setAccessState(KEYS.claimCodePrefix + hashCode(code), row, expiresAt);
  return { code, display: formatCode(code), expiresAt };
}

/**
 * Redeem a claim code for an account: the code is consumed and its grant
 * written. Null when the code is unknown, expired or already used.
 */
export async function claimRole (db: AdminStore, input: unknown, opts: { userId: string; now: number }): Promise<{ row: RoleRow; grant: ClaimCodeRow } | null> {
  checkKeyId('user id', opts.userId);
  const canonical = normalizeCode(input);
  if (canonical == null) return null;
  const entry = await db.consumeAccessState(KEYS.claimCodePrefix + hashCode(canonical));
  if (entry == null || !isPlainObject(entry.value)) return null;
  const grant = entry.value as ClaimCodeRow;
  if (!isRole(grant.role) || !isScope(grant.scope)) return null;
  const row = await grantRole(db, opts.userId, {
    role: grant.role, scope: grant.scope, grantedBy: grant.mintedBy, via: 'claim-code', now: opts.now
  });
  return { row, grant };
}

/** Count one claim attempt of an account (10 per 15 min). */
export async function countClaimAttempt (db: AdminStore, opts: { userId: string; now: number }): Promise<{ allowed: true } | { allowed: false; retryAt: number }> {
  const key = KEYS.claimAttemptsPrefix + checkKeyId('user id', opts.userId);
  const refusedUntil = await db.bumpWindowedCounter(key, CLAIM_ATTEMPTS_MAX, CLAIM_ATTEMPTS_WINDOW_MS, opts.now);
  return refusedUntil == null ? { allowed: true } : { allowed: false, retryAt: refusedUntil };
}
