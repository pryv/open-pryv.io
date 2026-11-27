/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { PERMISSIONS, PLATFORM_ONLY_WRITES, REGION_SCOPED_PERMISSIONS } from './permissions.ts';
import type { AdminPermission } from './permissions.ts';
import { generateCode, formatCode, hashCode, normalizeCode } from './codes.ts';
import { KEYS, checkKeyId, parseJson, isPlainObject, updatePlatformKv, undoPlatformKvUpdate } from './store.ts';
import type { AdminStore } from './store.ts';
import type { MintedCode } from './setupState.ts';
import { SCOPE_PLATFORM, isScope, parseScope, scopeCoversCore } from './scopes.ts';
import type { CoreContext } from './scopes.ts';
import type { LocalPolicy } from './localPolicy.ts';

export { SCOPE_PLATFORM, isScope } from './scopes.ts';

/**
 * Administrator roles. The authority is the platform KV row
 * `admin-role/<userId>` (the account id in clear, never a username or an
 * email): every core reads it locally and computes the caller's permissions.
 * No credential is stored in it.
 *
 * Roles: `owner` (every permission), `operator`, `support`, `auditor`,
 * `app-reviewer`, `viewer` (bundles below). Scopes: scopes.ts. An unknown
 * role, an invalid scope or an expired grant in a row grants nothing; a
 * scope that names nothing the platform knows (an orphan) matches no core.
 *
 * What a grant gives on a core (`effectivePermissions`):
 * 1. its role's bundle when its scope covers the core, minus the
 *    platform-only writes when the scope is not `platform`; OAuth client and
 *    publisher permissions come from `platform` and `region:<r>` grants only;
 * 2. nothing when this core's local policy does not accept replicated grants;
 * 3. never a permission of the policy's `requireLocalScope`;
 * 4. plus the policy's `localGrants` for the account (bundle minus the
 *    platform-only writes), when it holds an active grant in the row.
 *
 * Claim codes (`admin-claim/<sha256(code)>`, TTL 15 min by default, 24 h at
 * most) carry a role and a scope fixed at mint time: whoever redeems one while
 * signed in gets that grant (`via: claim-code`). Redeeming consumes the row
 * atomically: of two concurrent claims exactly one wins.
 */

export const ROLES = Object.freeze(['owner', 'operator', 'support', 'auditor', 'app-reviewer', 'viewer'] as const);
export type Role = typeof ROLES[number];
export const ROLE_OWNER: Role = 'owner';

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

/** The permissions of each role (a public contract, as the names are). */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly AdminPermission[]>> = Object.freeze({
  owner: PERMISSIONS,
  operator: Object.freeze([
    'setup:read', 'roles:read', 'users:read', 'invitations:read', 'cores:read', 'cores:write', 'config:read',
    'config:write', 'configEffective:read', 'certs:read', 'certs:write', 'dns:read', 'dns:write', 'mail:read',
    'mail:write', 'observability:read', 'observability:write', 'migrations:read', 'integrity:read', 'extId:read',
    'extId:write', 'oauthClients:read', 'publishers:read'
  ] as const),
  support: Object.freeze([
    'users:read', 'users:write', 'users:delete', 'users:resetMfa', 'invitations:read', 'invitations:write',
    'extId:read', 'extId:release', 'autoDeletion:clear'
  ] as const),
  auditor: Object.freeze([
    'setup:read', 'roles:read', 'users:read', 'invitations:read', 'cores:read', 'config:read',
    'configEffective:read', 'certs:read', 'dns:read', 'mail:read', 'observability:read', 'migrations:read',
    'integrity:read', 'audit:read', 'erasures:read', 'extId:read', 'oauthClients:read', 'publishers:read'
  ] as const),
  'app-reviewer': Object.freeze([
    'oauthClients:read', 'oauthClients:write', 'oauthClients:review', 'publishers:read', 'publishers:review'
  ] as const),
  viewer: Object.freeze([
    'cores:read', 'config:read', 'configEffective:read', 'certs:read', 'dns:read', 'mail:read',
    'observability:read', 'migrations:read', 'integrity:read', 'oauthClients:read', 'publishers:read'
  ] as const)
});

const VIAS = new Set<string>(['setup', 'claim-code', 'admin-key', 'grant']);

export function isRole (name: unknown): name is Role {
  return typeof name === 'string' && (ROLES as readonly string[]).includes(name);
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
  if (opts.expiresAt != null && !Number.isFinite(opts.expiresAt)) throw new Error('invalid expiry');
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

/** The grants that count now: known role, scope of valid form (it may be an orphan), not expired. */
export function activeGrants (row: RoleRow | null, now: number): RoleGrant[] {
  if (row == null || !Array.isArray(row.grants)) return [];
  return row.grants.filter((g) => isPlainObject(g) && isRole(g.role) && isScope(g.scope) &&
    (g.expiresAt == null || g.expiresAt > now));
}

/**
 * Whether the row holds an active grant (any role, any scope): what an
 * administrator session needs, on any core, whatever it gives there.
 */
export function hasActiveGrant (row: RoleRow | null, now: number): boolean {
  return activeGrants(row, now).length > 0;
}

/** Why a permission of the account's roles is not held on this core. */
export type DeniedReason = 'local-policy' | 'scope';
export type DeniedPermission = { permission: AdminPermission; reason: DeniedReason };
export type EffectivePermissions = { permissions: Set<AdminPermission>; denied: DeniedPermission[] };

/**
 * Where the permissions are computed: this core (null: no core, only
 * `platform` grants count), its local policy (null: the default, every
 * replicated grant counts) and the account (for the policy's local grants).
 */
export type PermissionContext = { core: CoreContext | null; policy?: LocalPolicy | null; userId?: string | null };

/** Whether a replicated grant of this scope gives `p` on the core of `core` (before the local policy). */
function scopeGives (p: AdminPermission, scope: string, core: CoreContext | null): boolean {
  const s = parseScope(scope);
  if (s == null) return false;
  if (s.kind === 'platform') return true;
  if (PLATFORM_ONLY_WRITES.has(p)) return false;
  if (core == null) return false;
  if (REGION_SCOPED_PERMISSIONS.has(p)) return s.kind === 'region' && core.regions.includes(s.id);
  return scopeCoversCore(scope, core);
}

/**
 * The permissions a role row gives on this core now, and those of its roles
 * it does not give here with the reason (`scope`: the grant's scope does not
 * reach this core or this permission; `local-policy`: this core's policy
 * refuses it). See the header of this file for the rule.
 */
export function effectivePermissions (row: RoleRow | null, now: number, ctx: PermissionContext): EffectivePermissions {
  const permissions = new Set<AdminPermission>();
  const refused = new Map<AdminPermission, DeniedReason>();
  const refuse = (p: AdminPermission, reason: DeniedReason) => {
    // The local policy is the binding reason when both apply.
    if (refused.get(p) !== 'local-policy') refused.set(p, reason);
  };
  const policy = ctx.policy ?? null;
  const grants = activeGrants(row, now);
  for (const grant of grants) {
    for (const p of ROLE_PERMISSIONS[grant.role as Role]) {
      if (!scopeGives(p, grant.scope, ctx.core)) refuse(p, 'scope');
      else if (policy != null && (!policy.acceptReplicatedGrants || policy.requireLocalScope.has(p))) refuse(p, 'local-policy');
      else permissions.add(p);
    }
  }
  // Local grants: for an account holding an active grant in the row only.
  if (policy != null && grants.length > 0 && ctx.userId != null && ctx.core != null) {
    for (const local of policy.localGrants) {
      if (local.userId !== ctx.userId || !isRole(local.role)) continue;
      for (const p of ROLE_PERMISSIONS[local.role]) {
        if (PLATFORM_ONLY_WRITES.has(p)) refuse(p, 'scope');
        else permissions.add(p);
      }
    }
  }
  const denied: DeniedPermission[] = [];
  for (const [permission, reason] of refused) {
    if (!permissions.has(permission)) denied.push({ permission, reason });
  }
  return { permissions, denied };
}

/**
 * The permissions a role row gives now: on the core of `ctx` under its local
 * policy, or, without `ctx`, those of the `platform` grants alone.
 */
export function permissionsOf (row: RoleRow | null, now: number, ctx?: PermissionContext): Set<AdminPermission> {
  return effectivePermissions(row, now, ctx ?? { core: null }).permissions;
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
