/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { PERMISSIONS } from './permissions.ts';
import type { AdminPermission } from './permissions.ts';
import { generateCode, formatCode, hashCode, normalizeCode } from './codes.ts';
import { KEYS, checkKeyId, parseJson, isPlainObject } from './store.ts';
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

/** Add a grant (replacing one of the same role and scope). Answers the row written. */
export async function grantRole (db: AdminStore, userId: string, opts: {
  role: Role; scope: string; grantedBy: string; via: GrantVia; now: number; expiresAt?: number | null;
}): Promise<RoleRow> {
  if (!isRole(opts.role)) throw new Error('unknown role');
  if (!isScope(opts.scope)) throw new Error('unknown scope');
  if (!VIAS.has(opts.via)) throw new Error('invalid via');
  const grant: RoleGrant = { role: opts.role, scope: opts.scope, grantedAt: opts.now, grantedBy: checkActor(opts.grantedBy), via: opts.via };
  if (opts.expiresAt != null) grant.expiresAt = opts.expiresAt;
  const current = await readRoleRow(db, userId);
  const grants = (current?.grants ?? []).filter((g) => !(g.role === grant.role && g.scope === grant.scope));
  grants.push(grant);
  const row: RoleRow = { ...(current ?? {}), grants, updatedAt: opts.now };
  await db.setPlatformKv(roleKey(userId), JSON.stringify(row));
  return row;
}

/**
 * Remove grants: all of them (the row is deleted) when no role is given, else
 * those of that role (and scope, when given). True when something was removed.
 */
export async function revokeRole (db: AdminStore, userId: string, opts: { role?: string; scope?: string; now: number }): Promise<boolean> {
  const current = await readRoleRow(db, userId);
  if (current == null) return false;
  const keep = opts.role == null
    ? []
    : current.grants.filter((g) => !(g.role === opts.role && (opts.scope == null || g.scope === opts.scope)));
  if (keep.length === current.grants.length) return false;
  if (keep.length === 0) {
    await db.deletePlatformKv(roleKey(userId));
  } else {
    await db.setPlatformKv(roleKey(userId), JSON.stringify({ ...current, grants: keep, updatedAt: opts.now }));
  }
  return true;
}

/** Refuse every admin session of this account created before `now`. False when it holds no role. */
export async function revokeSessionsOf (db: AdminStore, userId: string, now: number): Promise<boolean> {
  const current = await readRoleRow(db, userId);
  if (current == null) return false;
  await db.setPlatformKv(roleKey(userId), JSON.stringify({ ...current, sessionsRevokedAt: now, updatedAt: now }));
  return true;
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
