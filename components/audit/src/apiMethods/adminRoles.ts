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
 *
 * `admin.cli.*`: the acts of `bin/admin.js` (run from a core's shell, outside
 * the server), written by the tool itself in the platform trail with
 * `subject: { via: 'cli', osUser }` (they are in the `admin-acts` group).
 */
export const CLI_ACTS: readonly string[] = Object.freeze([
  'admin.cli.setupCode.replaced',
  'admin.cli.setup.finished',
  'admin.cli.claimCode.created',
  'admin.cli.role.granted',
  'admin.cli.role.deleted',
  'admin.cli.sessions.revoked'
]);
export const all: readonly string[] = Object.freeze([
  'system.roles.set',
  'system.roles.get',
  'system.roles.getByUsername',
  'admin.role.granted',
  'admin.role.revoked',
  ...CLI_ACTS
]);
export const notAudited: readonly string[] = Object.freeze([
  'system.roles.get',
  'system.roles.getByUsername'
]);
export const withoutUser: readonly string[] = Object.freeze([
  'system.roles.set',
  ...CLI_ACTS
]);
