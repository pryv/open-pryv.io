/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createId as cuid } from '@paralleldrive/cuid2';
import timestamp from 'unix-timestamp';
import type { MethodNext as Next, ResultBag } from './_types.ts';
import type { AdminSubject } from 'middleware/src/adminAuth.ts';
import type { AdminStore } from 'business/src/admin/store.ts';
import {
  readSetupState, redeemSetupCode, countSetupAttempt, pendingSetupCode, mintSetupCode, markReady
} from 'business/src/admin/setupState.ts';
import {
  createSetupSession, endSetupSession, createAdminSession, endAdminSession, renewAdminSession, isStepUpFresh, mfaSignInAt
} from 'business/src/admin/sessions.ts';
import type { LocalKv } from 'business/src/admin/sessions.ts';
import {
  ROLE_OWNER, SCOPE_PLATFORM, isRole, isScope, grantRole, readRoleRow, listRoleRows, revokeRole, activeGrants,
  permissionsOf, mintClaimCode, claimRole, countClaimAttempt, CLAIM_TTL_MAX_MS
} from 'business/src/admin/roles.ts';
import type { RoleRow } from 'business/src/admin/roles.ts';
import { readAdminConfig, adminMfaRequired, portalUrl, setupPageUrl } from 'business/src/admin/config.ts';
import { offeredCapabilities } from 'business/src/admin/capabilities.ts';
import { factory as errors } from 'errors';
import { ready, getLogger } from '@pryv/boiler';
import { getUsersRepository } from 'business/src/users/index.ts';
import { platform } from 'platform';
import * as storages from 'storages';
import { clientFor as clusterKvClientFor } from 'messages/src/cluster_kv.ts';

/**
 * Setup, administrator sessions, roles and claim codes (routes in
 * routes/system-setup.ts). The /system gate resolved the caller
 * (`context.adminSubject`); the routes that take a personal token verified it
 * on this core (`context.adminPersonal`).
 *
 * Audit: each act is recorded without a user (the record carries the kind of
 * subject, the administrator's id and a short session id, never a code or a
 * token), and in the acting administrator's own trail when the account is on
 * this core. Reads are not audited.
 */

/** A personal token of an account of this core, verified by the route. */
export type AdminPersonal = {
  userId: string;
  username: string;
  token: string;
  accessId: string;
  /** Last completed sign-in of the access (seconds), if recorded. */
  lastLogin: number | null;
};

type AdminContext = {
  adminSubject?: AdminSubject;
  adminPersonal?: AdminPersonal;
  access?: { id?: string } | null;
  auditIntegrityPayload?: unknown;
};

const SESSION_ID_LENGTH = 16;

export default async function (systemAPI: { register: (...args: unknown[]) => void }) {
  const config = await ready();
  const logger = getLogger('system-admin');
  const usersRepository = await getUsersRepository();
  const store = (): AdminStore => storages.platformDB as AdminStore;
  const localKv = (): LocalKv => clusterKvClientFor() as LocalKv;
  const coreId = (): string => platform.coreId;

  // ------------------------------------------------------------ helpers

  /** The audit access id and the record of who acted (no secret in it). */
  function auditAs (kind: 'subject' | 'personal' | 'public') {
    return function setAuditSubject (context: AdminContext, _params: unknown, _result: ResultBag, next: Next) {
      const subject = context.adminSubject;
      let accessId = 'public';
      const record: Record<string, unknown> = {};
      if (kind === 'personal' && context.adminPersonal != null) {
        accessId = 'personal-token';
        record.userId = context.adminPersonal.userId;
      }
      if (kind !== 'public' && subject != null) {
        accessId = subject.kind === 'key' ? 'admin' : subject.kind === 'session' ? 'admin-session' : 'setup-session';
        record.via = subject.kind === 'key' ? 'admin-key' : subject.kind;
        if (subject.userId != null) record.userId = subject.userId;
        if (subject.sessionId != null) record.sessionId = subject.sessionId.slice(0, SESSION_ID_LENGTH);
      }
      context.access = { id: accessId };
      context.auditIntegrityPayload = { subject: record };
      next();
    };
  }

  /** The id an act is attributed to in the rows it writes. */
  function actorOf (subject: AdminSubject | undefined): string {
    if (subject?.kind === 'session' && subject.userId != null) return subject.userId;
    return subject?.kind === 'setup' ? 'setup' : 'admin-key';
  }

  /** A row of the administrator's own trail, when the account is on this core. Best-effort. */
  async function auditAdminAct (userId: string | undefined, action: string, record: Record<string, unknown>): Promise<void> {
    if (userId == null) return;
    try {
      if (config.get('audit:active') !== true) return;
      if ((await usersRepository.getUsernameForUserId(userId)) == null) return; // not an account of this core
      const auditSingleton = (await import('audit')).default;
      const C = auditSingleton.CONSTANTS;
      const now = timestamp.now();
      await auditSingleton.eventForUser(userId, {
        id: cuid(),
        createdBy: 'system',
        modifiedBy: 'system',
        streamIds: [C.ACTION_STREAM_ID_PREFIX + action],
        time: now,
        endTime: now,
        created: now,
        modified: now,
        trashed: false,
        type: 'audit-log/admin',
        content: { action, source: { name: 'admin' }, record }
      }, action);
    } catch (err) {
      logger.error(`administration audit row "${action}" not written`, err);
    }
  }

  /**
   * When the sign-in behind a personal token proved its factor (ms): the
   * second-factor stamp when administrators need MFA (null without one), else
   * the access's last sign-in.
   */
  async function factorTimeOf (personal: AdminPersonal): Promise<number | null> {
    if (adminMfaRequired(config)) return await mfaSignInAt(localKv(), { token: personal.token, userId: personal.userId });
    return personal.lastLogin != null ? Math.round(personal.lastLogin * 1000) : null;
  }

  function mfaMissing () {
    return errors.forbidden('Administrators sign in with their second factor on this platform: sign in again with it, then repeat the request.', { mfaRequired: true });
  }

  function personalOf (context: AdminContext): AdminPersonal {
    if (context.adminPersonal == null) throw new Error('AF: the route verifies the personal token');
    return context.adminPersonal;
  }

  function rolePayload (userId: string, row: RoleRow | null) {
    return { userId, grants: activeGrants(row, Date.now()), updatedAt: row?.updatedAt ?? null };
  }

  function wrap (fn: (context: AdminContext, params: Record<string, unknown>, result: ResultBag) => Promise<unknown>) {
    return async function adminStep (context: AdminContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
      try {
        const err = await fn(context, params ?? {}, result);
        next(err as Error | undefined);
      } catch (err) {
        next(err instanceof Error && 'id' in err ? err : errors.unexpectedError(err));
      }
    };
  }

  // ------------------------------------------------------------ setup

  systemAPI.register('system.setup.getStatus',
    auditAs('public'),
    wrap(async (_context, _params, result) => {
      const state = await readSetupState(store());
      const pending = state?.state === 'pending';
      const code = pending ? await pendingSetupCode(store()) : null;
      result.setup = {
        state: pending ? 'pending' : 'ready',
        codePending: code != null,
        codeExpiresAt: code?.expiresAt ?? null,
        readyAt: state?.readyAt ?? null,
        mfaRequired: adminMfaRequired(config),
        setupPageUrl: setupPageUrl(config),
        portalUrl: portalUrl(config)
      };
    }));

  systemAPI.register('system.setup.createSession',
    auditAs('public'),
    wrap(async (_context, params, result) => {
      const db = store();
      if ((await readSetupState(db))?.state !== 'pending') return errors.unknownResource('setup code');
      const now = Date.now();
      const attempt = await countSetupAttempt(db, { coreId: coreId(), now });
      if (!attempt.allowed) {
        return errors.tooManyRequests('Too many setup code attempts on this core: the pending code was withdrawn. Issue a new one (bin/admin.js setup-code --new).',
          Math.max(1, Math.ceil((attempt.retryAt - now) / 1000)));
      }
      if (await redeemSetupCode(db, params.code) == null) return errors.unknownResource('setup code');
      const session = await createSetupSession(db, { coreId: coreId(), now });
      result.setupSession = { token: session.token, expiresAt: session.expiresAt };
    }));

  systemAPI.register('system.setup.createFirstAdmin',
    auditAs('subject'),
    wrap(async (context, _params, result) => {
      const personal = personalOf(context);
      const now = Date.now();
      if (adminMfaRequired(config) && await factorTimeOf(personal) == null) return mfaMissing();
      const row = await grantRole(store(), personal.userId, { role: ROLE_OWNER, scope: SCOPE_PLATFORM, grantedBy: 'setup', via: 'setup', now });
      result.role = rolePayload(personal.userId, row);
      await auditAdminAct(personal.userId, 'admin.role.created', { role: ROLE_OWNER, scope: SCOPE_PLATFORM, via: 'setup' });
    }));

  systemAPI.register('system.setup.setReady',
    auditAs('subject'),
    wrap(async (context, _params, result) => {
      const db = store();
      if ((await readSetupState(db))?.state !== 'pending') return errors.invalidOperation('Setup is not pending.');
      const now = Date.now();
      const owners = (await listRoleRows(db)).filter(({ row }) => activeGrants(row, now).some((g) => g.role === ROLE_OWNER));
      if (owners.length === 0) return errors.invalidOperation('Setup needs a first administrator (POST /system/setup/first-admin) before it can finish.');
      const subject = context.adminSubject;
      const state = await markReady(db, { by: subject?.kind === 'setup' ? 'setup' : 'admin-key', now });
      if (subject?.kind === 'setup') await endSetupSession(db, subject.token);
      result.setup = { state: state.state, readyAt: state.readyAt ?? null };
    }));

  systemAPI.register('system.setup.replaceCode',
    auditAs('subject'),
    wrap(async (context, _params, result) => {
      const minted = await mintSetupCode(store(), { coreId: coreId(), ttlMs: readAdminConfig(config).setup.codeTtlMs, now: Date.now() });
      if (minted == null) return errors.invalidOperation('Setup is not pending: there is no setup code to replace.');
      result.setupCode = { code: minted.display, expiresAt: minted.expiresAt };
      await auditAdminAct(context.adminSubject?.userId, 'admin.setupCode.replaced', {});
    }));

  // ------------------------------------------------------------ admin sessions

  systemAPI.register('system.adminSession.create',
    auditAs('personal'),
    wrap(async (context, _params, result) => {
      const personal = personalOf(context);
      const db = store();
      if ((await readSetupState(db))?.state === 'pending') {
        return errors.invalidOperation('Setup is not finished: administrator sessions open once it is (use the setup session meanwhile).');
      }
      const now = Date.now();
      const role = await readRoleRow(db, personal.userId);
      const permissions = permissionsOf(role, now);
      if (role == null || permissions.size === 0) return errors.unknownResource();
      const factorAt = await factorTimeOf(personal);
      if (adminMfaRequired(config) && factorAt == null) return mfaMissing();
      const cfg = readAdminConfig(config);
      const session = await createAdminSession(db, { userId: personal.userId, homeCore: coreId(), mfaAt: factorAt, now, ttlMs: cfg.session.ttlMs });
      result.adminSession = {
        token: session.token,
        expiresAt: session.expiresAt,
        userId: personal.userId,
        homeCore: coreId(),
        mfaAt: factorAt,
        stepUpFresh: factorAt != null && isStepUpFresh({ mfaAt: factorAt }, now, cfg.session.stepUpMs),
        permissions: [...permissions]
      };
      await auditAdminAct(personal.userId, 'admin.session.created', { homeCore: coreId() });
    }));

  systemAPI.register('system.adminSession.get',
    auditAs('subject'),
    wrap(async (context, _params, result) => {
      const subject = context.adminSubject!;
      const s = subject.session!;
      const now = Date.now();
      result.adminSession = {
        userId: s.userId,
        homeCore: s.homeCore,
        mfaAt: s.mfaAt,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        stepUpFresh: isStepUpFresh(s, now, readAdminConfig(config).session.stepUpMs),
        permissions: [...subject.permissions],
        grants: activeGrants(subject.role ?? null, now)
      };
    }));

  systemAPI.register('system.adminSession.delete',
    auditAs('subject'),
    wrap(async (context) => {
      const subject = context.adminSubject!;
      await endAdminSession(store(), subject.token);
      await auditAdminAct(subject.userId, 'admin.session.deleted', {});
    }));

  async function renew (context: AdminContext, result: ResultBag, stepUp: boolean): Promise<unknown> {
    const subject = context.adminSubject!;
    const personal = personalOf(context);
    if (personal.userId !== subject.userId) return errors.unknownResource();
    const cfg = readAdminConfig(config);
    const now = Date.now();
    let mfaAt: number | undefined;
    if (stepUp) {
      const factorAt = await factorTimeOf(personal);
      if (factorAt == null || !isStepUpFresh({ mfaAt: factorAt }, now, cfg.session.stepUpMs)) {
        return errors.forbidden('The sign-in behind this token is not recent enough for a step-up: sign in again' +
          (adminMfaRequired(config) ? ' with the second factor' : '') + ', then repeat the request.', { stepUp: true });
      }
      mfaAt = factorAt;
    }
    const expiresAt = await renewAdminSession(store(), subject.token, { now, ttlMs: cfg.session.ttlMs, mfaAt });
    if (expiresAt == null) return errors.unknownResource();
    result.adminSession = { expiresAt, mfaAt: mfaAt ?? subject.session?.mfaAt ?? null };
    if (stepUp) await auditAdminAct(subject.userId, 'admin.session.updatedSecondFactor', {});
    return undefined;
  }

  systemAPI.register('system.adminSession.updateExpiry',
    auditAs('subject'),
    wrap(async (context, _params, result) => await renew(context, result, false)));

  systemAPI.register('system.adminSession.verifyStepUp',
    auditAs('subject'),
    wrap(async (context, _params, result) => await renew(context, result, true)));

  // ------------------------------------------------------------ claim codes and roles

  systemAPI.register('system.claimCodes.create',
    auditAs('subject'),
    wrap(async (context, params, result) => {
      const extra = Object.keys(params).filter((k) => !['role', 'scope', 'ttlMinutes'].includes(k));
      if (extra.length > 0) return errors.invalidParametersFormat('Unknown parameter(s): ' + extra.join(', ') + '.', { parameters: extra });
      const role = params.role ?? ROLE_OWNER;
      const scope = params.scope ?? SCOPE_PLATFORM;
      if (!isRole(role)) return errors.invalidParametersFormat('`role` must be one of: owner.', { role });
      if (!isScope(scope)) return errors.invalidParametersFormat('`scope` must be one of: platform.', { scope });
      let ttlMs: number | undefined;
      if (params.ttlMinutes != null) {
        const minutes = params.ttlMinutes;
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes * 60000 > CLAIM_TTL_MAX_MS) {
          return errors.invalidParametersFormat('`ttlMinutes` must be a whole number of minutes from 1 to 1440.', { ttlMinutes: minutes });
        }
        ttlMs = minutes * 60000;
      }
      const subject = context.adminSubject;
      const minted = await mintClaimCode(store(), { role, scope, mintedBy: actorOf(subject), now: Date.now(), ttlMs });
      result.claimCode = { code: minted.display, role, scope, expiresAt: minted.expiresAt };
      await auditAdminAct(subject?.userId, 'admin.claimCode.created', { role, scope });
    }));

  systemAPI.register('system.roles.claim',
    auditAs('personal'),
    wrap(async (context, params, result) => {
      const personal = personalOf(context);
      const db = store();
      const now = Date.now();
      const attempt = await countClaimAttempt(db, { userId: personal.userId, now });
      if (!attempt.allowed) {
        return errors.tooManyRequests('Too many administrator code attempts for this account: retry later.', Math.max(1, Math.ceil((attempt.retryAt - now) / 1000)));
      }
      if (adminMfaRequired(config) && await factorTimeOf(personal) == null) return mfaMissing();
      const claimed = await claimRole(db, params.code, { userId: personal.userId, now });
      if (claimed == null) return errors.unknownResource('administrator code');
      result.role = rolePayload(personal.userId, claimed.row);
      await auditAdminAct(personal.userId, 'admin.role.claimed', { role: claimed.grant.role, scope: claimed.grant.scope, mintedBy: claimed.grant.mintedBy });
    }));

  systemAPI.register('system.roles.list',
    auditAs('subject'),
    wrap(async (_context, _params, result) => {
      const roles = [];
      for (const { userId, row } of await listRoleRows(store())) {
        let username: string | null = null;
        try { username = (await usersRepository.getUsernameForUserId(userId)) ?? null; } catch { /* not of this core */ }
        roles.push({ ...rolePayload(userId, row), username, sessionsRevokedAt: row.sessionsRevokedAt ?? null });
      }
      result.roles = roles;
    }));

  systemAPI.register('system.roles.delete',
    auditAs('subject'),
    wrap(async (context, params, result) => {
      const userId = params.userId;
      const role = params.role;
      const scope = params.scope;
      if (typeof userId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(userId)) return errors.unknownResource('role');
      if (role != null && typeof role !== 'string') return errors.invalidParametersFormat('`role` must be a string.');
      if (scope != null && typeof scope !== 'string') return errors.invalidParametersFormat('`scope` must be a string.');
      const revoked = await revokeRole(store(), userId, { role: role as string | undefined, scope: scope as string | undefined, now: Date.now() });
      if (!revoked) return errors.unknownResource('role', userId);
      result.revoked = true;
      await auditAdminAct(context.adminSubject?.userId, 'admin.role.deleted', { target: userId, role: role ?? null, scope: scope ?? null });
    }));

  // ------------------------------------------------------------ portal

  systemAPI.register('system.portalContext.get',
    auditAs('subject'),
    wrap(async (context, _params, result) => {
      const subject = context.adminSubject!;
      const cfg = readAdminConfig(config);
      const state = await readSetupState(store());
      result.portalContext = {
        core: { id: coreId(), url: platform.coreUrl },
        setup: { state: state?.state === 'pending' ? 'pending' : 'ready' },
        subject: { kind: subject.kind, userId: subject.userId ?? null, permissions: [...subject.permissions] },
        capabilities: offeredCapabilities(config),
        portal: { url: portalUrl(config), setupPageUrl: setupPageUrl(config) },
        adminSession: { ttlMinutes: cfg.session.ttlMs / 60000, stepUpMinutes: cfg.session.stepUpMs / 60000, mfaRequired: adminMfaRequired(config) }
      };
    }));
}
