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

type Permission = {
  streamId: string;
  level: 'manage' | 'contribute' | 'read' | 'create-only' | 'none';
};
type Access = {
  type: 'personal' | 'app' | 'shared';
  permissions: Array<Permission>;
  expires: number | undefined | null;
  clientData: {} | undefined | null;
};
type UpdatesSettingsHolder = {
  ignoreProtectedFields: boolean;
};
export default async function produceAccessesApiMethods (api: any) {
  const dbFindOptions = { projection: { calls: 0, deleted: 0 } };
  const mall = await getMall();
  const storageLayer = await getStorageLayer();

  // RETRIEVAL

  api.register(
    'accesses.get',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.get.params),
    findAccessibleAccesses,
    includeDeletionsIfRequested
  );

  async function findAccessibleAccesses (context: any, params: any, result: any, next: any) {
    const currentAccess = context.access;
    const accessesRepository = storageLayer.accesses;
    const query: any = {};
    if (currentAccess == null) { return next(new Error('AF: Access cannot be null at this point.')); }
    if (!currentAccess.canListAnyAccess()) {
      // app -> only access it created
      query.createdBy = currentAccess.id;
    }
    try {
      let accesses: any = await fromCallback((cb: any) => accessesRepository.find(context.user, query, dbFindOptions, cb));
      if (excludeExpired(params)) {
        accesses = accesses.filter((a: any) => !isAccessExpired(a));
      }
      // Plan 66: compose wire-format ids + strip internal serial fields,
      // then attach apiEndpoint.
      result.accesses = accesses.map((a: any) => {
        const wire = composeWireAccess(a);
        wire.apiEndpoint = ApiEndpoint.build(context.user.username, wire.token);
        return wire;
      });
      next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    function excludeExpired (params: any) {
      return !params.includeExpired;
    }
  }

  async function includeDeletionsIfRequested (context: any, params: any, result: any, next: any) {
    if (params.includeDeletions == null) {
      return next();
    }
    const currentAccess = context.access;
    const accessesRepository = storageLayer.accesses;
    const query: any = {};
    if (!currentAccess.canListAnyAccess()) {
      // app -> only access it created
      query.createdBy = currentAccess.id;
    }
    try {
      const deletions = await fromCallback((cb: any) => accessesRepository.findDeletions(context.user, query, { projection: { calls: 0 } }, cb));
      result.accessDeletions = (deletions || []).map((d: any) => composeWireAccess(d));
      next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
  }

  // GET ONE (Plan 66)

  api.register(
    'accesses.getOne',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.getOne.params),
    findOneAccess
  );

  async function findOneAccess (context: any, params: any, result: any, next: any) {
    let ref;
    try {
      ref = parseAccessRef(params.id);
    } catch (e: any) {
      return next(errors.unknownResource('access', params.id));
    }
    const accessesRepository = storageLayer.accesses;
    let head: any;
    try {
      head = await fromCallback((cb: any) =>
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
      wire.apiEndpoint = ApiEndpoint.build(context.user.username, wire.token);
      result.access = wire;
    } else if (currentSerial != null && ref.serial < currentSerial) {
      // Obsolete composite — historical row, with a `current` hint pointing
      // at the live head's composite id (Q-pivot=a, GitHub-commit-by-sha-style).
      let history: any[] = [];
      try {
        history = await accessesRepository.findHistory(context.user, ref.base);
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
      const snapshot = (history || []).find((h: any) => (h.serial ?? null) === ref.serial);
      if (snapshot == null) return next(errors.unknownResource('access', params.id));
      const wire = composeWireAccess(snapshot, ref.base);
      wire.apiEndpoint = ApiEndpoint.build(context.user.username, wire.token);
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
        result.history = (history || []).map((h: any) => {
          const wire = composeWireAccess(h, ref.base);
          wire.apiEndpoint = ApiEndpoint.build(context.user.username, wire.token);
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

  api.register(
    'accesses.create',
    commonFns.basicAccessAuthorizationCheck,
    applyDefaultsForCreation,
    commonFns.getParamsValidation(methodsSchema.create.params),
    applyPrerequisitesForCreation, applyAccountStreamsValidation,
    createDataStructureFromPermissions,
    cleanupPermissions,
    createAccess,
    addIntegrityToContext
  );

  function applyDefaultsForCreation (context: any, params: any, result: any, next: any) {
    params.type ??= 'shared';
    next();
  }

  async function applyPrerequisitesForCreation (context: any, params: any, result: any, next: any) {
    if (params.type === 'personal') {
      return next(errors.forbidden('Personal accesses are created automatically on login.'));
    }
    const permissions = params.permissions;
    for (const permission of permissions) {
      if (permission.streamId != null) {
        try {
          commonFns.isValidStreamIdForQuery(permission.streamId, permission, 'permissions');
        } catch (err: any) {
          return next(errors.invalidRequestStructure(err.message, params.permissions));
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
    const expireAfter = params.expireAfter;
    delete params.expireAfter;
    if (expireAfter != null) {
      if (expireAfter >= 0) { params.expires = timestamp.now() + expireAfter; } else { return next(errors.invalidParametersFormat('expireAfter cannot be negative.')); }
    }
    // Plan 66 Rule D: a managed shared access cannot outlive its managing
    // app's expiry. Retrofitted on create for consistency with the update
    // path (BREAKING — see CHANGELOG-v2.md). Parent with `expires: null`
    // imposes no constraint.
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
  function applyAccountStreamsValidation (context: any, params: any, result: any, next: any) {
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

    function isStreamBasedPermission (permission: any) {
      return permission.streamId != null;
    }

    function isUnknownSystemStream (streamId: any) {
      return ((streamId.startsWith(':_system:') || streamId.startsWith(':system:')) &&
                accountStreams.toFieldName(streamId) === streamId);
    }
    return next();
  }

  // Creates default data structure from permissions if needed, for app
  // authorization.
  //
  async function createDataStructureFromPermissions (context: any, params: any, result: any, next: any) {
    const access = context.access;
    if (!access.isPersonal()) { return next(); } // not needed for personal access
    for (const permission of params.permissions) {
      try {
        await ensureStream(permission);
      } catch (e) {
        return next(e);
      }
    }
    return next();
    async function ensureStream (permission: any) {
      // We ensure stream Exists only if streamid is !== '*' and if a defaultName is providedd
      if (permission.streamId == null ||
                permission.streamId === '*' ||
                permission.defaultName == null) { return; }
      const existingStream = await context.streamForStreamId(permission.streamId);
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
      const newStream: any = {
        id: permission.streamId,
        name: permission.defaultName,
        parentId: null
      };

      // check validity of Id if stream is local store
      const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(permission.streamId);
      if (storeId === 'local') {
        if (!commonFns.isValidStreamIdForCreation(permission.streamId)) {
          throw errors.invalidRequestStructure(`Error while creating stream for access. Invalid 'permission' parameter, forbidden chartacter(s) in streamId '${permission.streamId}'. StreamId should be of length 1 to 100 chars, with lowercase letters, numbers or dashes.`, permission);
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
  function cleanupPermissions (context: any, params: any, result: any, next: any) {
    if (!params.permissions) {
      return next();
    }
    params.permissions.forEach(function (perm: any) {
      delete perm.defaultName;
      delete perm.name;
    });
    next();
  }

  function createAccess (context: any, params: any, result: any, next: any) {
    const accessesRepository = storageLayer.accesses;
    if (params.type === 'shared') params.deviceName = null;
    accessesRepository.insertOne(context.user, params, function (err: any, newAccess: any) {
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
      wire.apiEndpoint = ApiEndpoint.build(context.user.username, wire.token);
      result.access = wire;
      pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
      next();
    });
  }

  // UPDATE

  api.register(
    'accesses.update',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.update.params),
    loadAccessForUpdate,
    enforceUpdateChainRules,
    snapshotAndApplyUpdate,
    emitUpdateNotifications
  );

  async function loadAccessForUpdate (context: any, params: any, result: any, next: any) {
    // Plan 66: composite-id parse + conflict-check. The wire-form `id` is
    // either bare cuid (never-updated access) or `<base>:<serial>`. Look
    // up by base; reject stale composites with 409.
    let ref;
    try {
      ref = parseAccessRef(params.id);
    } catch (e: any) {
      return next(errors.unknownResource('access', params.id));
    }
    let access: any;
    try {
      access = await fromCallback((cb: any) => {
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
    params.targetAccess = access;
    params.targetBase = ref.base;
    next();
  }

  async function enforceUpdateChainRules (context: any, params: any, result: any, next: any) {
    const target = params.targetAccess;
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

    const after: any = Object.assign({}, target, updates);

    try {
      if (target.type === 'shared') {
        // Rules A + D — child cannot exceed managing app's scope/expiry.
        let managingApp: any = null;
        const createdByBase = parseAccessRef(target.createdBy).base;
        if (createdByBase === context.access.id) {
          managingApp = context.access;
        } else {
          const mgrRow = await fromCallback((cb: any) =>
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
        const allAccesses = await fromCallback((cb: any) =>
          storageLayer.accesses.find(context.user, {}, null, cb));
        const managed = (allAccesses || []).filter((a: any) =>
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

  async function snapshotAndApplyUpdate (context: any, params: any, result: any, next: any) {
    const target = params.targetAccess;
    const baseId = params.targetBase;
    const updates = params.update;
    const accessesRepository = storageLayer.accesses;
    const newSerial = ((target.serial == null) ? 0 : target.serial) + 1;
    const update: any = Object.assign({}, updates);
    update.serial = newSerial;
    context.updateTrackingProperties(update);
    update.modifiedBySerial = (context.access?.serial == null) ? null : context.access.serial;

    try {
      // 1. Snapshot current head into history row (frozen state pre-bump).
      await accessesRepository.snapshotHead(context.user, baseId);
      // 2. Apply head update (integrity-aware updateOne handles the hash).
      await fromCallback((cb: any) =>
        accessesRepository.updateOne(context.user, { id: baseId }, update, cb));
      // 3. Re-read the new head.
      const newHead = await fromCallback((cb: any) =>
        accessesRepository.findOne(context.user, { id: baseId }, dbFindOptions, cb));
      if (newHead == null) {
        return next(errors.unexpectedError(new Error('head row missing after update')));
      }
      // 4. Compose wire-form access (composite id + createdBy/modifiedBy
      // refs, internal serial fields stripped).
      const wire = composeWireAccess(newHead);
      wire.apiEndpoint = ApiEndpoint.build(context.user.username, wire.token);
      result.access = wire;
      result.__plan66 = { baseId, serial: newSerial, compositeId: wire.id };
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

  function emitUpdateNotifications (context: any, params: any, result: any, next: any) {
    pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
    pubsub.notifications.emit(context.user.username, pubsub.ACCESS_UPDATED, {
      accessId: result.__plan66.compositeId,
      serial: result.__plan66.serial
    });
    delete result.__plan66;
    next();
  }

  // DELETION

  api.register(
    'accesses.delete',
    commonFns.getParamsValidation(methodsSchema.del.params),
    checkAccessForDeletion,
    findRelatedAccesses,
    deleteAccesses
  );

  async function checkAccessForDeletion (context: any, params: any, result: any, next: any) {
    const accessesRepository = storageLayer.accesses;
    const currentAccess = context.access;
    if (currentAccess == null) { return next(new Error('AF: currentAccess cannot be null.')); }
    // Plan 66: parse composite id + serial conflict-check (mirrors update).
    let ref;
    try {
      ref = parseAccessRef(params.id);
    } catch (e: any) {
      return next(errors.unknownResource('access', params.id));
    }
    let access: any;
    try {
      access = await fromCallback((cb: any) => {
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
    params.accessToDelete = access;
    next();
  }

  async function findRelatedAccesses (context: any, params: any, result: any, next: any) {
    const accessToDelete = params.accessToDelete;
    const accessesRepository = storageLayer.accesses;
    // Deleting a personal access does NOT delete the app/shared accesses it
    // created — the user keeps the apps they granted while logged in. Only
    // app/shared deletes cascade to descendants.
    if (accessToDelete.type === 'personal') {
      return next();
    }
    let accesses: any;
    try {
      accesses = await fromCallback((cb: any) => {
        accessesRepository.find(context.user, { createdBy: params.id }, dbFindOptions, cb);
      });
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    if (accesses.length === 0) { return next(); }
    accesses = accesses.filter((a: any) => a.id !== params.id);
    accesses = accesses.filter((a: any) => !isAccessExpired(a));
    accesses = accesses.map((a: any) => {
      return { id: a.id };
    });
    result.relatedDeletions = accesses;
    next();
  }

  async function deleteAccesses (context: any, params: any, result: any, next: any) {
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
    try {
      await fromCallback((cb: any) => {
        accessesRepository.delete(context.user, { $or: idsToDelete }, cb);
      });
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    result.accessDeletion = { id: params.id };
    pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
    next();
  }

  // OTHER METHODS

  api.register(
    'accesses.checkApp',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.checkApp.params),
    checkApp
  );

  function checkApp (context: any, params: any, result: any, next: any) {
    const accessesRepository = storageLayer.accesses;
    const query = {
      type: 'app',
      name: params.requestingAppId,
      deviceName: params.deviceName || null
    };
    accessesRepository.findOne(context.user, query, dbFindOptions, function (err: any, access: any) {
      if (err != null) { return next(errors.unexpectedError(err)); }
      // Do we have a match?
      if (accessMatches(access, params.requestedPermissions, params.clientData)) {
        result.matchingAccess = composeWireAccess(access);
        return next();
      }
      // No, we don't have a match. Return other information:
      if (access != null) { result.mismatchingAccess = composeWireAccess(access); }
      checkPermissions(context, params.requestedPermissions, function (err: any, checkedPermissions: any, checkError: any) {
        if (err != null) { return next(err); }
        result.checkedPermissions = checkedPermissions;
        if (checkError != null) {
          result.error = checkError;
        }
        next();
      });
    });
  }

  // Returns true if the given access' permissions match the `requestedPermissions`.
  //
  function accessMatches (access: any, requestedPermissions: any, clientData: any) {
    if (access == null ||
            access.type !== 'app' ||
            access.permissions.length !== requestedPermissions.length) {
      return false;
    }
    // If the access is there but is expired, we consider it a mismatch.
    if (isAccessExpired(access)) { return false; }
    // Compare permissions
    let accessPerm, reqPerm;
    for (let i = 0, ni = access.permissions.length; i < ni; i++) {
      accessPerm = access.permissions[i];
      reqPerm = findByStreamId(requestedPermissions, accessPerm.streamId);
      if (!reqPerm || reqPerm.level !== accessPerm.level) {
        return false;
      }
    }
    // Compare clientData (treat null and undefined as equivalent)
    if (!isDeepStrictEqual(access.clientData ?? null, clientData ?? null)) {
      return false;
    }
    return true;
    function findByStreamId (permissions: any, streamId: any) {
      return permissions.find((perm: any) => perm.streamId === streamId);
    }
  }

  // Iterates over the given permissions, replacing `defaultName` properties
  // with the actual `name` of existing streams. When defined, the callback's
  // `checkError` param signals issues with the requested permissions.
  //
  function checkPermissions (context: any, permissions: any, callback: any) {
    // modify permissions in-place, assume no side fx
    const checkedPermissions = permissions;
    let checkError: any = null;
    let i = 0;
    function nextPermission (err?: any) {
      if (err != null) {
        return err instanceof APIError
          ? callback(err)
          : callback(errors.unexpectedError(err));
      }
      if (i >= checkedPermissions.length) return callback(null, checkedPermissions, checkError);
      checkPermission(checkedPermissions[i++], nextPermission);
    }
    nextPermission();

    function checkPermission (permission: any, done: any) {
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
      let permissionStream: any;
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
            const rootStreamsNames = rootStreams.map((stream: any) => stream.name);
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
  function isAccessExpired (access: any, nowParam?: any) {
    const now = nowParam || timestamp.now();
    return access.expires != null && now > access.expires;
  }

  function addIntegrityToContext (context: any, params: any, result: any, next: any) {
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
