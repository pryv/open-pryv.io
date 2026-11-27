/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { isPermission, PLATFORM_ONLY_WRITES, REGION_SCOPED_PERMISSIONS } from './permissions.ts';
import { describeHostings } from './scopes.ts';
import type { AdminPermission } from './permissions.ts';
import { ROLES, isRole } from './roles.ts';
import type { Role } from './roles.ts';

/**
 * This core's local policy on administrator grants (`admin.localPolicy`,
 * per-core YAML, never in the platform store):
 *
 * - `acceptReplicatedGrants` (true): false: the grants of the platform store
 *   give nothing on this core, only `localGrants` do.
 * - `requireLocalScope` ([]): permission names that only `localGrants` give
 *   on this core, whatever the scope of a replicated grant (any core can
 *   write a replicated row; only this core's own file protects it).
 * - `localGrants` ([]): `{ userId, role }`, this core only: the role's
 *   permissions minus the platform-only writes and minus the OAuth client and
 *   publisher permissions (platform-wide registries: a core-level grant never
 *   gives them). A local grant counts for an account that holds an active
 *   grant in the platform store (its session and its revocation live there);
 *   for any other account it gives nothing.
 *
 * So on a core with `acceptReplicatedGrants: false` no session holds the
 * OAuth client and publisher permissions (review them on a core that accepts
 * replicated grants, or with the admin key).
 *
 * The policy binds role holders, never the admin key nor a setup session.
 * Cores holding different policies is expected. The validator also checks
 * the `hostings` hierarchy the grant scopes are matched against (scopes.ts).
 */

type ConfigReader = { get: (key: string) => unknown };

export type LocalGrant = { userId: string; role: Role };

export type LocalPolicy = {
  acceptReplicatedGrants: boolean;
  requireLocalScope: ReadonlySet<AdminPermission>;
  localGrants: readonly LocalGrant[];
};

export type LocalPolicyReport = {
  value: LocalPolicy;
  problems: Array<{ message: string; path: string[] }>;
  warnings: string[];
};

/** What the portal context shows of the policy, or null when there is nothing to show. */
export type LocalPolicyView = {
  acceptReplicatedGrants: boolean;
  requireLocalScope: string[];
  /** The roles this core grants locally to the subject (never other accounts' grants). */
  localRoles: string[];
};

/** The policy of a core with no `admin.localPolicy` block: every replicated grant counts. */
export const DEFAULT_LOCAL_POLICY: LocalPolicy = Object.freeze({
  acceptReplicatedGrants: true,
  requireLocalScope: new Set<AdminPermission>(),
  localGrants: Object.freeze([]) as readonly LocalGrant[]
});

/** Same format as the platform store's key ids (`store.ts` `checkKeyId`). */
const USER_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const POLICY_KEYS = ['acceptReplicatedGrants', 'requireLocalScope', 'localGrants'];
const GRANT_KEYS = ['userId', 'role'];

function isObject (v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Validates `admin.localPolicy`. Never throws; problems name their key path. */
export function describeLocalPolicy (config: ConfigReader): LocalPolicyReport {
  const problems: Array<{ message: string; path: string[] }> = [];
  const warnings: string[] = [];
  const problem = (path: string, message: string) => problems.push({ message: `${path} ${message}`, path: path.split('.') });
  const base = 'admin.localPolicy';
  // The hierarchy grant scopes are matched against: a zone or hosting key
  // listed twice would make a scope ambiguous.
  problems.push(...describeHostings(config));
  const raw = config.get('admin:localPolicy');
  if (raw == null) return { value: DEFAULT_LOCAL_POLICY, problems, warnings };
  if (!isObject(raw)) {
    problem(base, 'must be an object with acceptReplicatedGrants, requireLocalScope and localGrants');
    return { value: DEFAULT_LOCAL_POLICY, problems, warnings };
  }
  for (const key of Object.keys(raw)) {
    if (!POLICY_KEYS.includes(key)) problem(`${base}.${key}`, `is not a key of ${base} (keys: ${POLICY_KEYS.join(', ')})`);
  }

  let acceptReplicatedGrants = true;
  const rawAccept = raw.acceptReplicatedGrants;
  if (rawAccept === false || rawAccept === 'false') acceptReplicatedGrants = false;
  else if (rawAccept != null && rawAccept !== true && rawAccept !== 'true') problem(`${base}.acceptReplicatedGrants`, 'must be true or false');

  const requireLocalScope = new Set<AdminPermission>();
  const rawRequire = raw.requireLocalScope;
  if (rawRequire != null) {
    if (!Array.isArray(rawRequire)) {
      problem(`${base}.requireLocalScope`, 'must be a list of administrator permission names');
    } else {
      for (const p of rawRequire) {
        if (!isPermission(p)) {
          problem(`${base}.requireLocalScope`, `holds ${JSON.stringify(p)}, which is not an administrator permission name`);
          continue;
        }
        requireLocalScope.add(p);
        if (PLATFORM_ONLY_WRITES.has(p) || REGION_SCOPED_PERMISSIONS.has(p)) {
          warnings.push(`${base}.requireLocalScope lists ${p}, a permission on platform-wide state that a local grant never gives: nobody holds it on this core.`);
        }
      }
    }
  }

  const localGrants: LocalGrant[] = [];
  const rawGrants = raw.localGrants;
  if (rawGrants != null) {
    if (!Array.isArray(rawGrants)) {
      problem(`${base}.localGrants`, 'must be a list of { userId, role }');
    } else {
      rawGrants.forEach((g, i) => {
        const path = `${base}.localGrants.${i}`;
        if (!isObject(g)) return problem(path, 'must be { userId, role }');
        const extra = Object.keys(g).filter((k) => !GRANT_KEYS.includes(k));
        if (extra.length > 0) problem(path, `has unknown key(s) ${extra.join(', ')} (a local grant is { userId, role }: it counts on this core only, it has no scope)`);
        const okUser = typeof g.userId === 'string' && USER_ID_RE.test(g.userId);
        if (!okUser) problem(`${path}.userId`, 'must be an account id (1 to 128 of A-Z a-z 0-9 . _ -)');
        const okRole = isRole(g.role);
        if (!okRole) problem(`${path}.role`, `must be one of: ${ROLES.join(', ')}`);
        if (okUser && okRole && extra.length === 0) localGrants.push({ userId: g.userId as string, role: g.role as Role });
      });
    }
  }

  return { value: { acceptReplicatedGrants, requireLocalScope, localGrants }, problems, warnings };
}

/** The resolved policy; throws one Error listing every problem (the core does not boot with one). */
export function readLocalPolicy (config: ConfigReader): LocalPolicy {
  const { value, problems } = describeLocalPolicy(config);
  if (problems.length > 0) throw new Error('Invalid admin.localPolicy: ' + problems.map((p) => p.message).join('; '));
  return value;
}

function isDefault (p: LocalPolicy): boolean {
  return p.acceptReplicatedGrants && p.requireLocalScope.size === 0 && p.localGrants.length === 0;
}

/** The policy as the portal context shows it to `subject`, or null when it is the default (or invalid). */
export function policyView (config: ConfigReader, subject?: { userId?: string }): LocalPolicyView | null {
  const { value, problems } = describeLocalPolicy(config);
  if (problems.length > 0 || isDefault(value)) return null;
  const userId = subject?.userId;
  return {
    acceptReplicatedGrants: value.acceptReplicatedGrants,
    requireLocalScope: [...value.requireLocalScope],
    localRoles: userId == null ? [] : [...new Set(value.localGrants.filter((g) => g.userId === userId).map((g) => g.role))]
  };
}

/** The boot log line stating this core's effective policy (no account id in it). */
export function localPolicyLine (config: ConfigReader): string {
  const { value, problems } = describeLocalPolicy(config);
  if (problems.length > 0) return 'admin.localPolicy is invalid: ' + problems.map((p) => p.message).join('; ');
  if (isDefault(value)) return 'admin local policy: default (replicated grants accepted, no local scope required, no local grants)';
  const byRole = new Map<string, number>();
  for (const g of value.localGrants) byRole.set(g.role, (byRole.get(g.role) ?? 0) + 1);
  const grants = value.localGrants.length === 0
    ? 'no local grants'
    : `${value.localGrants.length} local grant(s) (${[...byRole].map(([r, n]) => `${r}: ${n}`).join(', ')})`;
  return 'admin local policy: replicated grants ' + (value.acceptReplicatedGrants ? 'accepted' : 'NOT accepted (local grants only)') +
    '; local scope required for: ' + (value.requireLocalScope.size === 0 ? 'none' : [...value.requireLocalScope].join(', ')) +
    '; ' + grants;
}
