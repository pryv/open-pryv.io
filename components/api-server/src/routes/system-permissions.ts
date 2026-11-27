/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { AdminRouteRule } from 'middleware/src/adminAuth.ts';

/**
 * Every route under `/system` and what it accepts: the permission an
 * administrator session needs (`business/src/admin/permissions.ts`), whether
 * the admin key still reaches it with `auth.adminAccessKeyScope: break-glass`,
 * or its own kind of credential. The gate (`middleware/src/adminAuth.ts`)
 * reads this table; a test fails on a `/system` route without an entry, and on
 * an entry without a route.
 *
 * Break-glass routes: core to core, setup code, claim codes, role listing and
 * revocation, status. Core-to-core routes accept the admin key only.
 */

export type SystemRouteEntry = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  /** The API method id, when the route has one. */
  methodId: string | null;
  rule: AdminRouteRule;
};

const KEY_ONLY = ['key'] as const;
const SESSION_ONLY = ['session'] as const;
const SETUP_ONLY = ['setup'] as const;
const WITH_SETUP = ['key', 'session', 'setup'] as const;

export const SYSTEM_ROUTES: readonly SystemRouteEntry[] = Object.freeze([
  // --- accounts --- //
  { method: 'POST', path: '/system/create-user', methodId: 'system.createUser', rule: { auth: 'admin', permission: 'users:write' } },
  { method: 'GET', path: '/system/user-info/:username', methodId: 'system.getUserInfo', rule: { auth: 'admin', permission: 'users:read' } },
  { method: 'DELETE', path: '/system/users/:username/mfa', methodId: 'system.deactivateMfa', rule: { auth: 'admin', permission: 'users:resetMfa' } },
  { method: 'GET', path: '/system/accesses/:accessId', methodId: 'system.getAccess', rule: { auth: 'admin', permission: 'users:read' } },
  { method: 'GET', path: '/system/admin/users', methodId: 'system.listUsers', rule: { auth: 'admin', permission: 'users:read' } },
  { method: 'POST', path: '/system/users/validate', methodId: null, rule: { auth: 'admin', permission: 'users:write' } },
  { method: 'PUT', path: '/system/users', methodId: null, rule: { auth: 'admin', permission: 'users:write' } },
  { method: 'DELETE', path: '/system/users/:username', methodId: null, rule: { auth: 'admin', permission: 'users:delete' } },
  { method: 'POST', path: '/system/admin/auto-deletion/clear', methodId: 'system.autoDeletion.reset', rule: { auth: 'admin', permission: 'autoDeletion:clear' } },
  // --- cores --- //
  { method: 'GET', path: '/system/admin/cores', methodId: 'system.listCores', rule: { auth: 'admin', permission: 'cores:read', breakGlass: true } },
  { method: 'POST', path: '/system/admin/cores/ack', methodId: null, rule: { auth: 'joinToken' } },
  // --- external ids --- //
  { method: 'GET', path: '/system/admin/ext-id-ns', methodId: 'system.extIdNamespaces.list', rule: { auth: 'admin', permission: 'extId:read' } },
  { method: 'GET', path: '/system/admin/ext-id-ns/:namespace', methodId: 'system.extIdNamespaces.get', rule: { auth: 'admin', permission: 'extId:read' } },
  { method: 'PUT', path: '/system/admin/ext-id-ns/:namespace', methodId: 'system.extIdNamespaces.set', rule: { auth: 'admin', permission: 'extId:write' } },
  { method: 'DELETE', path: '/system/admin/ext-id-ns/:namespace', methodId: 'system.extIdNamespaces.delete', rule: { auth: 'admin', permission: 'extId:write' } },
  { method: 'POST', path: '/system/admin/ext-id/release', methodId: 'system.extIdRelease', rule: { auth: 'admin', permission: 'extId:release' } },
  { method: 'POST', path: '/system/ext-id/holds', methodId: 'system.extIdHolds', rule: { auth: 'admin', permission: 'extId:read', breakGlass: true, accepts: KEY_ONLY } },
  // --- erasures, configuration, status --- //
  { method: 'GET', path: '/system/admin/erasures', methodId: 'system.erasures.list', rule: { auth: 'admin', permission: 'erasures:read' } },
  { method: 'POST', path: '/system/admin/erasures/lookup', methodId: 'system.erasures.get', rule: { auth: 'admin', permission: 'erasures:read' } },
  { method: 'GET', path: '/system/admin/config/effective', methodId: 'system.getEffectiveConfig', rule: { auth: 'admin', permission: 'configEffective:read' } },
  { method: 'GET', path: '/system/event-types-status', methodId: 'system.getEventTypesStatus', rule: { auth: 'admin', permission: 'observability:read', breakGlass: true } },
  { method: 'GET', path: '/system/migrations-status', methodId: 'system.getMigrationsStatus', rule: { auth: 'admin', permission: 'migrations:read', breakGlass: true } },
  { method: 'GET', path: '/system/audit-status', methodId: 'system.getAuditStatus', rule: { auth: 'admin', permission: 'observability:read', breakGlass: true } },
  { method: 'GET', path: '/system/check-platform-integrity', methodId: 'system.checkPlatformIntegrity', rule: { auth: 'admin', permission: 'integrity:read', breakGlass: true } },
  // --- certificates, mail --- //
  { method: 'POST', path: '/system/admin/certs/force-renew', methodId: null, rule: { auth: 'admin', permission: 'certs:write' } },
  { method: 'GET', path: '/system/admin/certs', methodId: null, rule: { auth: 'admin', permission: 'certs:read' } },
  { method: 'GET', path: '/system/admin/mail/templates', methodId: null, rule: { auth: 'admin', permission: 'mail:read' } },
  { method: 'GET', path: '/system/admin/mail/templates/:type/:lang/:part', methodId: null, rule: { auth: 'admin', permission: 'mail:read' } },
  { method: 'PUT', path: '/system/admin/mail/templates/:type/:lang/:part', methodId: null, rule: { auth: 'admin', permission: 'mail:write' } },
  { method: 'DELETE', path: '/system/admin/mail/templates/:type/:lang/:part', methodId: null, rule: { auth: 'admin', permission: 'mail:write' } },
  { method: 'POST', path: '/system/admin/mail/send-test', methodId: null, rule: { auth: 'admin', permission: 'mail:write' } },
  // --- account delegation (core to core) --- //
  { method: 'POST', path: '/system/delegation/invite', methodId: null, rule: { auth: 'admin', permission: 'delegation:write', breakGlass: true, accepts: KEY_ONLY } },
  { method: 'POST', path: '/system/delegation/create-account', methodId: null, rule: { auth: 'admin', permission: 'delegation:write', breakGlass: true, accepts: KEY_ONLY } },
  // --- setup --- //
  { method: 'GET', path: '/system/setup/', methodId: null, rule: { auth: 'public' } },
  { method: 'GET', path: '/system/setup/setup.js', methodId: null, rule: { auth: 'public' } },
  { method: 'GET', path: '/system/setup/setup.css', methodId: null, rule: { auth: 'public' } },
  { method: 'GET', path: '/system/setup/status', methodId: 'system.setup.getStatus', rule: { auth: 'public' } },
  { method: 'GET', path: '/system/setup/checks', methodId: 'system.setup.getChecks', rule: { auth: 'admin', permission: 'setup:read', breakGlass: true, accepts: WITH_SETUP } },
  { method: 'POST', path: '/system/setup/session', methodId: 'system.setup.createSession', rule: { auth: 'public' } },
  { method: 'POST', path: '/system/setup/first-admin', methodId: 'system.setup.createFirstAdmin', rule: { auth: 'admin', permission: 'roles:grant', accepts: SETUP_ONLY } },
  { method: 'POST', path: '/system/setup/finish', methodId: 'system.setup.setReady', rule: { auth: 'admin', permission: 'setup:write', accepts: ['key', 'setup'] } },
  { method: 'POST', path: '/system/admin/setup/code', methodId: 'system.setup.replaceCode', rule: { auth: 'admin', permission: 'setup:write', breakGlass: true, accepts: WITH_SETUP } },
  // --- administrator sessions --- //
  { method: 'POST', path: '/system/admin/session', methodId: 'system.adminSession.create', rule: { auth: 'personal' } },
  { method: 'GET', path: '/system/admin/session', methodId: 'system.adminSession.get', rule: { auth: 'admin', permission: null, accepts: SESSION_ONLY } },
  { method: 'DELETE', path: '/system/admin/session', methodId: 'system.adminSession.delete', rule: { auth: 'admin', permission: null, accepts: SESSION_ONLY } },
  { method: 'POST', path: '/system/admin/session/renew', methodId: 'system.adminSession.updateExpiry', rule: { auth: 'admin', permission: null, accepts: SESSION_ONLY } },
  { method: 'POST', path: '/system/admin/session/step-up', methodId: 'system.adminSession.verifyStepUp', rule: { auth: 'admin', permission: null, accepts: SESSION_ONLY } },
  // --- roles and claim codes --- //
  // Not the setup session: a claim code outlives it (and `finish`); the first administrator comes from first-admin.
  { method: 'POST', path: '/system/admin/claim-codes', methodId: 'system.claimCodes.create', rule: { auth: 'admin', permission: 'claimCodes:mint', breakGlass: true } },
  { method: 'POST', path: '/system/admin/roles/claim', methodId: 'system.roles.claim', rule: { auth: 'personal' } },
  { method: 'GET', path: '/system/admin/roles', methodId: 'system.roles.list', rule: { auth: 'admin', permission: 'roles:read', breakGlass: true } },
  { method: 'DELETE', path: '/system/admin/roles/:userId', methodId: 'system.roles.delete', rule: { auth: 'admin', permission: 'roles:grant', breakGlass: true } },
  // --- portal --- //
  { method: 'GET', path: '/system/admin/portal/context', methodId: 'system.portalContext.get', rule: { auth: 'admin', permission: null, breakGlass: true, accepts: WITH_SETUP } }
] as SystemRouteEntry[]);

type Compiled = { entry: SystemRouteEntry; segments: string[] };

function segmentsOf (path: string): string[] {
  // Express routing is not strict (a trailing slash matches) and not case-sensitive.
  const trimmed = path.length > 1 ? path.replace(/\/$/, '') : path;
  return trimmed.split('/');
}

/** A matcher over the table: the entry of the route `method path` goes to, or null. */
export function routeMatcher (entries: readonly SystemRouteEntry[] = SYSTEM_ROUTES): (method: string, path: string) => SystemRouteEntry | null {
  const compiled: Compiled[] = entries.map((entry) => ({ entry, segments: segmentsOf(entry.path).map((s) => s.startsWith(':') ? s : s.toLowerCase()) }));
  return function match (method: string, path: string): SystemRouteEntry | null {
    const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
    const parts = segmentsOf(path);
    for (const { entry, segments } of compiled) {
      if (entry.method !== m || segments.length !== parts.length) continue;
      let ok = true;
      for (let i = 0; i < segments.length && ok; i++) {
        ok = segments[i].startsWith(':') ? parts[i].length > 0 : segments[i] === parts[i].toLowerCase();
      }
      if (ok) return entry;
    }
    return null;
  };
}
