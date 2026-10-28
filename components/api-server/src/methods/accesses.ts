/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MethodNext, NodeCallback } from './_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';
import type { AccessType, Permission, StreamPermission } from 'business/src/types/public.ts';
import type { DeletionNoticeRow } from 'storages/interfaces/baseStorage/DeletionNoticesLocalDB.ts';
const require = createRequire(import.meta.url);
const { isDeepStrictEqual } = require('node:util');
const slugify = require('utils').slugify;
const timestamp = require('unix-timestamp');
const { fromCallback } = require('utils');

const APIError = require('errors').APIError;
const errors = require('errors').factory;
const ErrorIds = require('errors').ErrorIds;

const { ApiEndpoint } = require('utils');

const commonFns = require('./helpers/commonFunctions.ts');
const methodsSchema = require('../schema/accessesMethods.ts');
const accessSchema = require('../schema/access.ts').default;
const string = require('./helpers/string.ts');
const { peerFetch } = require('business/src/outbound/peerFetch.ts');
// Account/system-stream permission validation, shared with the consent accept.
const { validateAccountStreamPermissions } = require('business/src/accesses/accountStreamPermissions.ts');
const { withoutInjectedPermissions } = require('business/src/accesses/injectedPermissions.ts');

const cache = require('cache').default;

const { getMall, storeDataUtils } = require('mall');
const { pubsub } = require('messages');
const { getStorageLayer } = require('storage');

const { integrity } = require('business');
const { parseAccessRef, serializeAccessRef, composeWireAccess, managingAccessBase, managedAccessesOf, isManagedBy } = require('business/src/accesses/refs.ts');
const { withoutCredentialUrls } = require('business/src/accesses/credentialUrls.ts');
const AccessLogic = require('business/src/accesses/AccessLogic.ts').default;

// Scoped notifications (the structured access-change signal) and the
// deletion of an access with its side effects: helpers/accessDeletion.ts,
// shared with the plugins' teardowns.
const { deleteAccessChain, notifyScopedAccessChange } = require('./helpers/accessDeletion.ts');
const cmc = require('cmc');
const delegation = require('delegation');
const { getLogger, ready } = require('@pryv/boiler');
const { buildMallForCmc } = require('./helpers/cmcMall.ts');
const { buildMemberSweep } = require('./helpers/cmcMemberSweep.ts');
const { setDeletionTeardownStep, trackTeardownDelivery } = require('business/src/auth/deletionTeardown.ts');
const { getDeletionNoticesLocal } = require('business/src/auth/deletionNotices.ts');
const WebhooksRepository = require('business').webhooks.Repository;
const { localFirstFetch } = require('./helpers/localDelivery.ts');
const { contextForAccess, reprepareWebhookScopes, reloadRunningWebhook } = require('./helpers/webhookScopes.ts');
const { getUsersRepository } = require('business/src/users/index.ts');

// Breach-scope reverse-index population — see components/platform/src/accessIndex.ts.
// The index maps a bare accessId -> its owning user + minimal metadata so an
// incident responder can scope a breach from an accessId alone. Both hooks
// are non-fatal (never reject): a PlatformDB failure must not break access CRUD.
const { reindexAccessNonFatal } = require('platform/src/accessIndex.ts');
type IndexAccessInput = { id?: unknown; type?: unknown; expires?: unknown; created?: unknown; modified?: unknown };

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
type MethodContext = BaseMethodContext;
type StoredScopes = import('./helpers/webhookScopes.ts').StoredScopes;

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
type AccessesCheckAppParams = { requestingAppId: string; deviceName?: string; requestedPermissions: StreamPermission[]; clientData?: Record<string, unknown> | null; expireAfter?: number; token?: string };
type AccessesCheckAppResult = { matchingAccess?: AccessLike; mismatchingAccess?: AccessLike; checkedPermissions?: StreamPermission[]; error?: unknown };

export default async function produceAccessesApiMethods (api: { register (...args: unknown[]): unknown }) {
  const dbFindOptions = { projection: { calls: 0, deleted: 0 } };
  const config = await ready();
  const mall = await getMall();
  const storageLayer = await getStorageLayer();
  // Composed CMC mall (with `.accesses`) for the accesses.delete post-hook.
  const mallForCmc = await buildMallForCmc();
  // Group accounts: a deleted or narrowed membership is offboarded, a deleted
  // patient relationship has its member children swept through the grant.
  const cmcMemberSweep = await buildMemberSweep();
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
    if (currentAccess == null) { return next(new Error('AF: Access cannot be null at this point.')); }
    try {
      let accesses: AccessLike[] = await fromCallback((cb: NodeCallback) => accessesRepository.find(context.user, {}, dbFindOptions, cb));
      if (!currentAccess.canListAnyAccess()) {
        // app -> only the accesses it created, including those created under
        // a caller id (`createdBy` is then `<id> <callerId>`)
        accesses = accesses.filter((a: AccessLike) => isManagedBy(a, currentAccess.id));
      }
      if (excludeExpired(params)) {
        accesses = accesses.filter((a: AccessLike) => !isAccessExpired(a));
      }
      // Compose wire-format ids + strip internal serial fields, then
      // attach apiEndpoint.
      result.accesses = accesses.map((a: AccessLike) => {
        const wire = composeWireAccess(a);
        wire.apiEndpoint = ApiEndpoint.buildForAccess(wire, context.user.username);
        return mayShowCredentials(context, a) ? wire : withoutCredentials(wire);
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
    if (!params.includeDeletions) {
      return next();
    }
    const currentAccess = context.access;
    const accessesRepository = storageLayer.accesses;
    try {
      let deletions: AccessLike[] = await fromCallback((cb: NodeCallback) => accessesRepository.findDeletionRecords(context.user, {}, { projection: { calls: 0 } }, cb));
      if (!currentAccess.canListAnyAccess()) {
        // app -> only the accesses it created (caller-id forms included)
        deletions = (deletions || []).filter((d: AccessLike) => isManagedBy(d, currentAccess.id));
      }
      // A deleted access's token no longer opens anything: never returned.
      result.accessDeletions = (deletions || []).map((d: AccessLike) => withoutCredentials(composeWireAccess(d)));
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
        ? managingAccessBase(head.createdBy)
        : null;
      const isOwn = head.id === context.access.id;
      const isManaged = createdByBase === context.access.id;
      if (!isOwn && !isManaged) {
        return next(errors.unknownResource('access', params.id));
      }
    }
    const showCredentials = mayShowCredentials(context, head);
    const currentSerial = head.serial == null ? null : head.serial;
    const wantsSpecific = ref.serial != null;
    const specificMatchesHead = wantsSpecific && currentSerial != null && ref.serial === currentSerial;
    if (!wantsSpecific || specificMatchesHead) {
      // Current head — return as-is.
      const wire = composeWireAccess(head);
      wire.apiEndpoint = ApiEndpoint.buildForAccess(wire, context.user.username);
      result.access = showCredentials ? wire : withoutCredentials(wire);
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
      result.access = showCredentials ? wire : withoutCredentials(wire);
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
          return showCredentials ? wire : withoutCredentials(wire);
        });
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    }
    next();
  }

  // CREATION

  const cmcAccessCreateForgePreventionHook = cmc.createAccessCreateForgePreventionHook({ errors });
  const cmcAccessUpdateForgePreventionHook = cmc.createAccessUpdateForgePreventionHook({ errors });
  // After the target is loaded: an access carrying `clientData.cmc` keeps it.
  const cmcAccessUpdateStampGuardHook = cmc.createAccessUpdateStampGuardHook({ errors });
  const cmcAccessProvisionAppScopeHook = cmc.createAccessProvisionAppScopeHook({
    mall,
    logger: getLogger('cmc:access-provision-app-scope'),
  });

  // Account-delegation guard hooks. Gated on `delegation:active` (default
  // true). When inactive each slot is a passthrough so the register chains
  // below stay structurally identical.
  const delegationActive = config.get('delegation:active') !== false;
  const delegationPassthrough = (context: MethodContext, params: unknown, result: unknown, next: MethodNext) => next();
  const delegationAccessCreateForgePreventionHook = delegationActive
    ? delegation.createAccessCreateForgePreventionHook({ errors })
    : delegationPassthrough;
  const delegationAccessUpdateForgePreventionHook = delegationActive
    ? delegation.createAccessUpdateForgePreventionHook({ errors })
    : delegationPassthrough;
  const delegationAccessesUpdateGuardHook = delegationActive
    ? delegation.createAccessesUpdateGuardHook({ errors })
    : delegationPassthrough;
  const delegationAccessesDeleteGuardHook = delegationActive
    ? delegation.createAccessesDeleteGuardHook({ errors })
    : delegationPassthrough;
  const delegationAccessCreateLineageHook = delegationActive
    ? delegation.createAccessCreateLineageHook()
    : delegationPassthrough;
  const delegationAccessesUpdateMarkerPreserveHook = delegationActive
    ? delegation.createAccessesUpdateMarkerPreserveHook()
    : delegationPassthrough;

  api.register(
    'accesses.create',
    commonFns.basicAccessAuthorizationCheck,
    applyDefaultsForCreation,
    commonFns.getParamsValidation(methodsSchema.create.params),
    canonicalizePermissionStreamIds,
    cmcAccessCreateForgePreventionHook,
    delegationAccessCreateForgePreventionHook,
    delegationAccessCreateLineageHook,
    dpopBindingCreateGuard,
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

  /**
   * Rewrites every permission `streamId` to its canonical spelling before any
   * check reads it. The permission walk and the plugin guards below compare
   * ids, and the stored value is the canonical one: a check that judged
   * `:local::system:email` as a local stream (reached by a `*` grant on the
   * local store) while the account field `:system:email` got stored would let
   * a creator hand out a permission it does not hold. One rewrite, first in
   * the chain, so every check and the write see the same id.
   */
  function canonicalizeStreamPermissions (permissions: unknown) {
    if (!Array.isArray(permissions)) return;
    for (const permission of permissions as StreamPermission[]) {
      if (typeof permission?.streamId === 'string') {
        permission.streamId = storeDataUtils.canonicalStreamId(permission.streamId);
      }
    }
  }

  /**
   * An access holds one level per stream: the permission map is keyed by
   * stream id, so a second entry for the same stream (in any spelling) would
   * silently replace the first, the kept level depending on the order. Refused
   * instead, once the ids are canonical.
   */
  function duplicateStreamPermissionError (permissions: unknown) {
    if (!Array.isArray(permissions)) return null;
    const seen = new Set<string>();
    for (const permission of permissions as StreamPermission[]) {
      if (typeof permission?.streamId !== 'string') continue;
      if (seen.has(permission.streamId)) {
        return errors.invalidRequestStructure(`Stream "${permission.streamId}" appears in more than one permission; give each stream a single level.`, { streamId: permission.streamId });
      }
      seen.add(permission.streamId);
    }
    return null;
  }

  function canonicalizePermissionStreamIds (context: MethodContext, params: AccessesCreateParams, result: AccessesCreateResult, next: MethodNext) {
    canonicalizeStreamPermissions(params.permissions);
    next(duplicateStreamPermissionError(params.permissions));
  }

  function canonicalizePermissionStreamIdsForUpdate (context: MethodContext, params: AccessesUpdateParams, result: AccessesUpdateResult, next: MethodNext) {
    canonicalizeStreamPermissions(params.update?.permissions);
    next(duplicateStreamPermissionError(params.update?.permissions));
  }

  /**
   * The DPoP key binding (`clientData.dpop`) is written ONLY by the OAuth
   * token-issuance path (storage-direct, not this method). Rejecting it
   * here keeps the resource-server's sender-constraint check authoritative
   * — a caller cannot mint a self-bound access out of band — and mirrors
   * the update-path anti-downgrade guard.
   */
  function dpopBindingCreateGuard (context: MethodContext, params: AccessesCreateParams, result: AccessesCreateResult, next: MethodNext) {
    const cd = params.clientData as Record<string, unknown> | null | undefined;
    if (cd != null && cd.dpop !== undefined) {
      return next(errors.forbidden('clientData.dpop is reserved for the OAuth token-issuance path and cannot be set through accesses.create.'));
    }
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
    // (Restrictions such as `secretSharing: forbidden`, and the creator's
    // narrower entries below a granted stream, are appended to
    // params.permissions inside canCreateAccess, so they apply to
    // accesses.update as well as create.)
    if (params.token != null) {
      params.token = slugify(params.token);
      if (string.isReservedToken(params.token)) {
        return next(errors.invalidItemId('The specified token is not allowed.'));
      }
    } else {
      const accessesRepository = storageLayer.accesses;
      params.token = accessesRepository.generateToken();
    }
    // An alias is a platform-wide routing name: only the server mints one.
    if (params.alias != null) {
      return next(errors.forbidden('The alias of an access is set by the server; request one with "randomAlias".'));
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
    // constraint. A shared created by an expiring app without `expireAfter`
    // takes the app's expiry: no expiry would outlive it.
    if (access.type === 'app' && params.type === 'shared' && access.expires != null && params.expires == null) {
      params.expires = access.expires;
    }
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
   * If user is creating an access for system streams, apply some validations.
   */
  function applyAccountStreamsValidation (context: MethodContext, params: AccessesCreateParams, result: AccessesCreateResult, next: MethodNext) {
    if (params.permissions == null) { return next(); }
    const err = validateAccountStreamPermissions(params.permissions);
    if (err != null) { return next(err); }
    return next();
  }

  /**
   * The same account/system-stream validation as accesses.create, applied to
   * accesses.update. `update.permissions` replaces the stored array wholesale,
   * so when the key is present the whole submitted set is validated (exact
   * create-parity); when it is absent the stored permissions are untouched and
   * left as-is. Registered before enforceUpdateChainRules so a statically
   * invalid set never reaches the DB-heavy chain rules or the write.
   */
  function applyAccountStreamsValidationForUpdate (context: MethodContext, params: AccessesUpdateParams, result: AccessesUpdateResult, next: MethodNext) {
    if (!Array.isArray(params.update?.permissions)) { return next(); }
    const err = validateAccountStreamPermissions(params.update.permissions);
    if (err != null) { return next(err); }
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
        await ensurePermissionStream(context, permission);
      } catch (e) {
        return next(e);
      }
    }
    return next();
  }

  // Creates (or untrashes) the stream a permission names when the permission
  // carries a `defaultName`; shared by accesses.create and accesses.update.
  // A permission without `defaultName` may name a stream that does not exist
  // yet: it applies once that stream is created.
  async function ensurePermissionStream (context: MethodContext, permission: StreamPermission) {
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
    // create new stream (same id screen as streams.create)
    const [, itemId] = storeDataUtils.parseStoreIdAndStoreItemId(permission.streamId);
    if (string.isReservedId(itemId) || string.isBuiltInPropertyName(itemId)) {
      throw errors.invalidItemId('The specified id "' + permission.streamId + '" is not allowed.');
    }
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
      // Populate the breach-scope reverse-index from the authoritative stored
      // row (base id, no token). Awaited-but-non-fatal (never rejects).
      reindexAccessNonFatal(context.user.username, newAccess as IndexAccessInput).then(() => next());
    });
  }

  // UPDATE

  // Adapter so the post-hook can write a local audit event into the
  // collectors stream when an access is updated externally (the hook
  // only uses mall.events.create).
  const cmcAccessesUpdateHook = cmc.createAccessesUpdatePostHook({
    mall,
    // Lazy fetch resolution — see the delete hook below.
    fetch: peerFetch,
    timeoutMs: 15_000,
    logger: getLogger('cmc:accesses-update-hook'),
    memberSweep: cmcMemberSweep,
  });

  api.register(
    'accesses.update',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.update.params),
    // Only the declared updatable fields may change; anything else (type,
    // token, id, createdBy, alias...) is refused, never silently ignored.
    commonFns.catchForbiddenUpdate(accessSchema('update'), false, getLogger('accesses')),
    canonicalizePermissionStreamIdsForUpdate,
    cmcAccessUpdateForgePreventionHook,
    delegationAccessUpdateForgePreventionHook,
    loadAccessForUpdate,
    cmcAccessUpdateStampGuardHook,
    delegationAccessesUpdateGuardHook,
    delegationAccessesUpdateMarkerPreserveHook,
    dpopBindingUpdateGuard,
    oauthNameUpdateGuard,
    applyAccountStreamsValidationForUpdate,
    enforceUpdateChainRules,
    createDataStructureFromUpdatePermissions,
    cleanupUpdatePermissions,
    snapshotAndApplyUpdate,
    rescopeWebhooksOfUpdatedAccess,
    cmcAccessProvisionAppScopeHook,
    emitUpdateNotifications,
    cmcAccessesUpdatePostHookMiddleware
  );

  // Mirror of `createDataStructureFromPermissions` for the update path: a
  // permission carrying `defaultName` gets its missing stream created, as on
  // create (personal callers only, like create).
  async function createDataStructureFromUpdatePermissions (context: MethodContext, params: AccessesUpdateParams, result: AccessesUpdateResult, next: MethodNext) {
    if (!context.access.isPersonal() || !Array.isArray(params.update?.permissions)) { return next(); }
    for (const permission of params.update.permissions) {
      try {
        await ensurePermissionStream(context, permission);
      } catch (e) {
        return next(e);
      }
    }
    return next();
  }

  // Mirror of `cleanupPermissions` for the update path. UPDATE accepts the
  // same {defaultName, name} extras as CREATE (the defaultName/name symmetry
  // fix) so callers can pipe `checkApp.checkedPermissions` straight in. The
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
    // findOne filters head_id IS NULL + deleted IS NULL, so a soft-deleted
    // access also returns null and is reported as unknownResource, the same
    // as one that never existed. No info leak via differentiated error.
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

  /**
   * A DPoP key binding (`clientData.dpop`) is written only by the token
   * issuance path and must survive every accesses.update — the update
   * merges `clientData` one level deep and a `null` sub-key removes that
   * key, so without this guard any caller able to update the access could
   * send `{ dpop: null }` (or a null clientData) and silently downgrade a
   * sender-constrained token to Bearer. Rule: when
   * the update touches clientData, the binding (present or absent) must
   * come through unchanged. Defense-in-depth: with uniform enforcement
   * a stolen bound token cannot reach this method in the first place.
   * The link of an OAuth session to its consent data-grant
   * (`clientData.oauth.dataGrantId`) is protected too, on a session that has
   * one: removing or changing it would let the session outlive a withdrawn
   * grant. Only that sub-key, and only when the update touches `oauth`:
   * `clientData` is the app's own free-form data otherwise.
   */
  function dpopBindingUpdateGuard (context: MethodContext, params: AccessesUpdateParams, result: AccessesUpdateResult, next: MethodNext) {
    const updatedClientData = params.update?.clientData as Record<string, unknown> | null | undefined;
    if (updatedClientData === undefined) return next(); // clientData untouched
    const currentClientData = (params.targetAccess as { clientData?: Record<string, unknown> })?.clientData;
    const current = currentClientData?.dpop;
    const updated = updatedClientData == null ? undefined : updatedClientData.dpop;
    if (JSON.stringify(current ?? null) !== JSON.stringify(updated ?? null)) {
      return next(errors.forbidden('The clientData.dpop key cannot be created, changed or removed through accesses.update.'));
    }
    const sessionLink = (currentClientData?.oauth as { dataGrantId?: unknown } | undefined)?.dataGrantId;
    const touchesOauth = updatedClientData === null || Object.prototype.hasOwnProperty.call(updatedClientData, 'oauth');
    if (sessionLink != null && touchesOauth) {
      const updatedLink = (updatedClientData?.oauth as { dataGrantId?: unknown } | null | undefined)?.dataGrantId;
      if (updatedLink !== sessionLink) {
        return next(errors.forbidden('The clientData.oauth.dataGrantId link of an OAuth session cannot be changed or removed through accesses.update.'));
      }
    }
    next();
  }

  /**
   * The operator client-revoke check keys off an oauth-session access's
   * `name` (`oauth:<clientId>`). Renaming such an access would strip the
   * prefix and dodge the revoke while keeping the granted permissions, so a
   * rename of an `oauth:*` access is rejected. These accesses are server-
   * managed (minted by the token endpoint); a legitimate caller has no reason
   * to rename one.
   */
  function oauthNameUpdateGuard (context: MethodContext, params: AccessesUpdateParams, result: AccessesUpdateResult, next: MethodNext) {
    const newName = params.update?.name;
    if (newName === undefined) return next(); // name untouched
    const currentName = (params.targetAccess as { name?: unknown })?.name;
    if (typeof currentName === 'string' && currentName.startsWith('oauth:') && newName !== currentName) {
      return next(errors.forbidden('An OAuth-session access (oauth:<clientId>) cannot be renamed.'));
    }
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
        const createdByBase = managingAccessBase(target.createdBy);
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
            // canCreateAccess appends to this array, which is updates.permissions.
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
          // no expiry (`expires: null`) outlives any managing expiry
          if (wantsExpiresChange && managingApp.expires != null &&
              (after.expires == null || after.expires > managingApp.expires)) {
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
          managingAccessBase(a.createdBy) === target.id);
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
          // a child without expiry outlives the new expiry too
          if (wantsExpiresChange && after.expires != null &&
              (child.expires == null || child.expires > after.expires)) {
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
    // Defence in depth: write only the updatable fields, whatever reached here.
    const alterable: string[] = accessSchema('update').alterableProperties ?? [];
    const update: { serial?: number; modifiedBySerial?: number | null; [k: string]: unknown } = {};
    for (const key of Object.keys(updates)) {
      if (alterable.includes(key)) update[key] = (updates as Record<string, unknown>)[key];
    }
    update.serial = newSerial;
    context.updateTrackingProperties(update);
    update.modifiedBySerial = (context.access?.serial == null) ? null : context.access.serial;

    let headWriteAttempted = false;
    let failure: unknown = null;
    try {
      // 1. Snapshot current head into history row (frozen state pre-bump).
      await fromCallback((cb: NodeCallback) => accessesRepository.snapshotHead(context.user, baseId, cb));
      // 2. Apply head update (integrity-aware updateOne handles the hash).
      headWriteAttempted = true;
      await fromCallback((cb: NodeCallback) =>
        accessesRepository.updateOne(context.user, { id: baseId }, update, cb));
      // 3. Re-read the new head.
      const newHead = await fromCallback((cb: NodeCallback) =>
        accessesRepository.findOne(context.user, { id: baseId }, dbFindOptions, cb));
      if (newHead == null) throw new Error('head row missing after update');
      // 4. Compose wire-form access (composite id + createdBy/modifiedBy
      // refs, internal serial fields stripped).
      const wire = composeWireAccess(newHead);
      wire.apiEndpoint = ApiEndpoint.buildForAccess(wire, context.user.username);
      result.__updateNotification = { baseId: baseId!, serial: newSerial, compositeId: wire.id! };
      result.access = mayShowCredentials(context, newHead) ? wire : withoutCredentials(wire);
      // Refresh the breach-scope reverse-index from the authoritative new head
      // (stateless full-row write; keyed by the base id). Non-fatal — never
      // rejects, so it cannot trip the surrounding catch.
      await reindexAccessNonFatal(context.user.username, newHead as IndexAccessInput);
    } catch (err) {
      failure = err;
    }

    // 5. Cache invalidation, unconditional like delete once the head write
    // was attempted, even when a later step failed (the write may have
    // committed): a concurrent request may re-cache the pre-update row during
    // the write (the expiry chain reads a managing access's `expires` from
    // this cache).
    if (headWriteAttempted) cache.unsetAccessLogic(context.user.id, { id: baseId!, token: target.token });
    if (failure != null) return next(errors.unexpectedError(failure));
    next();
  }

  /**
   * The scopes of the updated access's webhooks were resolved against its
   * permissions when they were set: resolve them again against the updated
   * access. A scope now out of reach is dropped; a webhook left with none is
   * deactivated (never turned into an unscoped one). Non-fatal: the access
   * update stands (an unusable access deactivates its webhooks at fire time).
   */
  async function rescopeWebhooksOfUpdatedAccess (context: MethodContext, params: AccessesUpdateParams, result: AccessesUpdateResult, next: MethodNext) {
    const baseId = params.targetBase!;
    try {
      const hooks = (await webhooksRepository.get(context.user, { id: baseId, isPersonal: () => false }))
        .filter((w: { scopes?: StoredScopes | null }) => w.scopes != null && Object.keys(w.scopes).length > 0);
      if (hooks.length === 0) return next();
      let accessContext: MethodContext | null = null;
      try {
        accessContext = await contextForAccess(context.source, context.user.username, params.targetAccess!.token!, storageLayer);
      } catch (err) {
        // The access cannot be used any more: no scope is kept. Any other
        // failure leaves the webhooks as they are (logged below).
        if (!(err instanceof APIError)) throw err;
        accessContext = null;
      }
      for (const hook of hooks) {
        const scopes = accessContext == null ? {} : await reprepareWebhookScopes(accessContext, hook.scopes);
        const update: Record<string, unknown> = { scopes };
        if (Object.keys(scopes).length === 0) update.state = 'inactive';
        hook.scopes = scopes;
        await hook.update(update);
        reloadRunningWebhook(context.user.username, hook.forApi());
      }
    } catch (err) {
      getLogger('accesses').warn(`webhooks of access ${baseId} not re-scoped after its update: ${(err as Error).message}`);
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
  // A peer account hosted on this core is reached in-process (localFirstFetch),
  // not through the core's own public URL; any other peer through the guarded
  // peerFetch (refused private destinations; tests route it to their shim).
  const cmcDeliveryFetch = localFirstFetch(api, storageLayer, peerFetch);
  const cmcAccessesDeleteHook = cmc.createAccessesDeletePostHook({
    // The composed CMC mall (with `.accesses` and `.events`) lets the hook mark
    // the invite a deleted relationship descends from as revoked (local
    // bookkeeping) alongside the peer notify.
    mall: mallForCmc,
    fetch: cmcDeliveryFetch,
    timeoutMs: 15_000,
    logger: getLogger('cmc:accesses-delete-hook'),
    memberSweep: cmcMemberSweep,
    sweepReason: 'accesses.delete',
    enqueueRetries: config.get('cmc:retryLoop:enabled') === true,
  });

  // Account deletion: the account's CMC relationship accesses are erased with
  // it, without passing through accesses.delete, so the hook above would never
  // tell the counterparties. The same revocation is sent for each of them
  // (the peer then deletes the access it holds for this account: the data
  // grant given to it, or its back-channel to it). Built WITHOUT the mall: the
  // local bookkeeping writes the account's own events, which are being erased,
  // and so is the account's retry queue: a notice the peer cannot take during
  // the in-request attempts goes to the core's deletion outbox instead, which
  // outlives the account (drained by the retry loop). Awaited within a bound
  // by the teardown (trackTeardownDelivery): a slow peer holds the deletion a
  // few seconds at most.
  const cmcAccountDeletionNotice = cmc.createAccessesDeletePostHook({
    fetch: cmcDeliveryFetch,
    timeoutMs: 15_000,
    logger: getLogger('cmc:account-deletion'),
    enqueueRetries: config.get('cmc:retryLoop:enabled') === true,
    deletionOutbox: { insert: async (row: DeletionNoticeRow) => (await getDeletionNoticesLocal()).insert(row) },
  });
  setDeletionTeardownStep('cmc', async function revokeCmcRelationshipsOfDeletedAccount (account: { id: string }) {
    const all = (await mallForCmc.accesses.get(account.id, {})) as AccessLike[];
    // Counterparty grants and the memberships of a group account alike.
    const relationships = (all || []).filter((a) => a?.deleted == null &&
      cmc.RELATIONSHIP_ROLES.includes((a?.clientData as { cmc?: { role?: unknown } } | null | undefined)?.cmc?.role));
    if (relationships.length === 0) return;
    // A group account: what its memberships minted on patient cores is
    // deleted through the grants NOW, before anything is erased (one ledger
    // read, nothing written to the account, a short timeout per call), so
    // the children die even against a patient core that does not cascade.
    try {
      await cmcMemberSweep.sweepErasedAccount(account.id, relationships);
    } catch (err: unknown) {
      getLogger('cmc:account-deletion').warn('cmc: the member sweep of a deleted account failed (its children expire on their own)', {
        error: String((err as Error)?.message ?? err),
      });
    }
    trackTeardownDelivery(Promise.resolve()
      .then(() => cmcAccountDeletionNotice(account.id, relationships))
      .catch((err: unknown) => {
        getLogger('cmc:account-deletion').warn('cmc: revocation notices of a deleted account failed', {
          error: String((err as Error)?.message ?? err),
        });
      }));
  });

  api.register(
    'accesses.delete',
    commonFns.getParamsValidation(methodsSchema.del.params),
    checkAccessForDeletion,
    findRelatedAccesses,
    delegationAccessesDeleteGuardHook,
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
      // The hook may change the user's events (the invite stamped revoked,
      // the withdrawal on the accept event) after this call answered: tell
      // the user's socket clients, as the CMC dispatch does for its stamps.
      const username = context.user.username;
      const notifyEventChanged = () => {
        if (username != null) pubsub.notifications.emit(username, pubsub.USERNAME_BASED_EVENTS_CHANGED);
      };
      Promise.resolve()
        .then(() => cmcAccessesDeleteHook(context.user.id, deleted, notifyEventChanged))
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
    // Matched on the access id inside `createdBy`, not on the whole value: an
    // access created under a caller id is recorded as `<id> <callerId>`.
    let accesses: AccessLike[] = [];
    try {
      accesses = await fromCallback((cb: NodeCallback) => {
        accessesRepository.find(context.user, {}, dbFindOptions, cb);
      });
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    accesses = managedAccessesOf(accesses, params.id, timestamp.now());
    if (accesses.length === 0) { return next(); }
    result.relatedDeletions = accesses.map((a) => ({ id: a.id! }));
    params.relatedAccessesToDelete = accesses;
    next();
  }

  /**
   * The deletion itself: helpers/accessDeletion.ts, shared with the plugins'
   * teardowns (every CMC and delegation delete goes through it, so a consent
   * withdrawn through any path leaves the same deletion record, webhook
   * cascade, alias release and breach-scope tombstone as this route).
   */
  async function deleteAccesses (context: MethodContext, params: AccessesDeleteParams, result: AccessesDeleteResult, next: MethodNext) {
    let outcome;
    try {
      outcome = await deleteAccessChain(context.user, {
        id: params.id,
        accessToDelete: params.accessToDelete ?? null,
        relatedAccessesToDelete: params.relatedAccessesToDelete ?? [],
      });
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    if (outcome.relatedDeletions.length > 0) result.relatedDeletions = outcome.relatedDeletions;
    params.relatedAccessesToDelete = outcome.relatedAccessesToDelete as AccessLike[];
    result.accessDeletion = { id: params.id };
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
      // Do we have a match? (A delegate only matches app accesses it created:
      // otherwise the flow creates its own, removed with the delegation.)
      const usable = access != null && mayShowCredentials(context, access);
      if (usable && accessMatches(access, params.requestedPermissions, params.clientData)) {
        result.matchingAccess = composeWireAccess(access);
        return next();
      }
      // No, we don't have a match. Return other information:
      if (access != null) {
        const wire = composeWireAccess(access);
        result.mismatchingAccess = usable ? wire : withoutCredentials(wire);
      }
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

  // A delegated personal access (account delegation) sees the credentials of
  // itself and of the accesses it created only: the owner's own tokens (login
  // sessions, apps, shares) are not handed to a delegate, and would outlive it.
  function mayShowCredentials (context: MethodContext, access: { id?: unknown; createdBy?: unknown }): boolean {
    const caller = context.access;
    if (caller == null || caller.type !== 'personal' || delegation.isGenuineLoginAccess(caller)) return true;
    if (access.id === caller.id) return true;
    return typeof access.createdBy === 'string' && managingAccessBase(access.createdBy) === caller.id;
  }

  function withoutCredentials<T extends { token?: unknown; apiEndpoint?: unknown; clientData?: unknown }> (wire: T): T {
    delete wire.token;
    delete wire.apiEndpoint;
    // A consent (CMC) relationship access keeps the counterparty's endpoints
    // in `clientData.cmc` (`counterparty.apiEndpoint`,
    // `backChannelApiEndpoint`), tokens included: those are credentials to
    // the peer's data and go with the access's own. Every URL user part
    // inside clientData is removed (a copy: the row may be cached); host and
    // path still say which endpoint is meant.
    if (wire.clientData != null) wire.clientData = withoutCredentialUrls(wire.clientData);
    return wire;
  }

  // Returns true if the given access' permissions match the `requestedPermissions`.
  //
  function accessMatches (access: AccessLike, requestedPermissions: StreamPermission[], clientData?: Record<string, unknown> | null) {
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
    // every sign-in). Shared with the auth-request consent check, which
    // needs the same subtraction for the same reason.
    const accessPerms = withoutInjectedPermissions(access.permissions, access.id) as StreamPermission[];
    const requestedPerms = withoutInjectedPermissions(requestedPermissions, access.id) as StreamPermission[];
    if (accessPerms.length !== requestedPerms.length) {
      return false;
    }
    // If the access is there but is expired, we consider it a mismatch.
    if (isAccessExpired(access)) { return false; }
    // Compare permissions: stream entries by stream id and level, feature
    // entries (no stream id) by feature and setting.
    for (const accessPerm of accessPerms) {
      if (!requestedPerms.some((reqPerm) => samePermission(accessPerm, reqPerm))) {
        return false;
      }
    }
    // Compare clientData (treat null and undefined as equivalent). The
    // lineage marker the server stamps on an access granted through a
    // delegation is not the app's data: leave it out, so such an access
    // matches exactly as the same grant made by the account owner would.
    let accessClientData = (access.clientData ?? null) as Record<string, unknown> | null;
    const marker = accessClientData?.delegation as { kind?: unknown } | undefined;
    if (marker?.kind === 'delegated-child') {
      const { delegation: _marker, ...appData } = accessClientData!;
      accessClientData = Object.keys(appData).length > 0 ? appData : null;
    }
    if (!isDeepStrictEqual(accessClientData, clientData ?? null)) {
      return false;
    }
    return true;
    function samePermission (a: Permission, b: Permission): boolean {
      if ('feature' in a || 'feature' in b) {
        return 'feature' in a && 'feature' in b && a.feature === b.feature && a.setting === b.setting;
      }
      return a.streamId === b.streamId && a.level === b.level;
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
      // a feature entry names no stream: nothing to resolve
      if ('feature' in permission) return done();
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
      (async () => {
        try {
          // checkId
          const existingStream = await mall.streams.getOneWithNoChildren(context.user.id, permission.streamId);
          if (existingStream != null) {
            permission.name = existingStream.name;
            delete permission.defaultName;
          }
          // checkSimilar
          if (existingStream == null) {
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
}
