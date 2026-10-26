/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MethodNext as Next, ResultBag } from './_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';
import type { Platform } from 'platform/src/Platform.ts';

const require = createRequire(import.meta.url);
const errors = require('errors').factory;

type MethodContext = BaseMethodContext;
// `system.getUserInfo` response body, accumulated across the two middleware steps.
type UserInfoStats = {
  lastAccess: number;
  callsTotal: number;
  callsDetail: Record<string, number>;
  callsPerAccess: Record<string, number>;
  username?: string;
  storageUsed?: unknown;
};
type AccessRow = { id?: string; type?: string; name?: string; lastUsed?: number; calls?: Record<string, number> };
type StoredMfa = { content?: Record<string, unknown>; recoveryCodes?: string[]; method?: string; totp?: unknown };
const commonFns = require('./helpers/commonFunctions.ts');
const { notifyMfaChange, auditMfaChange } = require('./helpers/mfaChange.ts');
const { notifyExternalIdReleased, auditExternalIdReleased } = require('./helpers/externalIdRelease.ts');
const { Profile: MFAProfile } = require('business/src/mfa/index.ts');
const Registration = require('business/src/auth/registration.ts').default;
const methodsSchema = require('../schema/systemMethods.ts');
const string = require('./helpers/string.ts');
const { fromCallback } = require('utils');
const { getStorageLayer, getUsersLocalIndex } = require('storage');
const { ready, getLogger } = require('@pryv/boiler');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getEventTypesLoadState } = require('business').types;

const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils.ts');
const { parseAccessRef } = require('business/src/accesses/refs.ts');
const { getAccessIndex } = require('platform/src/accessIndex.ts');
const { getNamespace, listNamespaces, setNamespace, deleteNamespace, namespaceInfo } = require('platform/src/externalIdIndex.ts');
const { getExternalIdsService } = require('business/src/external-ids/service.ts');
const { APIError } = require('errors');

const { platform } = require('platform') as { platform: Platform };

/**
 * @param api The user-facing API, used to compute usage stats per method
 */
export default async function (systemAPI: { register: (...args: unknown[]) => void }, api: { getMethodKeys: () => string[] }) {
  const config = await ready();
  const logger = getLogger('system');
  const storageLayer = await getStorageLayer();
  // Pass a lazy getter to Registration so the welcome-mail send path
  // reads live `services` config per-use.
  const registration = new Registration(logger, storageLayer, () => config.get('services'));
  await registration.init();
  const usersRepository = await getUsersRepository();
  const userProfileStorage = storageLayer.profile;
  const userAccessesStorage = storageLayer.accesses;
  const usersIndex = await getUsersLocalIndex();

  await platform.init();

  // ---------------------------------------------------------------- createUser
  systemAPI.register('system.createUser',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    commonFns.getParamsValidation(methodsSchema.createUser.params),
    registration.prepareUserData,
    refuseReservedUsername,
    registration.createUser.bind(registration),
    registration.sendWelcomeMail.bind(registration)
  );

  // `backloop` was a registration test name; the admin path refuses it too.
  // Other reserved names stay possible here (migrations may carry them).
  function refuseReservedUsername (context: MethodContext & { newUser: { username: string } }, _params: unknown, _result: ResultBag, next: Next) {
    const username = context.newUser.username;
    if (typeof username === 'string' && username.toLowerCase() === 'backloop') {
      return next(errors.itemAlreadyExists('user', { username }));
    }
    next();
  }

  // --------------------------------------------------------------- getUserInfo
  systemAPI.register('system.getUserInfo',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    commonFns.getParamsValidation(methodsSchema.getUserInfo.params),
    loadUserToMinimalMethodContext,
    getUserInfoInit,
    getUserInfoSetAccessStats
  );

  // --------------------------------------------------------------- getAccess
  // Resolve a bare accessId -> owning user + operational metadata from the
  // cluster-wide reverse-index. Composite `<base>:<serial>` ids (as carried on
  // audit streams) are normalized to their base. Deleted accesses are returned
  // (with `deleted` set) — scoping a breach after revocation is the use case.
  systemAPI.register('system.getAccess',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    commonFns.getParamsValidation(methodsSchema.getAccess.params),
    getAccess
  );

  async function getAccess (_context: MethodContext, params: { accessId: string }, result: ResultBag & { accessIndex?: Record<string, unknown> }, next: Next) {
    let baseId = params.accessId;
    try { baseId = parseAccessRef(params.accessId).base; } catch (_e) { /* not a composite ref — use as-is */ }
    try {
      const entry = await getAccessIndex(platform, baseId);
      if (entry == null) {
        return next(errors.unknownResource('access', params.accessId));
      }
      const out: Record<string, unknown> = { ...entry };
      // Hashed mode: the row holds a usernameToken, not a plaintext username.
      // Surface the owning core so the responder can recover the plaintext
      // home-core-side; plaintext never leaves its jurisdiction here.
      if (platform.piiModeIsHashed && typeof entry.usernameToken === 'string') {
        const coreId = await platform.getUserCoreByPreHashedUsername(entry.usernameToken);
        out.core = coreId != null ? platform.coreIdToUrl(coreId) : null;
      }
      result.accessIndex = out;
      next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
  }

  async function loadUserToMinimalMethodContext (minimalMethodContext: MethodContext, params: { username: string }, _result: ResultBag, next: Next) {
    try {
      const userId = await usersRepository.getUserIdForUsername(params.username);
      if (userId == null) {
        return next(errors.unknownResource('user', params.username));
      }
      minimalMethodContext.user = {
        id: userId,
        username: params.username
      };
      next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
  }

  async function getUserInfoInit (context: MethodContext, _params: unknown, result: ResultBag & { userInfo?: Partial<UserInfoStats> }, next: Next) {
    const newStorageUsed = await usersRepository.getStorageUsedByUserId(context.user.id);
    result.userInfo = {
      username: context.user.username,
      storageUsed: newStorageUsed
    };
    next();
  }

  function getUserInfoSetAccessStats (context: MethodContext, _params: unknown, result: ResultBag & { userInfo?: Partial<UserInfoStats> }, next: Next) {
    const partial = result.userInfo ??= {};
    partial.lastAccess ??= 0;
    partial.callsTotal ??= 0;
    partial.callsDetail ??= {};
    partial.callsPerAccess ??= {};
    const info = partial as UserInfoStats; // defaults above guarantee the stats fields

    getAPIMethodKeys().forEach(function (methodKey: string) {
      info.callsDetail[methodKey] = 0;
    });

    userAccessesStorage.find(context.user, {}, null, function (err: Error | null, accesses: AccessRow[]) {
      if (err) { return next(errors.unexpectedError(err)); }

      accesses.forEach(function (access: AccessRow) {
        const lastUsed = access.lastUsed ?? 0;
        if (lastUsed > info.lastAccess) {
          info.lastAccess = lastUsed;
        }

        const accessKey = getAccessStatsKey(access);
        if (!info.callsPerAccess[accessKey]) {
          info.callsPerAccess[accessKey] = 0;
        }
        if (access.calls) {
          for (const [methodKey, total] of Object.entries(access.calls)) {
            info.callsTotal += total;
            info.callsDetail[methodKey] += total;
            info.callsPerAccess[accessKey] += total;
          }
        }
      });

      next();
    });
  }

  // --------------------------------------------------------------- listUsers
  systemAPI.register('system.listUsers',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    async function listUsers (_context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        const usersMap: Record<string, string> = await usersIndex.getAllByUsername();
        const users: Array<{ username: string; id: string; email: string; language: string; core?: string | null }> = [];
        for (const [username, userId] of Object.entries(usersMap)) {
          const user = await usersRepository.getUserById(userId);
          if (user == null) continue;
          const entry: { username: string, id: string, email: string, language: string, core?: string | null } = {
            username,
            id: userId,
            email: user.email,
            language: user.language
          };
          // Multi-core: include which core hosts this user
          if (!platform.isSingleCore) {
            const coreId = await platform.getUserCore(username);
            entry.core = coreId != null ? platform.coreIdToUrl(coreId) : null;
          }
          users.push(entry);
        }
        result.users = users;
        next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    }
  );

  // --------------------------------------------------------------- listCores
  systemAPI.register('system.listCores',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    async function listCores (_context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        const allCores = await platform.getAllCoreInfos();
        // Count users per core from PlatformDB
        const allMappings = await platform.getAllUserCores();
        const counts: Record<string, number> = {};
        for (const core of allCores) {
          counts[core.id] = 0;
        }
        for (const mapping of allMappings) {
          if (mapping.coreId && counts[mapping.coreId] != null) {
            counts[mapping.coreId]++;
          }
        }
        result.cores = allCores.map((core: { id: string; hosting?: string; available?: boolean }) => ({
          id: core.id,
          url: platform.coreIdToUrl(core.id),
          hosting: core.hosting || null,
          available: core.available !== false,
          userCount: counts[core.id] || 0
        }));
        next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    }
  );

  // ------------------------------------------------- external-id namespaces
  // Admin-managed rows; the salt is server-generated and never returned.
  function extIdError (err: unknown) {
    return err instanceof APIError ? err : errors.unexpectedError(err);
  }

  systemAPI.register('system.extIdNamespaces.list',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    async function listExtIdNamespaces (_context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        result.namespaces = await listNamespaces(platform);
        next();
      } catch (err) {
        return next(extIdError(err));
      }
    }
  );

  systemAPI.register('system.extIdNamespaces.get',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    commonFns.getParamsValidation(methodsSchema.extIdNamespacesGet.params),
    async function getExtIdNamespace (_context: MethodContext, params: { namespace: string }, result: ResultBag, next: Next) {
      try {
        const row = await getNamespace(platform, params.namespace);
        if (row == null) return next(errors.unknownResource('external-id namespace', params.namespace));
        result.namespace = namespaceInfo(params.namespace, row);
        next();
      } catch (err) {
        return next(extIdError(err));
      }
    }
  );

  systemAPI.register('system.extIdNamespaces.set',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    commonFns.getParamsValidation(methodsSchema.extIdNamespacesSet.params),
    async function setExtIdNamespace (context: MethodContext & { extIdNamespaceCreated?: boolean }, params: { namespace: string, label?: string, defaultMode?: string }, result: ResultBag, next: Next) {
      try {
        const { created, info } = await setNamespace(platform, params.namespace,
          { label: params.label, defaultMode: params.defaultMode }, Date.now() / 1000);
        context.extIdNamespaceCreated = created;
        result.namespace = info;
        next();
      } catch (err) {
        return next(extIdError(err));
      }
    }
  );

  systemAPI.register('system.extIdNamespaces.delete',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    commonFns.getParamsValidation(methodsSchema.extIdNamespacesDelete.params),
    async function deleteExtIdNamespace (_context: MethodContext, params: { namespace: string, force?: boolean }, _result: ResultBag, next: Next) {
      try {
        if (!await deleteNamespace(platform, params.namespace, { force: params.force === true })) {
          return next(errors.unknownResource('external-id namespace', params.namespace));
        }
        next();
      } catch (err) {
        return next(extIdError(err));
      }
    }
  );

  // The holder answer of the forced-mode accept check, asked by the core that
  // holds the auth request when the account lives here. A boolean and nothing
  // else: no date, no account, no core. Not audited (a read; one event per
  // probe in the user's trail would be noise).
  systemAPI.register('system.extIdHolds',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    commonFns.getParamsValidation(methodsSchema.extIdHolds.params),
    async function extIdHolds (_context: MethodContext, params: { username: string, namespace: string, blindedValue: string }, result: ResultBag, next: Next) {
      try {
        const userId = await usersRepository.getUserIdForUsername(params.username);
        if (userId == null) return next(errors.unknownResource('user', params.username));
        result.holds = await (await getExternalIdsService()).holds(userId, params.namespace, params.blindedValue);
        next();
      } catch (err) {
        return next(extIdError(err));
      }
    }
  );

  // An administrator releases an id the wrong account claimed. On the core
  // holding it: released, the holder's trail gets an audit row and the holder
  // is told by mail when mail is configured; the answer never names the
  // account. Held on another core: the route answers 307 to that core.
  systemAPI.register('system.extIdRelease',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    commonFns.getParamsValidation(methodsSchema.extIdRelease.params),
    async function extIdRelease (_context: MethodContext, params: { namespace: string, blindedValue: string, reason: string }, result: ResultBag, next: Next) {
      try {
        const outcome = await (await getExternalIdsService()).adminRelease(params.namespace, params.blindedValue);
        if (outcome.kind === 'remote') {
          result.redirect = outcome.coreUrl;
          return next();
        }
        if (outcome.kind === 'none') return next(errors.unknownResource('external id'));
        const username = await usersRepository.getUsernameForUserId(outcome.userId);
        await auditExternalIdReleased(config, outcome.userId, { namespace: params.namespace, reason: params.reason });
        result.released = true;
        result.notified = username == null
          ? 'audit-only'
          : await notifyExternalIdReleased(config, { id: outcome.userId, username }, { namespaceLabel: outcome.label, reason: params.reason });
        next();
      } catch (err) {
        return next(extIdError(err));
      }
    }
  );

  // ------------------------------------------------------ eventTypesStatus
  // Operator-alertable state of the event-types dictionary. `degraded` is true
  // when the published dictionary has never loaded, in which case the core runs
  // on its embedded fallback and refuses unknown event types.
  systemAPI.register('system.getEventTypesStatus',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    async function getEventTypesStatus (_context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        result.eventTypes = getEventTypesLoadState();
        return next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    }
  );

  // --------------------------------------------------------------- checks
  systemAPI.register('system.checkPlatformIntegrity',
    async function performSystemsChecks (_context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        result.checks = [
          await platform.checkIntegrity(),
          await usersIndex.checkIntegrity()
        ];
        return next();
      } catch (err) {
        return next(err);
      }
    }
  );

  // --------------------------------------------------------------- deactivateMfa
  systemAPI.register('system.deactivateMfa',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    commonFns.getParamsValidation(methodsSchema.deactivateMfa.params),
    loadUserToMinimalMethodContext,
    deactivateMfa
  );

  async function deactivateMfa (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    let wasEnrolled: { method: string } | null = null;
    try {
      // What the reset removes, for its audit row and its notice.
      const before = await fromCallback((cb: (err?: unknown, res?: unknown) => void) =>
        userProfileStorage.findOne(context.user, { id: 'private' }, null, cb)) as { data?: { mfa?: StoredMfa } } | null;
      const stored = before?.data?.mfa;
      if (stored != null && new MFAProfile(stored.content || {}, stored.recoveryCodes || [], stored.method, stored.totp).isActive()) {
        wasEnrolled = { method: stored.method ?? 'sms' };
      }
      await fromCallback((cb: (err?: unknown, res?: unknown) => void) => userProfileStorage.findOneAndUpdate(
        context.user,
        // The private profile explicitly: `{}` matched whichever profile row
        // came first, so on SQLite a user with a public or app profile kept
        // their MFA enrolment after an admin reset.
        { id: 'private' },
        // The throttle is a sibling key, so it must be cleared explicitly:
        // an admin reset that left a lock behind would strand the user.
        { $unset: { 'data.mfa': '', 'data.mfaThrottle': '' } },
        cb));
    } catch (err) {
      return next(err);
    }
    const user = context.user as { id: string; username: string };
    // The call is audited without a user (an admin key, no access of the
    // account): the account's own trail gets a row of its own, and its
    // owner a notice when a second factor was actually removed.
    await auditMfaChange(config, user.id, 'mfa.deactivatedByAdmin',
      wasEnrolled != null ? { enrolled: true, method: wasEnrolled.method } : { enrolled: false });
    if (wasEnrolled != null) {
      // The path may name an alias of the account: the notice names the
      // account by its own username, as the account's own MFA changes do.
      let username = user.username;
      try {
        username = (await usersRepository.getUsernameForUserId(user.id)) ?? username;
      } catch (err) {
        logger.warn('system.deactivateMfa: the account username could not be resolved for the notice: ' + (err instanceof Error ? err.message : String(err)));
      }
      notifyMfaChange(config, { id: user.id, username }, 'deactivatedByAdmin');
    }
    next();
  }

  function getAPIMethodKeys (): string[] {
    return api.getMethodKeys().map(string.sanitizeFieldKey);
  }

  function getAccessStatsKey (access: AccessRow): string {
    if (access.type === 'shared') {
      // don't leak user private data
      return 'shared';
    } else {
      return access.name ?? '';
    }
  }
};
