/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isDeepStrictEqual } = require('node:util');
const slugify = require('utils').slugify;
const timestamp = require('unix-timestamp');
const { fromCallback } = require('utils');

const APIError = require('errors').APIError;
const errors = require('errors').factory;
const ErrorIds = require('errors').ErrorIds;
const ErrorMessages = require('errors').ErrorMessages;

const { ApiEndpoint } = require('utils');

const commonFns = require('./helpers/commonFunctions.ts');
const methodsSchema = require('../schema/accessesMethods.ts');
const string = require('./helpers/string.ts');
const accountStreams = require('business/src/system-streams/index.ts');

const cache = require('cache').default;

const { getMall, storeDataUtils } = require('mall');
const { pubsub } = require('messages');
const { getStorageLayer } = require('storage');

const { integrity } = require('business');
const { parseAccessRef, serializeAccessRef, composeWireAccess } = require('business/src/accesses/refs.ts');
const AccessLogic = require('business/src/accesses/AccessLogic.ts').default;

// Scoped notifications: structured access-change signal carrying the changed
// access id + type + the streamIds it grants permissions on, so a notification
// engine can match standing accesses-kind scopes. Additive — the coarse
// USERNAME_BASED_ACCESSES_CHANGED signal is untouched. (A deletion carries only
// the id; type/permissions are no longer available.)
function notifyScopedAccessChange (username: string, access: { id?: string; type?: string; permissions?: Array<{ streamId?: string }> } | null | undefined, changeType: string): void {
  if (access?.id == null) return;
  const permissions = Array.isArray(access.permissions) ? access.permissions : [];
  const streamIds = permissions.map((p) => p?.streamId).filter((s): s is string => s != null);
  pubsub.scopedNotifications.emit(username, {
    kind: 'accesses',
    changeType,
    access: { id: access.id, type: access.type, streamIds }
  });
}
const cmc = require('cmc');
const { getLogger } = require('@pryv/boiler');
const WebhooksRepository = require('business').webhooks.Repository;
const { getUsersRepository } = require('business/src/users/index.ts');

type AccessLike = {
  id?: string;
  type?: AccessType;
  permissions?: Array<StreamPermission>;
  expires?: number | undefined | null;
  clientData?: {} | undefined | null;
  integrity?: string | null;
  createdBy?: string;
  serial?: number;
  [k: string]: unknown;
};
import type { MethodNext, NodeCallback } from './_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';
import type { PermissionLevel, AccessType, StreamPermission } from 'business/src/types/public.ts';
type MethodContext = BaseMethodContext;

type UpdatesSettingsHolder = {
  ignoreProtectedFields: boolean;
};

// Per-method param + result shapes mirroring components/api-server/src/schema/accessesMethods.ts.
// Hand-authored (JSON Schema literals there aren't TS-derived yet). Keep these in sync
// with that file when the wire schema changes.
type ItemDeletion = { id: string; deleted?: number };
type AccessesGetParams = { includeDeletions?: boolean; includeExpired?: boolean };
type AccessesGetResult = { accesses?: AccessLike[]; accessDeletions?: AccessLike[] };
type AccessesGetOneParams = { id: string; includeHistory?: boolean };
type AccessesGetOneResult = { access?: AccessLike; current?: string; history?: AccessLike[] };
type AccessesCreateParams = Partial<AccessLike> & { name?: string; permissions?: StreamPermission[]; clientData?: Record<string, unknown>; expireAfter?: number; deviceName?: string | null; randomAlias?: boolean; alias?: string };
type AccessesCreateResult = { access?: AccessLike };
type AccessesUpdateParams = { id: string; update: Partial<AccessLike> & { permissions?: StreamPermission[]; expires?: number | null; expireAfter?: number; clientData?: Record<string, unknown> | null }; targetAccess?: AccessLike; targetBase?: string };
// __updateNotification: internal scratch slot between snapshotAndApplyUpdate
// (producer) and emitUpdateNotifications (consumer); deleted before response.
type AccessesUpdateResult = { access?: AccessLike; __updateNotification?: { baseId: string; serial: number; compositeId: string } };
type AccessesDeleteParams = {
  id: string;
  accessToDelete?: AccessLike;
  // Full objects behind result.relatedDeletions, captured pre-delete by
  // findRelatedAccesses so the CMC post-delete hook can inspect their
  // clientData after the rows are gone. Internal; never serialized.
  relatedAccessesToDelete?: AccessLike[];
};
type AccessesDeleteResult = { accessDeletion?: ItemDeletion; relatedDeletions?: ItemDeletion[] };
type AccessesCheckAppParams = { requestingAppId: string; deviceName?: string; requestedPermissions: StreamPermission[]; clientData?: Record<string, unknown> };
type AccessesCheckAppResult = { matchingAccess?: AccessLike; mismatchingAccess?: AccessLike; checkedPermissions?: StreamPermission[]; error?: unknown };

export default async function produceAccessesApiMethods (api: { register (...args: unknown[]): unknown }) {
  const dbFindOptions = { projection: { calls: 0, deleted: 0 } };
  const mall = await getMall();
  const storageLayer = await getStorageLayer();
  const webhooksRepository = new WebhooksRepository(storageLayer.webhooks, storageLayer.events, storageLayer.accesses);

  // RETRIEVAL

  api.register(
    'accesses.get',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.get.params),
    findAccessibleAccesses,
    includeDeletionsIfRequested
  );

  async function findAccessibleAccesses (context: MethodContext, params: AccessesGetParams, result: AccessesGetResult, next: MethodNext) {
    const currentAccess = context.access;
    const accessesRepository = storageLayer.accesses;
    const query: Record<string, unknown> = {};
    if (currentAccess == null) { return next(new Error('AF: Access cannot be null at this point.')); }
    if (!currentAccess.canListAnyAccess()) {
      // app -> only access it created
      query.createdBy = currentAccess.id;
    }
    try {
      let accesses: AccessLike[] = await fromCallback((cb: NodeCallback) => accessesRepository.find(context.user, query, dbFindOptions, cb));
      if (excludeExpired(params)) {
        accesses = accesses.filter((a: AccessLike) => !isAccessExpired(a));
      }
      // Compose wire-format ids + strip internal serial fields, then
      // attach apiEndpoint.
      result.accesses = accesses.map((a: AccessLike) => {
        const wire = composeWireAccess(a);
        wire.apiEndpoint = ApiEndpoint.buildForAccess(wire, context.user.username);
        return wire;
      });
      next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    function excludeExpired (params: { includeExpired?: boolean }) {
      return !params.includeExpired;
    }
  }

  async function includeDeletionsIfRequested (context: MethodContext, params: AccessesGetParams, result: AccessesGetResult, next: MethodNext) {
    if (params.includeDeletions == null) {
      return next();
    }
    const currentAccess = context.access;
    const accessesRepository = storageLayer.accesses;
    const query: Record<string, unknown> = {};
    if (!currentAccess.canListAnyAccess()) {
      // app -> only access it created
      query.createdBy = currentAccess.id;
    }
    try {
      const deletions = await fromCallback((cb: NodeCallback) => accessesRepository.findDeletionRecords(context.user, query, { projection: { calls: 0 } }, cb));
      result.accessDeletions = (deletions || []).map((d: unknown) => composeWireAccess(d));
      next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
  }

  // GET ONE

  api.register(
    'accesses.getOne',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.getOne.params),
    findOneAccess
  );

  async function findOneAccess (context: MethodContext, params: AccessesGetOneParams, result: AccessesGetOneResult, next: MethodNext) {
    let ref;
    try {
      ref = parseAccessRef(params.id);
    } catch (e) {
      return next(errors.unknownResource('access', params.id));
    }
    const accessesRepository = storageLayer.accesses;
    let head: { id: string; serial?: number; createdBy?: string; [k: string]: unknown } | null = null;
    try {
      head = await fromCallback((cb: NodeCallback) =>
        accessesRepository.findOne(context.user, { id: ref.base }, dbFindOptions, cb));
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    if (head == null) return next(errors.unknownResource('access', params.id));
    // Visibility — app callers can only see accesses they manage.
    if (!context.access.canListAnyAccess()) {
      const createdByBase = typeof head.createdBy === 'string'
        ? parseAccessRef(head.createdBy).base
        : null;
      const isOwn = head.id === context.access.id;
      const isManaged = createdByBase === context.access.id;
      if (!isOwn && !isManaged) {
        return next(errors.unknownResource('access', params.id));
      }
    }
    const currentSerial = head.serial == null ? null : head.serial;
    const wantsSpecific = ref.serial != null;
    const specificMatchesHead = wantsSpecific && currentSerial != null && ref.serial === currentSerial;
    if (!wantsSpecific || specificMatchesHead) {
      // Current head — return as-is.
      const wire = composeWireAccess(head);
      wire.apiEndpoint = ApiEndpoint.buildForAccess(wire, context.user.username);
      result.access = wire;
    } else if (currentSerial != null && ref.serial < currentSerial) {
      // Obsolete composite — historical row, with a `current` hint pointing
      // at the live head's composite id (Q-pivot=a, GitHub-commit-by-sha-style).
      let history: AccessLike[] = [];
      try {
        history = await accessesRepository.findHistory(context.user, ref.base);
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
      const snapshot = (history || []).find((h: AccessLike & { serial?: number }) => (h.serial ?? null) === ref.serial);
      if (snapshot == null) return next(errors.unknownResource('access', params.id));
      const wire = composeWireAccess(snapshot, ref.base);
      wire.apiEndpoint = ApiEndpoint.buildForAccess(wire, context.user.username);
      result.access = wire;
      result.current = serializeAccessRef({ base: ref.base, serial: currentSerial });
    } else {
      // Requested a serial > head's current (never existed) or the head
      // was never updated and a serial was provided.
      return next(errors.unknownResource('access', params.id));
    }
    if (params.includeHistory) {
      try {
        const history = await accessesRepository.findHistory(context.user, ref.base);
        result.history = (history || []).map((h: AccessLike) => {
          const wire = composeWireAccess(h, ref.base);
          wire.apiEndpoint = ApiEndpoint.buildForAccess(wire, context.user.username);
          return wire;
        });
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    }
    next();
  }

  // CREATION

  const notVisibleAccountStreamsIds = accountStreams.hiddenStreamIds;
  const visibleAccountStreamsIds = Object.keys(accountStreams.accountMap).filter(id => accountStreams.accountMap[id].isShown);

  const cmcAccessCreateForgePreventionHook = cmc.createAccessCreateForgePreventionHook({ errors });
  const cmcAccessUpdateForgePreventionHook = cmc.createAccessUpdateForgePreventionHook({ errors });
  const cmcAccessProvisionAppScopeHook = cmc.createAccessProvisionAppScopeHook({
    mall,
    logger: getLogger('cmc:access-provision-app-scope'),
  });

  api.register(
    'accesses.create',
    commonFns.basicAccessAuthorizationCheck,
    applyDefaultsForCreation,
    commonFns.getParamsValidation(methodsSchema.create.params),
    cmcAccessCreateForgePreventionHook,
    applyPrerequisitesForCreation, applyAccountStreamsValidation,
    createDataStructureFromPermissions,
    cleanupPermissions,
    createAccess,
    cmcAccessProvisionAppScopeHook,
    addIntegrityToContext
  );

  function applyDefaultsForCreation (context: MethodContext, params: AccessesCreateParams, result: AccessesCreateResult, next: MethodNext) {
    params.type ??= 'shared';
    next();
  }

  async function applyPrerequisitesForCreation (context: MethodContext, params: AccessesCreateParams, result: AccessesCreateResult, next: MethodNext) {
    if (params.type === 'personal') {
      return next(errors.forbidden('Personal accesses are created automatically on login.'));
    }
    const permissions = params.permissions!;
    for (const permission of permissions) {
      if (permission.streamId != null) {
        try {
          commonFns.isValidStreamIdForQuery(permission.streamId, permission, 'permissions');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return next(errors.invalidRequestStructure(msg, params.permissions));
        }
      }
    }
    const access = context.access;
    if (!(await access.canCreateAccess(params))) {
      return next(errors.forbidden('Your access token has insufficient permissions ' +
                'to create this new access.'));
    }
    if (params.token != null) {
      params.token = slugify(params.token);
      if (string.isReservedId(params.token)) {
        return next(errors.invalidItemId('The specified token is not allowed.'));
      }
    } else {
      const accessesRepository = storageLayer.accesses;
      params.token = accessesRepository.generateToken();
    }
    // Mint a routable, platform-unique alias when requested. Replaces the
    // username in this access's apiEndpoint so the real username never leaks.
    if (params.randomAlias === true) {
      const usersRepository = await getUsersRepository();
      params.alias = await usersRepository.mintAlias(context.user.username, context.user.id);
    }
    delete params.randomAlias;
    const expireAfter = params.expireAfter;
    delete params.expireAfter;
    if (expireAfter != null) {
      if (expireAfter >= 0) { params.expires = timestamp.now() + expireAfter; } else { return next(errors.invalidParametersFormat('expireAfter cannot be negative.')); }
    }
    // A managed shared access cannot outlive its managing app's expiry.
    // Enforced on create for consistency with the update path (BREAKING —
    // see CHANGELOG-v2.md). Parent with `expires: null` imposes no
    // constraint.
    if (access.expires != null && params.expires != null && params.expires > access.expires) {
      return next(errors.invalidOperation(
        'New access cannot expire later than the managing access.',
        { parentExpires: access.expires, requestedExpires: params.expires }
      ));
    }
    context.initTrackingProperties(params);
    return next();
  }

  /**
   * If user is creating an access for system streams, apply some validations
   */
  function applyAccountStreamsValidation (context: MethodContext, params: AccessesCreateParams, result: AccessesCreateResult, next: MethodNext) {
    if (params.permissions == null) { return next(); }
    for (const permission of params.permissions) {
      if (isStreamBasedPermission(permission)) {
        if (isUnknownSystemStream(permission.streamId)) {
          return next(errors.forbidden('Forbidden'));
        }
        // don't allow user to give access to not visible stream
        if (notVisibleAccountStreamsIds.includes(permission.streamId)) {
          return next(errors.invalidOperation(ErrorMessages[ErrorIds.DeniedStreamAccess], { param: permission.streamId }));
        }
        // don't allow user to give anything higher than contribute or read access
        // to visible stream
        if (visibleAccountStreamsIds.includes(permission.streamId) &&
                    !context.access.canCreateAccessForAccountStream(permission.level)) {
          return next(errors.invalidOperation(ErrorMessages[ErrorIds.TooHighAccessForSystemStreams], { param: permission.streamId }));
        }
      }
    }

    function isStreamBasedPermission (permission: StreamPermission) {
      return permission.streamId != null;
    }

    function isUnknownSystemStream (streamId: string) {
      return ((streamId.startsWith(':_system:') || streamId.startsWith(':system:')) &&
                accountStreams.toFieldName(streamId) === streamId);
    }
    return next();
  }

  // Creates default data structure from permissions if needed, for app
  // authorization.
  //
  async function createDataStructureFromPermissions (context: MethodContext, params: AccessesCreateParams, result: AccessesCreateResult, next: MethodNext) {
    const access = context.access;
    if (!access.isPersonal()) { return next(); } // not needed for personal access
    for (const permission of params.permissions!) {
      try {
        await ensureStream(permission);
      } catch (e) {
        return next(e);
      }
    }
    return next();
    async function ensureStream (permission: StreamPermission) {
      // We ensure stream Exists only if streamid is !== '*' and if a defaultName is providedd
      if (permission.streamId == null ||
                permission.streamId === '*' ||
                permission.defaultName == null) { return; }
      // CMC plugin owns the `:_cmc:*` namespace: reserved parents are
      // provisioned at user-creation time, user-creatable scopes under
      // `:_cmc:apps:<app>` and plugin-managed sub-streams are created on
      // demand by the plugin. Letting this code attempt creation here
      // would hit the local-store streamId regex which rejects the
      // colon and fail valid permissions like `:_cmc:inbox` or
      // `:_cmc:apps:<app>` at access-create time.
      if (permission.streamId.startsWith(':_cmc:')) { return; }
      const existingStream = await context.streamForStreamId(permission.streamId, null);
      if (existingStream != null) {
        if (!existingStream.trashed) { return; }
        // untrash stream
        const update = { id: existingStream.id, trashed: false };
        try {
          await mall.streams.update(context.user.id, update);
        } catch (err) {
          throw errors.unexpectedError(err);
        }
        return;
      }
      // create new stream
      const newStream: { id: string; name: string; parentId: string | null; clientData?: { 'pryv-cmc-virtual'?: { revealedBy: string } } } = {
        id: permission.streamId,
        name: permission.defaultName,
        parentId: null
      };

      // check validity of Id if stream is local store
      const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(permission.streamId);
      if (storeId === 'local') {
        if (!commonFns.isValidStreamIdForCreation(permission.streamId)) {
          throw errors.invalidRequestStructure(`Error while creating stream for access. Invalid 'permission' parameter, forbidden character(s) in streamId '${permission.streamId}'. StreamId should be of length 1 to 100 chars, with lowercase letters, numbers or dashes.`, permission);
        }
      } else {
        newStream.parentId = ':' + storeId + ':';
      }

      context.initTrackingProperties(newStream);
      try {
        await mall.streams.create(context.user.id, newStream);
      } catch (err) {
        if (err instanceof APIError) {
          throw err;
        }
        throw errors.unexpectedError(err);
      }
    }
  }

  /**
   * Strips off the properties in permissions that are used to create the default data structure
   * (for app authorization).
   */
  function cleanupPermissions (context: MethodContext, params: AccessesCreateParams, result: AccessesCreateResult, next: MethodNext) {
    if (!params.permissions) {
      return next();
    }
    params.permissions.forEach(function (perm: StreamPermission) {
      delete perm.defaultName;
      delete perm.name;
    });
    next();
  }

  function createAccess (context: MethodContext, params: AccessesCreateParams, result: AccessesCreateResult, next: MethodNext) {
    const accessesRepository = storageLayer.accesses;
    if (params.type === 'shared') params.deviceName = null;
    accessesRepository.insertOne(context.user, params, function (err: (Error & { isDuplicateIndex: (k: string) => boolean }) | null, newAccess: { id: string; [k: string]: unknown } | undefined) {
      if (err != null) {
        // Duplicate errors
        if (err.isDuplicateIndex('token')) {
          return next(errors.itemAlreadyExists('access', { token: '(hidden)' }));
        }
        if (err.isDuplicateIndex('type') &&
                    err.isDuplicateIndex('name') &&
                    err.isDuplicateIndex('deviceName')) {
          return next(errors.itemAlreadyExists('access', {
            type: params.type,
            name: params.name,
            deviceName: params.deviceName
          }));
        }
        // Any other error
        return next(errors.unexpectedError(err));
      }
      const wire = composeWireAccess(newAccess);
      wire.apiEndpoint = ApiEndpoint.buildForAccess(wire, context.user.username);
      result.access = wire;
      pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
      notifyScopedAccessChange(context.user.username, wire, 'create');
      next();
    });
  }

  // UPDATE

  // Adapter so the post-hook can write a local audit event into the
  // collectors stream when an access is updated externally (the hook
  // only uses mall.events.create).
  const cmcAccessesUpdateHook = cmc.createAccessesUpdatePostHook({
    mall,
    // Lazy fetch resolution — see the delete hook below.
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
    timeoutMs: 15_000,
    logger: getLogger('cmc:accesses-update-hook'),
  });

  api.register(
    'accesses.update',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.update.params),
    cmcAccessUpdateForgePreventionHook,
    loadAccessForUpdate,
    enforceUpdateChainRules,
    cleanupUpdatePermissions,
    snapshotAndApplyUpdate,
    cmcAccessProvisionAppScopeHook,
    emitUpdateNotifications,
    cmcAccessesUpdatePostHookMiddleware
  );

  // Mirror of `cleanupPermissions` for the update path. UPDATE accepts the
  // same {defaultName, name} extras as CREATE (B-2026-05-14-4 symmetry fix)
  // so callers can pipe `checkApp.checkedPermissions` straight in. The
  // server still doesn't want those app-authorization-UI fields in the
  // stored permission — strip before snapshotAndApplyUpdate persists.
  function cleanupUpdatePermissions (context: MethodContext, params: AccessesUpdateParams, result: AccessesUpdateResult, next: MethodNext) {
    if (!params.update || !Array.isArray(params.update.permissions)) {
      return next();
    }
    params.update.permissions.forEach(function (perm: StreamPermission) {
      delete perm.defaultName;
      delete perm.name;
    });
    next();
  }

  /**
   * Fire-and-forget invocation of the CMC accesses.update post-hook.
   * The hook handles its own filtering (skips non-CMC accesses + skips
   * when called inside runWithSuppression). Errors are caught inside
   * the hook so we don't propagate to events.create's caller.
   */
  function cmcAccessesUpdatePostHookMiddleware (context: MethodContext, params: AccessesUpdateParams, result: AccessesUpdateResult, next: MethodNext) {
    const before = params.targetAccess;
    const after = result?.access;
    if (after != null && context?.user?.id != null) {
      Promise.resolve()
        .then(() => cmcAccessesUpdateHook(context.user.id, before, after))
        .catch((err: unknown) => {
          getLogger('cmc:accesses-update-hook').warn('cmc/accessesUpdateHook: uncaught error', {
            error: String((err as Error)?.message ?? err),
          });
        });
    }
    next();
  }

  async function loadAccessForUpdate (context: MethodContext, params: AccessesUpdateParams, result: AccessesUpdateResult, next: MethodNext) {
    // Composite-id parse + conflict-check. The wire-form `id` is either
    // bare cuid (never-updated access) or `<base>:<serial>`. Look up by
    // base; reject stale composites with 409.
    let ref;
    try {
      ref = parseAccessRef(params.id);
    } catch (e) {
      return next(errors.unknownResource('access', params.id));
    }
    let access: { id: string; type?: string; createdBy?: string; expires?: number | null; [k: string]: unknown } | null = null;
    try {
      access = await fromCallback((cb: NodeCallback) => {
        storageLayer.accesses.findOne(context.user, { id: ref.base }, dbFindOptions, cb);
      });
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    // findOne filters head_id IS NULL + deleted IS NULL (Phase A), so a
    // soft-deleted access also returns null — Q12.2=a treats it as
    // unknownResource. No info leak via differentiated error.
    if (access == null) {
      return next(errors.unknownResource('access', params.id));
    }
    const accessSerial = (access.serial == null) ? null : access.serial;
    if ((accessSerial == null && ref.serial != null) ||
        (accessSerial != null && ref.serial !== accessSerial)) {
      return next(errors.staleResource('access', {
        provided: params.id,
        currentSerial: accessSerial
      }));
    }
    if (!(await context.access.canUpdateAccess(access))) {
      return next(errors.forbidden('Your access token has insufficient permissions to update this access.'));
    }
    params.targetAccess = access as AccessLike;
    params.targetBase = ref.base;
    next();
  }

  async function enforceUpdateChainRules (context: MethodContext, params: AccessesUpdateParams, result: AccessesUpdateResult, next: MethodNext) {
    const target = params.targetAccess!;
    const updates = params.update;

    // expireAfter → expires (mirrors create semantics).
    if (updates.expireAfter !== undefined) {
      const ea = updates.expireAfter;
      delete updates.expireAfter;
      if (ea == null) {
        updates.expires = null;
      } else if (ea >= 0) {
        updates.expires = timestamp.now() + ea;
      } else {
        return next(errors.invalidParametersFormat('expireAfter cannot be negative.'));
      }
    }

    const wantsPermChange = Array.isArray(updates.permissions);
    const wantsExpiresChange = Object.prototype.hasOwnProperty.call(updates, 'expires');
    if (!wantsPermChange && !wantsExpiresChange) {
      return next();
    }

    const after: { type?: string; permissions?: StreamPermission[]; expires?: number | null; [k: string]: unknown } = Object.assign({}, target, updates);

    try {
      if (target.type === 'shared') {
        // Rules A + D — child cannot exceed managing app's scope/expiry.
        let managingApp: InstanceType<typeof AccessLogic> | null = null;
        const createdByBase = parseAccessRef(target.createdBy).base;
        if (createdByBase === context.access.id) {
          managingApp = context.access;
        } else {
          const mgrRow = await fromCallback((cb: NodeCallback) =>
            storageLayer.accesses.findOne(context.user, { id: createdByBase }, null, cb));
          if (mgrRow != null) {
            managingApp = new AccessLogic(context.user.id, mgrRow);
            await managingApp.loadPermissions();
          }
        }
        if (managingApp != null) {
          if (wantsPermChange) {
            const fits = await managingApp.canCreateAccess({
              type: 'shared',
              permissions: after.permissions
            });
            if (!fits) {
              return next(errors.invalidOperation(
                'new permissions exceed managing access scope',
                { managingAccessId: managingApp.id }
              ));
            }
          }
          if (wantsExpiresChange && managingApp.expires != null &&
              after.expires != null && after.expires > managingApp.expires) {
            return next(errors.invalidOperation(
              'expires cannot be later than the managing access.',
              { parentExpires: managingApp.expires, requestedExpires: after.expires }
            ));
          }
        }
      }
      if (target.type === 'app') {
        // Rules B/C + D — narrowing parent rejects if any managed shared
        // would now sit outside the new scope/expiry.
        const wouldBe = new AccessLogic(context.user.id, after);
        await wouldBe.loadPermissions();
        const allAccesses = await fromCallback((cb: NodeCallback) =>
          storageLayer.accesses.find(context.user, {}, null, cb));
        const managed = (allAccesses || []).filter((a: { id: string; type?: string; createdBy?: string }) =>
          a.type === 'shared' && a.id !== target.id &&
          typeof a.createdBy === 'string' &&
          parseAccessRef(a.createdBy).base === target.id);
        const offendingChildren: string[] = [];
        for (const child of managed) {
          if (wantsPermChange) {
            const fits = await wouldBe.canCreateAccess({
              type: 'shared',
              permissions: child.permissions || []
            });
            if (!fits) {
              offendingChildren.push(child.id);
              continue;
            }
          }
          if (wantsExpiresChange && after.expires != null &&
              child.expires != null && child.expires > after.expires) {
            offendingChildren.push(child.id);
          }
        }
        if (offendingChildren.length > 0) {
          return next(errors.invalidOperation(
            'cannot narrow access: would orphan managed shared accesses',
            { offendingChildren }
          ));
        }
      }
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    next();
  }

  async function snapshotAndApplyUpdate (context: MethodContext, params: AccessesUpdateParams, result: AccessesUpdateResult, next: MethodNext) {
    const target = params.targetAccess!;
    const baseId = params.targetBase;
    const updates = params.update;
    const accessesRepository = storageLayer.accesses;
    const newSerial = ((target.serial == null) ? 0 : target.serial) + 1;
    const update: { serial?: number; modifiedBySerial?: number | null; [k: string]: unknown } = Object.assign({}, updates);
    update.serial = newSerial;
    context.updateTrackingProperties(update);
    update.modifiedBySerial = (context.access?.serial == null) ? null : context.access.serial;

    try {
      // 1. Snapshot current head into history row (frozen state pre-bump).
      await fromCallback((cb: NodeCallback) => accessesRepository.snapshotHead(context.user, baseId, cb));
      // 2. Apply head update (integrity-aware updateOne handles the hash).
      await fromCallback((cb: NodeCallback) =>
        accessesRepository.updateOne(context.user, { id: baseId }, update, cb));
      // 3. Re-read the new head.
      const newHead = await fromCallback((cb: NodeCallback) =>
        accessesRepository.findOne(context.user, { id: baseId }, dbFindOptions, cb));
      if (newHead == null) {
        return next(errors.unexpectedError(new Error('head row missing after update')));
      }
      // 4. Compose wire-form access (composite id + createdBy/modifiedBy
      // refs, internal serial fields stripped).
      const wire = composeWireAccess(newHead);
      wire.apiEndpoint = ApiEndpoint.buildForAccess(wire, context.user.username);
      result.access = wire;
      result.__updateNotification = { baseId: baseId!, serial: newSerial, compositeId: wire.id! };
    } catch (err) {
      return next(errors.unexpectedError(err));
    }

    // 5. Cache invalidation — parallel to delete's pattern at line ~388.
    const cached = cache.getAccessLogicForId(context.user.id, baseId);
    if (cached != null) {
      cache.unsetAccessLogic(context.user.id, cached);
    }
    next();
  }

  function emitUpdateNotifications (context: MethodContext, params: AccessesUpdateParams, result: AccessesUpdateResult, next: MethodNext) {
    // Coarse-grained event — existing subscribers refetch on any access
    // change. String payload matches the legacy create/delete shape so
    // `Manager.pubsubMessageToSocket` translates it to `accessesChanged`.
    pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
    notifyScopedAccessChange(context.user.username, result.access, 'update');
    // Fine-grained event — payload is a structured `{ type, … }` object
    // so socket.io can forward both the event name (via type) and the
    // data fields (accessId, serial) to subscribers.
    const notification = result.__updateNotification!;
    pubsub.notifications.emit(context.user.username, {
      type: pubsub.ACCESS_UPDATED,
      accessId: notification.compositeId,
      serial: notification.serial
    });
    delete result.__updateNotification;
    next();
  }

  // DELETION

  // CMC post-delete hook: forwards a `consent/revoke-cmc` to the
  // counterparty when a CMC relationship access is removed by a plain
  // accesses.delete (e.g. a generic "connected apps" UI), so consent
  // withdrawal is observable by the peer regardless of the revocation
  // path. CMC's own teardown deletes via mall (not this route), so the
  // hook never double-fires for helper-driven revokes.
  const cmcAccessesDeleteHook = cmc.createAccessesDeletePostHook({
    // Resolve globalThis.fetch lazily (per call) so in-process test
    // shims installed after registration are honoured — same pattern
    // as the events.ts cmc deps.
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
    timeoutMs: 15_000,
    logger: getLogger('cmc:accesses-delete-hook'),
  });

  api.register(
    'accesses.delete',
    commonFns.getParamsValidation(methodsSchema.del.params),
    checkAccessForDeletion,
    findRelatedAccesses,
    deleteAccesses,
    cmcAccessesDeletePostHookMiddleware
  );

  /**
   * Fire-and-forget invocation of the CMC accesses.delete post-hook
   * (same pattern as the accesses.update one). The hook filters
   * non-CMC accesses itself and never throws; failures are logged.
   */
  function cmcAccessesDeletePostHookMiddleware (context: MethodContext, params: AccessesDeleteParams, result: AccessesDeleteResult, next: MethodNext) {
    const deleted: AccessLike[] = [];
    if (params.accessToDelete != null) deleted.push(params.accessToDelete);
    if (Array.isArray(params.relatedAccessesToDelete)) deleted.push(...params.relatedAccessesToDelete);
    if (deleted.length > 0 && context?.user?.id != null) {
      Promise.resolve()
        .then(() => cmcAccessesDeleteHook(context.user.id, deleted))
        .catch((err: unknown) => {
          getLogger('cmc:accesses-delete-hook').warn('cmc/accessesDeleteHook: uncaught error', {
            error: String((err as Error)?.message ?? err),
          });
        });
    }
    next();
  }

  async function checkAccessForDeletion (context: MethodContext, params: AccessesDeleteParams, result: AccessesDeleteResult, next: MethodNext) {
    const accessesRepository = storageLayer.accesses;
    const currentAccess = context.access;
    if (currentAccess == null) { return next(new Error('AF: currentAccess cannot be null.')); }
    // Parse composite id + serial conflict-check (mirrors update).
    let ref;
    try {
      ref = parseAccessRef(params.id);
    } catch (e) {
      return next(errors.unknownResource('access', params.id));
    }
    let access: { id: string; type?: string; createdBy?: string; [k: string]: unknown } | null = null;
    try {
      access = await fromCallback((cb: NodeCallback) => {
        accessesRepository.findOne(context.user, { id: ref.base }, dbFindOptions, cb);
      });
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    if (access == null) { return next(errors.unknownResource('access', params.id)); }
    const accessSerial = (access.serial == null) ? null : access.serial;
    if ((accessSerial == null && ref.serial != null) ||
        (accessSerial != null && ref.serial !== accessSerial)) {
      return next(errors.staleResource('access', {
        provided: params.id,
        currentSerial: accessSerial
      }));
    }
    if (!(await currentAccess.canDeleteAccess(access))) {
      return next(errors.forbidden('Your access token has insufficient permissions to ' +
                'delete this access.'));
    }
    // Subsequent stages address the access by its bare base id (storage
    // doesn't accept composite ids).
    params.id = ref.base;
    params.accessToDelete = (access ?? undefined) as AccessLike | undefined;
    next();
  }

  async function findRelatedAccesses (context: MethodContext, params: AccessesDeleteParams, result: AccessesDeleteResult, next: MethodNext) {
    const accessToDelete = params.accessToDelete!;
    const accessesRepository = storageLayer.accesses;
    // Deleting a personal access does NOT delete the app/shared accesses it
    // created — the user keeps the apps they granted while logged in. Only
    // app/shared deletes cascade to descendants.
    if (accessToDelete.type === 'personal') {
      return next();
    }
    let accesses: AccessLike[] = [];
    try {
      accesses = await fromCallback((cb: NodeCallback) => {
        accessesRepository.find(context.user, { createdBy: params.id }, dbFindOptions, cb);
      });
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    if (accesses.length === 0) { return next(); }
    accesses = accesses.filter((a) => a.id !== params.id);
    accesses = accesses.filter((a) => !isAccessExpired(a));
    result.relatedDeletions = accesses.map((a) => ({ id: a.id! }));
    params.relatedAccessesToDelete = accesses;
    next();
  }

  async function deleteAccesses (context: MethodContext, params: AccessesDeleteParams, result: AccessesDeleteResult, next: MethodNext) {
    const accessesRepository = storageLayer.accesses;
    let idsToDelete = [{ id: params.id }];
    if (result.relatedDeletions != null) {
      idsToDelete = idsToDelete.concat(result.relatedDeletions);
    }
    // remove from cache
    for (const idToDelete of idsToDelete) {
      const accessToDelete = cache.getAccessLogicForId(context.user.id, idToDelete.id);
      if (accessToDelete != null) {
        cache.unsetAccessLogic(context.user.id, accessToDelete);
      }
    }
    // Collect any aliases carried by the accesses being deleted, so their
    // platform reservation + routing entries can be released afterwards.
    const aliasesToRelease: string[] = [];
    for (const idToDelete of idsToDelete) {
      const access = await fromCallback((cb: NodeCallback) => accessesRepository.findOne(context.user, { id: idToDelete.id }, dbFindOptions, cb)) as AccessLike | null;
      if (access != null && typeof access.alias === 'string') { aliasesToRelease.push(access.alias); }
    }
    // Cascade webhook deletion BEFORE access deletion. On partial failure,
    // the access still exists so a retry re-runs the cascade.
    try {
      for (const idToDelete of idsToDelete) {
        await webhooksRepository.deleteByAccess(context.user, idToDelete.id);
      }
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    try {
      await fromCallback((cb: NodeCallback) => {
        accessesRepository.delete(context.user, { $or: idsToDelete }, cb);
      });
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    if (aliasesToRelease.length > 0) {
      const usersRepository = await getUsersRepository();
      for (const alias of aliasesToRelease) {
        await usersRepository.releaseAlias(alias);
      }
    }
    result.accessDeletion = { id: params.id };
    pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
    notifyScopedAccessChange(context.user.username, result.accessDeletion, 'delete');
    next();
  }

  // OTHER METHODS

  api.register(
    'accesses.checkApp',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.checkApp.params),
    checkApp
  );

  function checkApp (context: MethodContext, params: AccessesCheckAppParams, result: AccessesCheckAppResult, next: MethodNext) {
    const accessesRepository = storageLayer.accesses;
    const query = {
      type: 'app',
      name: params.requestingAppId,
      deviceName: params.deviceName || null
    };
    accessesRepository.findOne(context.user, query, dbFindOptions, function (err: Error | null, access: AccessLike | null) {
      if (err != null) { return next(errors.unexpectedError(err)); }
      // Do we have a match?
      if (access != null && accessMatches(access, params.requestedPermissions, params.clientData)) {
        result.matchingAccess = composeWireAccess(access);
        return next();
      }
      // No, we don't have a match. Return other information:
      if (access != null) { result.mismatchingAccess = composeWireAccess(access); }
      checkPermissions(context, params.requestedPermissions, function (err: Error | null, checkedPermissions?: StreamPermission[] | null, checkError?: unknown) {
        if (err != null) { return next(err); }
        result.checkedPermissions = checkedPermissions ?? undefined;
        if (checkError != null) {
          result.error = checkError;
        }
        next();
      });
    });
  }

  // Returns true if the given access' permissions match the `requestedPermissions`.
  //
  function accessMatches (access: AccessLike, requestedPermissions: StreamPermission[], clientData?: Record<string, unknown>) {
    if (access == null ||
            access.type !== 'app' ||
            access.permissions == null) {
      return false;
    }
    // Ignore the permissions AccessLogic injects into every non-personal
    // access at load time — ':_system:account' (none) and
    // ':_audit:access-<id>' (read, selfAudit). They are not part of what the
    // app requested, so counting them would make every existing app access
    // report as mismatching (the requesting app re-prompts for consent on
    // every sign-in).
    const isInjectedPermission = (perm: StreamPermission) =>
      (perm.streamId === accountStreams.STREAM_ID_ACCOUNT && perm.level === 'none') ||
      (perm.streamId === ':_audit:access-' + access.id && perm.level === 'read');
    const accessPerms = access.permissions.filter((perm) => !isInjectedPermission(perm));
    const requestedPerms = requestedPermissions.filter((perm) => !isInjectedPermission(perm));
    if (accessPerms.length !== requestedPerms.length) {
      return false;
    }
    // If the access is there but is expired, we consider it a mismatch.
    if (isAccessExpired(access)) { return false; }
    // Compare permissions
    let accessPerm, reqPerm;
    for (let i = 0, ni = accessPerms.length; i < ni; i++) {
      accessPerm = accessPerms[i];
      reqPerm = findByStreamId(requestedPerms, accessPerm.streamId);
      if (!reqPerm || reqPerm.level !== accessPerm.level) {
        return false;
      }
    }
    // Compare clientData (treat null and undefined as equivalent)
    if (!isDeepStrictEqual(access.clientData ?? null, clientData ?? null)) {
      return false;
    }
    return true;
    function findByStreamId (permissions: StreamPermission[], streamId: string) {
      return permissions.find((perm) => perm.streamId === streamId);
    }
  }

  // Iterates over the given permissions, replacing `defaultName` properties
  // with the actual `name` of existing streams. When defined, the callback's
  // `checkError` param signals issues with the requested permissions.
  //
  function checkPermissions (context: MethodContext, permissions: StreamPermission[], callback: (err: Error | null, checked?: StreamPermission[] | null, checkError?: unknown) => void) {
    // modify permissions in-place, assume no side fx
    const checkedPermissions = permissions;
    let checkError: unknown = null;
    let i = 0;
    function nextPermission (err?: unknown) {
      if (err != null) {
        return err instanceof APIError
          ? callback(err as Error)
          : callback(errors.unexpectedError(err));
      }
      if (i >= checkedPermissions.length) return callback(null, checkedPermissions, checkError);
      checkPermission(checkedPermissions[i++], nextPermission);
    }
    nextPermission();

    function checkPermission (permission: StreamPermission, done: (err?: unknown) => void) {
      if (permission.streamId === '*') {
        // cleanup ignored properties just in case
        delete permission.defaultName;
        return done();
      }
      if (permission.defaultName == null) {
        return done(errors.invalidParametersFormat("The parameters' format is invalid.", 'The permission for stream "' +
                    permission.streamId +
                    '" (and maybe others) is ' +
                    'missing the required "defaultName".'));
      }
      let permissionStream: { id: string; name?: string; trashed?: boolean; [k: string]: unknown } | null = null;
      (async () => {
        try {
          // checkId
          const existingStream = await mall.streams.getOneWithNoChildren(context.user.id, permission.streamId);
          if (existingStream != null) {
            permission.name = existingStream.name;
            delete permission.defaultName;
          }
          // checkSimilar
          if (permissionStream == null) {
            // new streams are created at "root" level so we check the children's name of root (id)
            const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(permission.streamId);
            const rootStreams = await mall.streams.get(context.user.id, {
              storeId,
              state: 'all',
              includeTrashed: true
            });
            const rootStreamsNames = rootStreams.map((stream: { name: string }) => stream.name);
            const defaultBaseName = permission.defaultName;
            for (let suffixNum = 1; rootStreamsNames.indexOf(permission.defaultName) !== -1; suffixNum++) {
              permission.defaultName = `${defaultBaseName} (${suffixNum})`;
              checkError = produceCheckError();
            }
          }
          done();
        } catch (err) {
          done(err);
        }
      })();
    }

    function produceCheckError () {
      return {
        id: ErrorIds.ItemAlreadyExists,
        message: 'One or more requested streams have the same names as existing streams ' +
                    'with different ids. The "defaultName" of the streams concerned have been updated ' +
                    'with valid alternative proposals.'
      };
    }
  }

  // Centralises the check for access expiry; yes, this should be part of some
  // business model about accesses. There is one more such check in MethodContext,
  // called `checkAccessValid`.
  //
  function isAccessExpired (access: { expires?: number | null }, nowParam?: number) {
    const now = nowParam || timestamp.now();
    return access.expires != null && now > access.expires;
  }

  function addIntegrityToContext (context: MethodContext, params: AccessesCreateParams, result: AccessesCreateResult, next: MethodNext) {
    if (result?.access?.integrity != null) {
      context.auditIntegrityPayload = {
        key: integrity.accesses.key(result.access),
        integrity: result.access.integrity
      };
      if (process.env.NODE_ENV === 'test' &&
                integrity.accesses.isActive) {
        // double check integrity when running tests only
        if (result.access.integrity !== integrity.accesses.hash(result.access)) {
          return next(new Error('integrity mismatch ' + JSON.stringify(result.access)));
        }
      }
    }
    next();
  }
};
