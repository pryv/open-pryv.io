/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Administrator permissions: the names the server checks on every admin route
 * (`<capability>:<action>`), shared with the administration portal, which
 * gates its modules on the same names. A role is a bundle of these names
 * (see roles.ts); a route needs one of them (see the route table of the
 * api-server). Where a grant gives them: scopes.ts and roles.ts.
 *
 * The list is a public contract: a name is added, never renamed or reused
 * with another meaning.
 */

export const PERMISSIONS = Object.freeze([
  'setup:read',
  'setup:write',
  'roles:read',
  'roles:grant',
  'claimCodes:mint',
  'users:read',
  'users:write',
  'users:delete',
  'users:resetMfa',
  'invitations:read',
  'invitations:write',
  'cores:read',
  'cores:write',
  'config:read',
  'config:write',
  'configEffective:read',
  'certs:read',
  'certs:write',
  'dns:read',
  'dns:write',
  'mail:read',
  'mail:write',
  'observability:read',
  'observability:write',
  'migrations:read',
  'integrity:read',
  'audit:read',
  'erasures:read',
  'extId:read',
  'extId:write',
  'extId:release',
  'autoDeletion:clear',
  'delegation:write',
  'oauthClients:read',
  'oauthClients:write',
  'oauthClients:review',
  'publishers:read',
  'publishers:review',
  'bootstrap:issue'
] as const);

export type AdminPermission = typeof PERMISSIONS[number];

/**
 * Acts that need a recent second factor (the session's `mfaAt` within
 * `admin.session.stepUpMinutes`), whatever the role.
 */
export const STEP_UP_PERMISSIONS: ReadonlySet<AdminPermission> = new Set<AdminPermission>([
  'roles:grant',
  'claimCodes:mint',
  'users:delete'
]);

/**
 * Writes on platform-wide state: a grant gives them only at scope `platform`
 * (a grant scoped to a region, zone, hosting or core, and a local grant,
 * never do).
 */
export const PLATFORM_ONLY_WRITES: ReadonlySet<AdminPermission> = new Set<AdminPermission>([
  'roles:grant',
  'claimCodes:mint',
  'setup:write',
  'config:write',
  'dns:write',
  'mail:write',
  'observability:write',
  'extId:write',
  'cores:write',
  'bootstrap:issue',
  'delegation:write'
]);

/** Held by the `owner` role only. */
export const OWNER_ONLY_PERMISSIONS: ReadonlySet<AdminPermission> = new Set<AdminPermission>([
  'claimCodes:mint',
  'roles:grant',
  'setup:write',
  'delegation:write',
  'bootstrap:issue'
]);

/**
 * OAuth client and publisher permissions: given by grants at scope
 * `platform` or `region:<r>` (any region the hierarchy knows: the method
 * checks the row's regions), never by narrower scopes.
 */
export const REGION_SCOPED_PERMISSIONS: ReadonlySet<AdminPermission> = new Set<AdminPermission>([
  'oauthClients:read',
  'oauthClients:write',
  'oauthClients:review',
  'publishers:read',
  'publishers:review'
]);

const KNOWN = new Set<string>(PERMISSIONS);

export function isPermission (name: unknown): name is AdminPermission {
  return typeof name === 'string' && KNOWN.has(name);
}

/** The capability part of a permission name (`users` for `users:read`). */
export function capabilityOf (permission: AdminPermission): string {
  return permission.slice(0, permission.indexOf(':'));
}
