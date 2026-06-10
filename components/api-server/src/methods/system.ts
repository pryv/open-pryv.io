/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MethodNext as Next, ResultBag } from './_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';

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
type AccessRow = { id?: string; type?: string; name?: string; lastUsed?: number; calls?: Record<string, number>; [k: string]: unknown };
const commonFns = require('./helpers/commonFunctions.ts');
const Registration = require('business/src/auth/registration.ts').default;
const methodsSchema = require('../schema/systemMethods.ts');
const string = require('./helpers/string.ts');
const { fromCallback } = require('utils');
const { getStorageLayer, getUsersLocalIndex } = require('storage');
const { ready, getLogger } = require('@pryv/boiler');
const { getUsersRepository } = require('business/src/users/index.ts');

const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils.ts');

const { platform } = require('platform');

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
    registration.createUser.bind(registration),
    registration.sendWelcomeMail.bind(registration)
  );

  // --------------------------------------------------------------- getUserInfo
  systemAPI.register('system.getUserInfo',
    setAuditAccessId(AuditAccessIds.ADMIN_TOKEN),
    commonFns.getParamsValidation(methodsSchema.getUserInfo.params),
    loadUserToMinimalMethodContext,
    getUserInfoInit,
    getUserInfoSetAccessStats
  );

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
        const allCores = await platform.getAllCoreInfos() as Array<{ id: string; hosting?: string; available?: boolean }>;
        // Count users per core from PlatformDB
        const allMappings = await platform.getAllUserCores() as Array<{ coreId: string }>;
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
    try {
      await fromCallback((cb: (err?: unknown, res?: unknown) => void) => userProfileStorage.findOneAndUpdate(
        context.user,
        {},
        { $unset: { 'data.mfa': '' } },
        cb));
    } catch (err) {
      return next(err);
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
