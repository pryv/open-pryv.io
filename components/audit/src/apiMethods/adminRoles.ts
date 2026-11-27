/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Audit method ids of role management (grants, reads of one account's roles).
 * Joined into the lists of ../ApiMethods.ts:
 * - all: every id (API methods and acts recorded directly);
 * - notAudited: ids of all that are never recorded (reads);
 * - withoutUser: recorded ids whose call has no account of this core in its context.
 *
 * `admin.role.granted` and `admin.role.revoked` are rows of the grantee's own
 * trail (emitted directly via audit.eventForUser() when the account is on the
 * core where the act ran); the acting administrator's trail gets
 * `admin.role.created` / `admin.role.deleted` (../ApiMethods.ts).
 */
export const all: readonly string[] = Object.freeze([
  'system.roles.set',
  'system.roles.get',
  'system.roles.getByUsername',
  'admin.role.granted',
  'admin.role.revoked'
]);
export const notAudited: readonly string[] = Object.freeze([
  'system.roles.get',
  'system.roles.getByUsername'
]);
export const withoutUser: readonly string[] = Object.freeze([
  'system.roles.set'
]);
