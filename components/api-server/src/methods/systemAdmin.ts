/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResultBag } from './_types.ts';
import type { AdminSubject } from 'middleware/src/adminAuth.ts';
import { auditAs, actorOf, auditAdminAct, wrap as wrapStep } from './helpers/adminAudit.ts';
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
  hasActiveGrant, effectivePermissions, mintClaimCode, claimRole, countClaimAttempt, CLAIM_TTL_MAX_MS, LastOwnerError, lastingOwners
} from 'business/src/admin/roles.ts';
import { coreContext } from 'business/src/admin/scopes.ts';
import { roleMessage, scopeMessage, knownCoreIds, grantsView } from './systemAdminRoles.ts';
import { setupCodeFileOf } from 'business/src/admin/setupBoot.ts';
import type * as Migrations from 'storages/interfaces/migrations/index.ts';
import { setDeletionGuard, setDeletionTeardownStep } from 'business/src/auth/deletionTeardown.ts';
import type { RoleRow } from 'business/src/admin/roles.ts';
import { readAdminConfig, adminMfaRequired, portalUrl, portalSettings, setupPageUrl } from 'business/src/admin/config.ts';
import { offeredCapabilities } from 'business/src/admin/capabilities.ts';
import { lockdownView, withoutHiddenCapabilities } from 'business/src/admin/lockdown.ts';
import { policyView, readLocalPolicy } from 'business/src/admin/localPolicy.ts';
import { setupChecks } from 'business/src/admin/setupChecks.ts';
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

export default async function (systemAPI: { register: (...args: unknown[]) => void }) {
  const config = await ready();
  const logger = getLogger('system-admin');
  const usersRepository = await getUsersRepository();
  const store = (): AdminStore => storages.platformDB as AdminStore;
  const localKv = (): LocalKv => clusterKvClientFor() as LocalKv;
  const coreId = (): string => platform.coreId;
  // One per process, created at the first checks call (as system.getMigrationsStatus does).
  let migrationRunner: Awaited<ReturnType<typeof Migrations.createMigrationRunner>> | null = null;

  /** The setup code file of this core holds a consumed or invalid code once setup is done. Best-effort. */
  function removeSetupCodeFile (): void {
    const file = setupCodeFileOf(process.argv, nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../../../../config'));
    try {
      if (nodeFs.existsSync(file)) nodeFs.unlinkSync(file);
    } catch (err) {
      logger.warn(`could not delete ${file}: ${(err as Error).message}`);
    }
  }

  // Account deletion: an administrator's role row goes with the account (its
  // sessions end with it), and the holder may not delete the account that
  // holds the last lasting owner grant (an admin-key deletion goes through).
  setDeletionGuard('admin-last-owner', async (account: { id: string }) => {
    const owners = await lastingOwners(store());
    if (owners.length === 1 && owners[0] === account.id) {
      return { message: 'This account holds the last owner role of the platform: grant the owner role to another account first.', data: { id: 'last-owner' } };
    }
    return null;
  });
  setDeletionTeardownStep('admin-role', async (account: { id: string }) => {
    await revokeRole(store(), account.id, { now: Date.now(), force: true });
  });

  // ------------------------------------------------------------ helpers

  /** A method step from an async function (methods/helpers/adminAudit.ts). */
  function wrap (fn: (context: AdminContext, params: Record<string, unknown>, result: ResultBag) => Promise<unknown>) {
    return wrapStep(fn);
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
        mfaRequired: adminMfaRequired(config),
        setupPageUrl: setupPageUrl(config),
        portalUrl: portalUrl(config)
      };
    }));

  systemAPI.register('system.setup.getChecks',
    auditAs('subject'),
    wrap(async (_context, _params, result) => {
      let certificates: Array<{ hostname?: string; expiresAt?: number }> | null = null;
      try {
        const db = storages.platformDB as { listCertificates?: () => Promise<Array<{ hostname?: string; expiresAt?: number }>> };
        certificates = typeof db.listCertificates === 'function' ? await db.listCertificates() : [];
      } catch (err) {
        logger.warn('setup checks: certificates not readable: ' + (err as Error).message);
      }
      let pendingMigrations: number | null = null;
      try {
        const { createMigrationRunner, summarizeStatus } = await import('storages/interfaces/migrations/index.ts');
        migrationRunner ??= await createMigrationRunner({ logger: getLogger('migrations') });
        pendingMigrations = summarizeStatus(await migrationRunner.status()).pending;
      } catch (err) {
        logger.warn('setup checks: migration status not readable: ' + (err as Error).message);
      }
      result.checks = setupChecks({ config, certificates, pendingMigrations, now: Date.now() });
    }));

  systemAPI.register('system.setup.createSession',
    auditAs('public'),
    wrap(async (_context, params, result) => {
      const db = store();
      if ((await readSetupState(db))?.state !== 'pending') return errors.unknownResource('setup code');
      const now = Date.now();
      const attempt = await countSetupAttempt(db, { coreId: coreId(), now });
      if (!attempt.allowed) {
        return errors.tooManyRequests('Too many setup code attempts on this core: retry once the wait is over (the code stays valid).',
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
      const subject = context.adminSubject;
      // The setup session needs its first administrator; the admin key may
      // finish without one (automated installs: the first administrator then
      // comes from a claim code).
      if (subject?.kind === 'setup') {
        const owners = (await listRoleRows(db)).filter(({ row }) => activeGrants(row, now).some((g) => g.role === ROLE_OWNER));
        if (owners.length === 0) return errors.invalidOperation('Setup needs a first administrator (POST /system/setup/first-admin) before it can finish.');
      }
      const state = await markReady(db, { by: subject?.kind === 'setup' ? 'setup' : 'admin-key', now });
      if (subject?.kind === 'setup') await endSetupSession(db, subject.token);
      removeSetupCodeFile();
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
      // Any active grant opens a session, whatever it gives on this core (a
      // grant scoped to another core, a local policy refusing it); the answer
      // lists what it gives here and what it does not.
      if (!hasActiveGrant(role, now)) return errors.unknownResource();
      const { permissions, denied } = effectivePermissions(role, now,
        { core: coreContext(config), policy: readLocalPolicy(config), userId: personal.userId });
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
        permissions: [...permissions],
        denied
      };
      await auditAdminAct(personal.userId, 'admin.session.created', { homeCore: coreId() });
    }));

  systemAPI.register('system.adminSession.get',
    auditAs('subject'),
    wrap(async (context, _params, result) => {
      const subject = context.adminSubject!;
      const s = subject.session!;
      const now = Date.now();
      const adminSession: Record<string, unknown> = {
        userId: s.userId,
        homeCore: s.homeCore,
        mfaAt: s.mfaAt,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        stepUpFresh: isStepUpFresh(s, now, readAdminConfig(config).session.stepUpMs),
        // On this core: what the grants give here, what they do not and why.
        permissions: [...subject.permissions],
        denied: subject.denied,
        grants: grantsView(subject.role ?? null, now, config, await knownCoreIds())
      };
      const localPolicy = policyView(config, subject);
      if (localPolicy != null) adminSession.localPolicy = localPolicy;
      result.adminSession = adminSession;
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
      if (!isRole(role)) return errors.invalidParametersFormat(roleMessage('role'), { role });
      if (!isScope(scope)) return errors.invalidParametersFormat(scopeMessage('scope'), { scope });
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
      const now = Date.now();
      const coreIds = await knownCoreIds();
      for (const { userId, row } of await listRoleRows(store())) {
        let username: string | null = null;
        try { username = (await usersRepository.getUsernameForUserId(userId)) ?? null; } catch { /* not of this core */ }
        // Each grant says whether its scope names something the platform knows (`orphan`: it gives nothing).
        roles.push({ ...rolePayload(userId, row), grants: grantsView(row, now, config, coreIds), username, sessionsRevokedAt: row.sessionsRevokedAt ?? null });
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
      let revoked: boolean;
      try {
        revoked = await revokeRole(store(), userId, { role: role as string | undefined, scope: scope as string | undefined, now: Date.now() });
      } catch (err) {
        if (err instanceof LastOwnerError) return errors.invalidOperation(err.message, { id: err.id });
        throw err;
      }
      if (!revoked) return errors.unknownResource('role', userId);
      result.revoked = true;
      await auditAdminAct(context.adminSubject?.userId, 'admin.role.deleted', { target: userId, role: role ?? null, scope: scope ?? null });
      await auditAdminAct(userId, 'admin.role.revoked', { role: role ?? null, scope: scope ?? null, revokedBy: actorOf(context.adminSubject) });
    }));

  // ------------------------------------------------------------ portal

  // Public: what the portal shows on this platform (spaces, modules), from `portal.*`.
  systemAPI.register('system.portalSettings.get',
    auditAs('public'),
    wrap(async (_context, _params, result) => {
      Object.assign(result, portalSettings(config));
    }));

  systemAPI.register('system.portalContext.get',
    auditAs('subject'),
    wrap(async (context, _params, result) => {
      const subject = context.adminSubject!;
      const cfg = readAdminConfig(config);
      const state = await readSetupState(store());
      const portalContext: Record<string, unknown> = {
        // Same form as system.listCores (trailing slash), so the portal matches the two.
        core: { id: coreId(), url: platform.coreIdToUrl(coreId()) },
        setup: { state: state?.state === 'pending' ? 'pending' : 'ready' },
        subject: { kind: subject.kind, userId: subject.userId ?? null, permissions: [...subject.permissions], denied: subject.denied ?? [] },
        capabilities: withoutHiddenCapabilities(config, offeredCapabilities(config)),
        portal: { url: portalUrl(config), setupPageUrl: setupPageUrl(config) },
        adminSession: { ttlMinutes: cfg.session.ttlMs / 60000, stepUpMinutes: cfg.session.stepUpMs / 60000, mfaRequired: adminMfaRequired(config) }
      };
      // This core's lockdown and local policy, when they say something.
      const lockdown = lockdownView(config);
      if (lockdown != null) portalContext.lockdown = lockdown;
      const localPolicy = policyView(config, subject);
      if (localPolicy != null) portalContext.localPolicy = localPolicy;
      result.portalContext = portalContext;
    }));
}
