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
import { ledgerKey, listErasureRecords, lookupErasureRecords, otherKeyRecordCount, parseCursor, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from 'business/src/erasureLedger/index.ts';
import { buildEffectiveConfig, scopesFromStores } from 'business/src/effectiveConfig/index.ts';

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
const { resetAutoDeletion } = require('./helpers/autoDeletionAdminReset.ts');
const { recordAccountCreatedStep } = require('./helpers/accountCreationAudit.ts');
const { Profile: MFAProfile } = require('business/src/mfa/index.ts');
const Registration = require('business/src/auth/registration.ts').default;
const methodsSchema = require('../schema/systemMethods.ts');
const string = require('./helpers/string.ts');
const { fromCallback } = require('utils');
const { getStorageLayer, getUsersLocalIndex } = require('storage');
const storages = require('storages');
const { ready, getLogger } = require('@pryv/boiler');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getEventTypesLoadState } = require('business').types;
const { getAPIVersion } = require('middleware/src/project_version.ts');

const { auditAs, auditTarget, setAuditDetails, inActorTrail, auditAdminAct } = require('./helpers/adminAudit.ts');
const { parseAccessRef } = require('business/src/accesses/refs.ts');
const { getAccessIndex } = require('platform/src/accessIndex.ts');
const { getNamespace, listNamespaces, setNamespace, deleteNamespace, namespaceInfo } = require('platform/src/externalIdIndex.ts');
const { getExternalIdsService } = require('business/src/external-ids/service.ts');
const { APIError } = require('errors');

const { platform } = require('platform') as { platform: Platform };

/** Longest `search` of the users list (a username is at most 60 characters). */
const USERNAME_SEARCH_MAX = 64;

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
  // The object of an act, as recorded (method parameters, never a secret).
  // Read before the parameters are validated: a value that is not a short text is left out.
  const shortText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;
  const byUsername = (p: { username?: unknown }) => shortText(p.username) ? { username: p.username } : null;
  const byNamespace = (p: { namespace?: unknown }) => shortText(p.namespace) ? { namespace: p.namespace } : null;

  systemAPI.register('system.createUser',
    auditAs('subject'),
    auditTarget(byUsername),
    commonFns.getParamsValidation(methodsSchema.createUser.params),
    registration.prepareUserData,
    refuseReservedUsername,
    registration.createUser.bind(registration),
    recordAccountCreatedStep('system'),
    registration.sendWelcomeMail.bind(registration),
    inActorTrail()
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
  // Recorded in the platform trail, in the account's own trail and in the
  // acting administrator's trail.
  systemAPI.register('system.getUserInfo',
    auditAs('subject'),
    auditTarget(byUsername),
    commonFns.getParamsValidation(methodsSchema.getUserInfo.params),
    loadUserToMinimalMethodContext,
    getUserInfoInit,
    getUserInfoSetAccessStats,
    async function inReadAccountTrail (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
      await recordReadByAdmin(context, context.user.id);
      next();
    },
    inActorTrail()
  );

  /** A row in the trail of the account an administrator read (when on this core). Best-effort. */
  async function recordReadByAdmin (context: MethodContext, userId: string | undefined | null) {
    if (userId == null) return;
    const payload = (context as { auditIntegrityPayload?: { subject?: unknown } }).auditIntegrityPayload;
    await auditAdminAct(userId, 'account.readByAdmin', { methodId: context.methodId, subject: payload?.subject ?? {} });
  }

  // --------------------------------------------------------------- getAccess
  // Resolve a bare accessId -> owning user + operational metadata from the
  // cluster-wide reverse-index. Composite `<base>:<serial>` ids (as carried on
  // audit streams) are normalized to their base. Deleted accesses are returned
  // (with `deleted` set) — scoping a breach after revocation is the use case.
  // Recorded in the platform trail, in the trail of the account holding the
  // access when it is on this core, and in the acting administrator's trail.
  systemAPI.register('system.getAccess',
    auditAs('subject'),
    auditTarget((p: { accessId?: unknown }) => shortText(p.accessId) ? { accessId: p.accessId } : null),
    commonFns.getParamsValidation(methodsSchema.getAccess.params),
    getAccess,
    inActorTrail()
  );

  async function getAccess (context: MethodContext, params: { accessId: string }, result: ResultBag & { accessIndex?: Record<string, unknown> }, next: Next) {
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
      // The holder's own trail, when the account is on this core (a
      // plaintext username only: a hashed one stays on its core).
      if (typeof entry.username === 'string') {
        let holderId: string | null = null;
        try { holderId = (await usersRepository.getUserIdForUsername(entry.username)) ?? null; } catch (_e) { /* not resolvable here */ }
        await recordReadByAdmin(context, holderId);
      }
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
            // a counter of a method no longer registered starts from 0 too
            info.callsDetail[methodKey] = (info.callsDetail[methodKey] ?? 0) + total;
            info.callsPerAccess[accessKey] += total;
          }
        }
      });

      next();
    });
  }

  // --------------------------------------------------------------- listUsers
  // Optional paging: `limit` (1 to LIST_USERS_MAX_LIMIT), `skip`, `search` (a
  // prefix of the username), over the usernames in order. Without any of
  // them, every user, in the index's order. `total`: the users matching
  // `search` (all of them without it), before `skip` and `limit`.
  const LIST_USERS_MAX_LIMIT = 1000;
  systemAPI.register('system.listUsers',
    auditAs('subject'),
    async function listUsers (_context: MethodContext, params: { limit?: unknown, skip?: unknown, search?: unknown }, result: ResultBag, next: Next) {
      const paged = params.limit != null || params.skip != null || params.search != null;
      const limit = params.limit == null ? LIST_USERS_MAX_LIMIT : (params.limit === '' ? NaN : Number(params.limit));
      if (!Number.isInteger(limit) || limit < 1 || limit > LIST_USERS_MAX_LIMIT) return next(errors.invalidParametersFormat(`\`limit\` must be a whole number from 1 to ${LIST_USERS_MAX_LIMIT}.`, { limit: params.limit }));
      const skip = params.skip == null ? 0 : (params.skip === '' ? NaN : Number(params.skip));
      if (!Number.isInteger(skip) || skip < 0) return next(errors.invalidParametersFormat('`skip` must be a whole number, 0 or more.', { skip: params.skip }));
      if (params.search != null && (typeof params.search !== 'string' || params.search.length > USERNAME_SEARCH_MAX)) {
        return next(errors.invalidParametersFormat(`\`search\` must be a text of at most ${USERNAME_SEARCH_MAX} characters.`, { search: params.search }));
      }
      try {
        const usersMap: Record<string, string> = await usersIndex.getAllByUsername();
        let entries = Object.entries(usersMap);
        if (paged) {
          const prefix = typeof params.search === 'string' ? params.search.toLowerCase() : '';
          entries = entries.filter(([username]) => username.toLowerCase().startsWith(prefix))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        }
        result.total = entries.length;
        if (paged) entries = entries.slice(skip, skip + limit);
        const users: Array<{ username: string; id: string; email: string; language: string; core?: string | null }> = [];
        for (const [username, userId] of entries) {
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
    },
    inActorTrail()
  );

  // --------------------------------------------------------------- listCores
  systemAPI.register('system.listCores',
    auditAs('subject'),
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
    auditAs('subject'),
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
    auditAs('subject'),
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
    auditAs('subject'),
    auditTarget(byNamespace),
    commonFns.getParamsValidation(methodsSchema.extIdNamespacesSet.params),
    async function setExtIdNamespace (context: MethodContext & { extIdNamespaceCreated?: boolean }, params: { namespace: string, label?: string, defaultMode?: string }, result: ResultBag, next: Next) {
      try {
        const { created, info } = await setNamespace(platform, params.namespace,
          { label: params.label, defaultMode: params.defaultMode }, Date.now() / 1000);
        context.extIdNamespaceCreated = created;
        setAuditDetails(context, { diff: { created, ...(params.label != null ? { label: params.label } : {}), ...(params.defaultMode != null ? { defaultMode: params.defaultMode } : {}) } });
        result.namespace = info;
        next();
      } catch (err) {
        return next(extIdError(err));
      }
    },
    inActorTrail()
  );

  systemAPI.register('system.extIdNamespaces.delete',
    auditAs('subject'),
    auditTarget(byNamespace),
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
    },
    inActorTrail()
  );

  // The holder answer of the forced-mode accept check, asked by the core that
  // holds the auth request when the account lives here. A boolean and nothing
  // else: no date, no account, no core. Not audited (a read; one event per
  // probe in the user's trail would be noise).
  systemAPI.register('system.extIdHolds',
    auditAs('subject'),
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
    auditAs('subject'),
    auditTarget(byNamespace),
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
    },
    inActorTrail()
  );

  // ------------------------------------------------- auto-deletion reset
  // An administrator stops a pending auto-deletion for a holder (support
  // case): the schedule restarts from now, or the holder's own setting is
  // removed on their request (`removeSetting`). On the account's core; on
  // another core the route answers 307 to it.
  systemAPI.register('system.autoDeletion.reset',
    auditAs('subject'),
    auditTarget(byUsername),
    commonFns.getParamsValidation(methodsSchema.autoDeletionReset.params),
    async function autoDeletionReset (context: MethodContext, params: { username: string, reason: string, removeSetting?: boolean }, result: ResultBag, next: Next) {
      try {
        const outcome = await resetAutoDeletion(config, platform, params);
        if (outcome.kind === 'remote') {
          result.redirect = outcome.coreUrl;
          return next();
        }
        Object.assign(result, outcome.result);
        if (params.removeSetting === true) setAuditDetails(context, { diff: { removeSetting: true } });
        next();
      } catch (err) {
        return next(err instanceof APIError ? err : errors.unexpectedError(err));
      }
    },
    inActorTrail()
  );

  // ------------------------------------------------------ erasure ledger
  // The durable records of account erasures (business/src/erasureLedger).
  // Each row names the account by keyed hashes only.
  const ledgerKeyOf = () => ledgerKey(config);

  systemAPI.register('system.erasures.list',
    auditAs('subject'),
    async function listErasures (_context: MethodContext, params: { since?: unknown, limit?: unknown, after?: unknown }, result: ResultBag, next: Next) {
      const since = params.since == null ? 0 : (params.since === '' ? NaN : Number(params.since));
      if (!Number.isFinite(since) || since < 0) return next(errors.invalidParametersFormat('`since` must be a time in milliseconds since the epoch.', { since: params.since }));
      const limit = params.limit == null ? DEFAULT_LIST_LIMIT : Number(params.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) return next(errors.invalidParametersFormat(`\`limit\` must be a whole number from 1 to ${MAX_LIST_LIMIT}.`, { limit: params.limit }));
      const after = params.after == null ? null : parseCursor(params.after);
      if (params.after != null && after == null) return next(errors.invalidParametersFormat('`after` must be the `next` value of a previous answer.', { after: params.after }));
      try {
        const page = await listErasureRecords(platform, { since, limit, after });
        result.erasures = page.erasures;
        result.next = page.next;
        next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    },
    inActorTrail()
  );

  systemAPI.register('system.erasures.get',
    auditAs('subject'),
    async function lookupErasures (_context: MethodContext, params: { userId?: unknown, username?: unknown }, result: ResultBag, next: Next) {
      const byId = typeof params.userId === 'string' && params.userId.length > 0;
      const byName = typeof params.username === 'string' && params.username.length > 0;
      if (byId === byName || Object.keys(params).some((k) => k !== 'userId' && k !== 'username')) {
        return next(errors.invalidParametersFormat('Give exactly one of `userId` or `username` (a non-empty string).'));
      }
      try {
        const key = ledgerKeyOf();
        const erasures = await lookupErasureRecords(platform, key, byId ? { userId: params.userId as string } : { username: params.username as string });
        result.erased = erasures.length > 0;
        result.erasures = erasures;
        // The key the lookup matched with, and the records of other keys it
        // cannot match (a key change): `erased: false` is then not a proof.
        result.keyId = key.keyId;
        result.otherKeyRecords = await otherKeyRecordCount(platform, key);
        // The id or name looked up is not recorded: the ledger itself keeps
        // only keyed hashes of an erased account.
        next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    },
    inActorTrail()
  );

  // ------------------------------------------------- effective configuration
  // The configuration this API worker runs with, secrets redacted
  // (business/src/effectiveConfig). Audited without a user; the log line is
  // the trace of record when the audit syslog is off.
  systemAPI.register('system.getEffectiveConfig',
    auditAs('subject'),
    async function getEffectiveConfig (_context: MethodContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
      const extra = Object.keys(params).filter((k) => k !== 'digest');
      if (extra.length > 0) return next(errors.invalidParametersFormat('Unknown parameter(s): ' + extra.join(', ') + '. Only `digest` is accepted.', { parameters: extra }));
      if (params.digest != null && params.digest !== 'true' && params.digest !== 'false') {
        return next(errors.invalidParametersFormat('`digest` must be `true` or `false`.', { digest: params.digest }));
      }
      const digestOnly = params.digest === 'true';
      let observability;
      try {
        observability = await platform.getObservabilityResolution();
      } catch (err) {
        logger.warn('[config-effective-read] platform storage unreachable: ' + (err instanceof Error ? err.message : String(err)));
        return next(errors.apiUnavailable('The platform storage is unreachable: the effective configuration cannot be resolved now.'));
      }
      try {
        const doc = buildEffectiveConfig({
          scopes: scopesFromStores(config.store.stores),
          merged: (key: string) => config.get(key),
          observability,
          coreId: String(config.get('core:id')),
          apiVersion: await getAPIVersion()
        });
        logger.info('[config-effective-read] mode=' + (digestOnly ? 'digest' : 'full'));
        result.configMeta = doc.configMeta;
        if (!digestOnly) result.keys = doc.keys;
        next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    },
    inActorTrail()
  );

  // ------------------------------------------------------ eventTypesStatus
  // Operator-alertable state of the event-types dictionary. `degraded` is true
  // when the published dictionary has never loaded, in which case the core runs
  // on its embedded fallback and refuses unknown event types.
  systemAPI.register('system.getEventTypesStatus',
    auditAs('subject'),
    async function getEventTypesStatus (_context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        result.eventTypes = getEventTypesLoadState();
        return next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    }
  );

  // ------------------------------------------------------ migrationsStatus
  // Whether the storage schema is behind the code, for deploy checks. A core
  // with `migrations.autoRunOnStart: false` boots and serves with migrations
  // pending (schema-dependent methods then fail) until an operator runs
  // `bin/migrate.js up`, usually from another process while this core serves:
  // the status is read on every call, never cached. Always 200 when it could
  // be read; `upToDate` carries the answer.
  let migrationRunner: { status: () => Promise<unknown[]> } | null = null;
  systemAPI.register('system.getMigrationsStatus',
    auditAs('subject'),
    async function getMigrationsStatus (_context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        const { createMigrationRunner, summarizeStatus } = require('storages/interfaces/migrations/index.ts');
        migrationRunner ??= await createMigrationRunner({ logger: getLogger('migrations') });
        const statuses = await migrationRunner!.status();
        result.migrations = {
          autoRunOnStart: (await ready()).get('migrations:autoRunOnStart') ?? true,
          ...summarizeStatus(statuses)
        };
        return next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    }
  );

  // ------------------------------------------------------ auditStatus
  // How many audit records this core could not write since it started. Counts
  // only: no account, method or message. Read without storage, so it answers
  // when the audit storage is the failing part.
  systemAPI.register('system.getAuditStatus',
    auditAs('subject'),
    async function getAuditStatus (_context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
      try {
        const { readLossStatus } = require('./helpers/auditStatusIpc.ts');
        const { scope, since, lost } = await readLossStatus();
        result.audit = { active: (await ready()).get('audit:active') === true, scope, since, lost };
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
        // an operator's whole-core scan, not a request to bound
        result.checks = await storages.runMaintenance(async () => [
          await platform.checkIntegrity(),
          await usersIndex.checkIntegrity()
        ]);
        return next();
      } catch (err) {
        return next(err);
      }
    }
  );

  // --------------------------------------------------------------- deactivateMfa
  systemAPI.register('system.deactivateMfa',
    auditAs('subject'),
    auditTarget(byUsername),
    commonFns.getParamsValidation(methodsSchema.deactivateMfa.params),
    loadUserToMinimalMethodContext,
    deactivateMfa,
    inActorTrail()
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
}
