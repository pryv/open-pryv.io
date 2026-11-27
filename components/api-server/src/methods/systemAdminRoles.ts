/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { ResultBag } from './_types.ts';
import type { AdminSubject } from 'middleware/src/adminAuth.ts';
import { auditAs, actorOf, auditAdminAct, wrap } from './helpers/adminAudit.ts';
import type { AdminStore } from 'business/src/admin/store.ts';
import { ROLES, isRole, isScope, grantRole, readRoleRow, activeGrants, LastOwnerError } from 'business/src/admin/roles.ts';
import type { RoleRow, RoleGrant } from 'business/src/admin/roles.ts';
import { hostingsOf, scopeState } from 'business/src/admin/scopes.ts';
import type { ScopeState } from 'business/src/admin/scopes.ts';
import { factory as errors } from 'errors';
import { ready } from '@pryv/boiler';
import { getUsersRepository } from 'business/src/users/index.ts';
import { platform } from 'platform';
import * as storages from 'storages';

/**
 * Methods of role management (routes in routes/system-admin-roles.ts, method
 * ids declared in audit/src/apiMethods/adminRoles.ts). Audit steps:
 * methods/helpers/adminAudit.ts.
 *
 *   system.roles.set              grant a role at a scope to an account (or replace that grant)
 *   system.roles.get              one account's grants
 *   system.roles.getByUsername    the same by username, on the account's home core
 *
 * Only a platform owner manages roles: `roles:grant` is given by grants at
 * scope `platform` only (the /system gate checks it). A grant is recorded in
 * the acting administrator's own trail and, when the account is on this core,
 * in the grantee's trail.
 */

type ConfigReader = { get: (key: string) => unknown };
type RolesContext = { adminSubject?: AdminSubject };

const USER_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const USERNAME_MAX_LENGTH = 100;

/** The scope grammar, as the error messages state it. */
export const SCOPE_GRAMMAR = 'platform, region:<id>, zone:<id>, hosting:<id> or core:<id> (an id is 1 to 128 of A-Z a-z 0-9 . _ -)';

export function roleMessage (param: string): string {
  return '`' + param + '` must be one of: ' + ROLES.join(', ') + '.';
}

export function scopeMessage (param: string): string {
  return '`' + param + '` must be ' + SCOPE_GRAMMAR + '.';
}

/** The core ids the platform knows (this core's included). */
export async function knownCoreIds (): Promise<string[]> {
  const ids = new Set<string>([platform.coreId]);
  try {
    for (const core of await platform.getAllCoreInfos() as Array<{ id?: unknown }>) {
      if (typeof core?.id === 'string') ids.add(core.id);
    }
  } catch {
    // The core list is not readable: this core alone.
  }
  return [...ids];
}

export type GrantView = RoleGrant & { scopeState: ScopeState };

/** The active grants of a row, each with whether its scope names something the platform knows. */
export function grantsView (row: RoleRow | null, now: number, config: ConfigReader, coreIds: readonly string[]): GrantView[] {
  const hostings = hostingsOf(config);
  return activeGrants(row, now).map((g) => ({ ...g, scopeState: scopeState(g.scope, hostings, coreIds) }));
}

export default async function (systemAPI: { register: (...args: unknown[]) => void }): Promise<void> {
  const config = await ready();
  const usersRepository = await getUsersRepository();
  const store = (): AdminStore => storages.platformDB as AdminStore;

  async function roleView (userId: string, row: RoleRow | null, username: string | null) {
    return {
      userId,
      username,
      grants: grantsView(row, Date.now(), config, await knownCoreIds()),
      updatedAt: row?.updatedAt ?? null,
      sessionsRevokedAt: row?.sessionsRevokedAt ?? null
    };
  }

  async function localUsernameOf (userId: string): Promise<string | null> {
    try {
      return (await usersRepository.getUsernameForUserId(userId)) ?? null;
    } catch {
      return null; // not an account of this core
    }
  }

  systemAPI.register('system.roles.set',
    auditAs('subject'),
    wrap(async (context: RolesContext, params, result: ResultBag) => {
      const { userId, role, scope, expiresAt } = params;
      const extra = Object.keys(params).filter((k) => !['userId', 'role', 'scope', 'expiresAt'].includes(k));
      if (extra.length > 0) return errors.invalidParametersFormat('Unknown parameter(s): ' + extra.join(', ') + '.', { parameters: extra });
      if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
        return errors.invalidParametersFormat('The user id must be 1 to 128 of A-Z a-z 0-9 . _ - (GET /system/admin/roles/by-username/:username gives it).', { userId });
      }
      if (!isRole(role)) return errors.invalidParametersFormat(roleMessage('role'), { role });
      if (!isScope(scope)) return errors.invalidParametersFormat(scopeMessage('scope'), { scope });
      const now = Date.now();
      if (expiresAt != null && (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt <= now)) {
        return errors.invalidParametersFormat('`expiresAt` must be a time in the future, in milliseconds since the epoch (or null: no expiry).', { expiresAt });
      }
      const subject = context.adminSubject;
      let row: RoleRow;
      try {
        row = await grantRole(store(), userId, {
          role,
          scope,
          grantedBy: actorOf(subject),
          via: subject?.kind === 'key' ? 'admin-key' : 'grant',
          now,
          expiresAt: (expiresAt as number | null | undefined) ?? null
        });
      } catch (err) {
        if (err instanceof LastOwnerError) return errors.invalidOperation(err.message, { id: err.id });
        throw err;
      }
      result.role = await roleView(userId, row, await localUsernameOf(userId));
      const fields = { target: userId, role, scope, expiresAt: expiresAt ?? null };
      await auditAdminAct(subject?.userId, 'admin.role.created', fields);
      await auditAdminAct(userId, 'admin.role.granted', { role, scope, expiresAt: expiresAt ?? null, grantedBy: actorOf(subject) });
    }));

  systemAPI.register('system.roles.get',
    auditAs('subject'),
    wrap(async (_context: RolesContext, params, result: ResultBag) => {
      const userId = params.userId;
      if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) return errors.unknownResource('role');
      const row = await readRoleRow(store(), userId);
      if (row == null) return errors.unknownResource('role', userId);
      result.role = await roleView(userId, row, await localUsernameOf(userId));
    }));

  systemAPI.register('system.roles.getByUsername',
    auditAs('subject'),
    wrap(async (_context: RolesContext, params, result: ResultBag) => {
      const raw = params.username;
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > USERNAME_MAX_LENGTH) return errors.unknownResource('user');
      const username = raw.toLowerCase();
      // The account id is known on its home core only (role rows never hold a username).
      if (!platform.isSingleCore) {
        const home = await platform.getUserCore(username);
        if (home != null && home !== platform.coreId) {
          return errors.invalidOperation('This account\'s home core answers this request: send it there.', { homeCoreUrl: platform.coreIdToUrl(home) });
        }
      }
      let userId: string | null = null;
      try {
        userId = (await usersRepository.getUserIdForUsername(username)) ?? null;
      } catch {
        userId = null;
      }
      if (userId == null) return errors.unknownResource('user', username);
      result.role = await roleView(userId, await readRoleRow(store(), userId), username);
    }));
}
