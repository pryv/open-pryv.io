/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Audit method ids of the administration audit trail and the administration acts without an API method.
 * Joined into the lists of ../ApiMethods.ts:
 * - all: every id (API methods and acts recorded directly);
 * - notAudited: ids of all that are never recorded (reads);
 * - withoutUser: recorded ids whose call has no account of this core in its context.
 */
export const all: readonly string[] = Object.freeze([
  // The read of the platform trail (GET /system/admin/audit).
  'system.audit.get',
  // /system routes served by an Express handler, each recorded through
  // recordAdminAct (api-server methods/helpers/adminAudit.ts).
  'system.certs.list',
  'system.certs.renew',
  'system.mailTemplates.list',
  'system.mailTemplates.get',
  'system.mailTemplates.set',
  'system.mailTemplates.delete',
  'system.mail.sendTest',
  'system.users.validate',
  'system.users.update',
  'system.users.delete',
  'system.delegation.invite',
  'system.delegation.createAccount',
  'system.cores.ack',
  // Writes with the admin key outside /system (legacy register routes and
  // DNS records), recorded the same way.
  'system.reg.servers.rename',
  'system.reg.invitations.create',
  'system.reg.records.set',
  'system.reg.records.delete',
  // Reads of account data with the admin key under /reg (an account's
  // details, the names of a core's accounts), recorded as system.getUserInfo.
  'system.reg.users.get',
  'system.reg.servers.users.list',
  // An administration act, in the acting administrator's own trail (an
  // administrator session whose account is on this core).
  'admin.act',
  // An administrator read the account's data (system.getUserInfo,
  // system.getAccess, system.reg.users.get), in the account's own trail.
  'account.readByAdmin',
  // An administrator changed the account's platform fields (system.users.update,
  // system.users.delete), in the account's own trail.
  'account.platformFields.changedByAdmin'
]);
export const notAudited: readonly string[] = Object.freeze([
  'system.audit.get',
  'system.certs.list',
  'system.mailTemplates.list',
  'system.mailTemplates.get'
]);
export const withoutUser: readonly string[] = Object.freeze([
  'system.certs.renew',
  'system.mailTemplates.set',
  'system.mailTemplates.delete',
  'system.mail.sendTest',
  'system.users.validate',
  'system.users.update',
  'system.users.delete',
  'system.delegation.invite',
  'system.delegation.createAccount',
  'system.cores.ack',
  'system.reg.servers.rename',
  'system.reg.invitations.create',
  'system.reg.records.set',
  'system.reg.records.delete',
  'system.reg.users.get',
  'system.reg.servers.users.list',
  // Declared in ../ApiMethods.ts: an admin read of an account's data goes to
  // the platform trail (and to the account's trail, `account.readByAdmin`).
  'system.getUserInfo',
  'system.getAccess',
  // Declared in ../ApiMethods.ts: no account in its context.
  'system.listUsers'
]);
