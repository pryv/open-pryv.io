/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { PermissionLevel, AccessType, Permission, StreamPermission, FeaturePermission } from '../types/public.ts';
const require = createRequire(import.meta.url);
/**
 * Business logic for access objects.
 */

const { deepMerge } = require('utils');
const accountStreams = require('business/src/system-streams/index.ts');
const { parseAccessRef } = require('./refs.ts');

const { getConfigSync } = require('@pryv/boiler');
const { storeDataUtils, getMall } = require('mall');

type StorePermissionEntry = { streamId: string; level: string | null };

let auditIsActive: boolean | null = null;
function addAuditStreams () {
  if (auditIsActive !== null) return auditIsActive;
  auditIsActive = getConfigSync().get('audit:active');
  return auditIsActive;
}

// Permission levels ordered by ascending level (for permission
// assessment) — from the permission-lexicon single point.
const { PermissionLevels } = require('./permissionSet.ts');

/**
 * Reserved namespace holding one-time shared secrets, one substream per creating
 * access. Matched here as a literal rather than imported so the access layer
 * keeps no dependency on the plugin that owns it.
 */
const SHARED_SECRETS_NS = ':_shared-secrets:';

/** The access owning a shared-secrets substream, or null for any other stream. */
function sharedSecretsOwnerOf (streamId: unknown): string | null {
  if (typeof streamId !== 'string' || !streamId.startsWith(SHARED_SECRETS_NS)) return null;
  const rest = streamId.slice(SHARED_SECRETS_NS.length);
  if (rest.length === 0 || rest.includes(':')) return null;
  return rest;
}

class AccessLogic {
  _access: Record<string, unknown>; // Access right from the DB — wider than public Access shape (internal fields)
  _userId: string;
  _streamPermissionLevelCache: Record<string, StorePermissionEntry | null | undefined>;
  _streamByStorePermissionsMap!: Record<string, Record<string, StorePermissionEntry>>; // initialized in loadPermissions()
  // In-store stream ids forced into events.get queries, keyed by store id.
  _streamByStoreForced!: Record<string, string[]>; // initialized in loadPermissions()
  featurePermissionsMap!: Record<string, FeaturePermission>;
  // mirrored from `access` via deepMerge() in constructor — definite-assign:
  id!: string;
  type!: AccessType;
  permissions!: Permission[];

  static PERMISSION_LEVEL_CONTRIBUTE: string;
  static PERMISSION_LEVEL_MANAGE: string;
  static PERMISSION_LEVEL_READ: string;
  static PERMISSION_LEVEL_CREATE_ONLY: string;

  constructor (userId: string, access: Record<string, unknown>) {
    this._access = access;
    this._userId = userId;
    this._streamPermissionLevelCache = {};
    deepMerge(this, access);

    if (this.isPersonal()) return;
    if (!this.id) return; // this is an access "in" creation process

    // Work on a copy: deepMerge assigns the source's array by reference, so
    // injecting the system permissions below would otherwise mutate the
    // caller's data. Callers that go on to persist that data (e.g.
    // accesses.update's would-be narrowing check) would then write the
    // injected ':_system:account' / ':_audit:access-<id>' entries into
    // storage.
    this.permissions = this.permissions ? this.permissions.slice() : [];

    // Lock account streams by default — explicit permissions can override.
    // This also makes the 'none' level visible in access-info API responses.
    this.permissions.unshift({ streamId: accountStreams.STREAM_ID_ACCOUNT, level: 'none' });

    // add audit permissions
    if (!addAuditStreams()) return;

    let selfAudit = true;
    for (const permission of this.permissions) {
      if ('feature' in permission && permission.feature === 'selfAudit' && permission.setting === 'forbidden') {
        selfAudit = false;
      }
    }

    // if can selfAudit add :_audit: permission
    if (selfAudit) {
      this.permissions.push({
        streamId: ':_audit:access-' + this.id,
        level: 'read'
      });
    }
  }

  isPersonal () {
    return this.type === 'personal';
  }

  isApp () {
    return this.type === 'app';
  }

  isShared () {
    return this.type === 'shared';
  }

  /** ---------- PERMISSION & STREAMSID LISTS --------------- */

  /**
   * Loads permissions from `this.permissions`.
   */
  async loadPermissions () {
    if (!this.permissions) {
      return;
    }

    this.featurePermissionsMap = {};
    this._streamByStorePermissionsMap = {};
    this._streamByStoreForced = {};

    for (const perm of this.permissions) {
      if ('streamId' in perm && perm.streamId != null) {
        await this._loadStreamPermission(perm);
      } else if ('feature' in perm && perm.feature != null) {
        this._loadFeaturePermission(perm);
      }
    }
  }

  async _loadStreamPermission (perm: StreamPermission) {
    const [storeId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(perm.streamId);
    if (this._streamByStorePermissionsMap[storeId] == null) this._streamByStorePermissionsMap[storeId] = {};
    this._streamByStorePermissionsMap[storeId][storeStreamId] = { streamId: storeStreamId, level: perm.level };

    if (perm.streamId === '*') { // add mall stores to permissions
      const mall = await getMall();
      const mallStoreIds = mall.includedInStarPermissions;
      for (const mallStoreId of mallStoreIds) {
        if (this._streamByStorePermissionsMap[mallStoreId] == null) this._streamByStorePermissionsMap[mallStoreId] = {};
        this._streamByStorePermissionsMap[mallStoreId]['*'] = { streamId: '*', level: perm.level };
      }
    }
  }

  /**
   * returns the permissions for this store if it exists
   */
  getStoresPermissions (storeId: string) {
    const storeStreamPermissionMap = this._streamByStorePermissionsMap[storeId];
    if (storeStreamPermissionMap == null) return [];
    return Object.values(storeStreamPermissionMap);
  }

  /**
   * returns the permission for this stream if it exists
   */
  getStreamPermission (storeId: string, streamId: string) {
    const storeStreamPermissionMap = this._streamByStorePermissionsMap[storeId];
    if (storeStreamPermissionMap == null) return null;
    return storeStreamPermissionMap[streamId];
  }

  /**
   * get a List of readable (root) streams that can be read / listed
   */
  getListableStreamIds () {
    const res: Array<{ streamId: string; storeId: string }> = [];
    if (this._streamByStorePermissionsMap != null) {
      for (const storeId of Object.keys(this._streamByStorePermissionsMap)) {
        const storePermissions = this._streamByStorePermissionsMap[storeId];
        for (const perm of Object.values(storePermissions)) {
          if ((perm.streamId != null) && perm.level != null && isHigherOrEqualLevel(perm.level, 'read')) {
            res.push({ streamId: perm.streamId, storeId });
          }
        }
      }
    }
    return res;
  }

  /**
   * get StreamIds with explicit "no-list" permissions ("none", ...)
   */
  getCannotListStreamsStreamIds (storeId: string) {
    const res: string[] = (storeId === 'local') ? ([] as string[]).concat(accountStreams.hiddenStreamIds) : [];

    if (this._streamByStorePermissionsMap == null) return res;
    const perms = this._streamByStorePermissionsMap[storeId];
    if (perms == null) return res;

    for (const perm of Object.values(perms)) {
      if (perm.level == null || perm.level === 'none') {
        res.push(storeDataUtils.parseStoreIdAndStoreItemId(perm.streamId)[1]);
      }
    }
    return res;
  }

  /**
   * get StreamIds with explicit "no-read" permissions
   * Note!! "create-only", is not forbidden if a "read" permission has been given to a parent
   */
  getForbiddenGetEventsStreamIds (storeId: string) {
    if (this._streamByStorePermissionsMap == null) return [];
    const localPerms = this._streamByStorePermissionsMap[storeId];
    if (localPerms == null) return [];
    const res: string[] = [];

    for (const perm of Object.values(localPerms)) {
      if (perm.level === 'create-only' || perm.level == null || perm.level === 'none') {
        res.push(storeDataUtils.parseStoreIdAndStoreItemId(perm.streamId)[1]);
      }
    }
    return res;
  }

  /**
   * get StreamIds with explicit which are forced for GetEvent by forceStreamIds
   */
  getForcedStreamsGetEventsStreamIds (storeId: string) {
    if (this._streamByStoreForced == null) return null;
    return this._streamByStoreForced[storeId];
  }

  _loadFeaturePermission (perm: FeaturePermission) {
    // here we might want to check if permission is higher
    this._registerFeaturePermission(perm);
  }

  _registerFeaturePermission (perm: FeaturePermission) {
    this.featurePermissionsMap[perm.feature] = perm;
    if (perm.feature === 'forcedStreams') { // load them by store
      const forced = perm as FeaturePermission & { streams?: string[] };
      // Mirror getForbiddenGetEventsStreamIds(): group each stream by its
      // parsed store id and keep the in-store id (the consumer pushes these
      // into per-store stream queries). The previous code passed the whole
      // array where a stream id string was expected and would have thrown.
      for (const streamId of forced.streams ?? []) {
        const [storeId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamId);
        if (this._streamByStoreForced[storeId] == null) this._streamByStoreForced[storeId] = [];
        this._streamByStoreForced[storeId].push(storeStreamId);
      }
    }
  }

  /** ---------- GENERIC --------------- */

  can (methodId: string) {
    switch (methodId) {
      // -- Account
      case 'account.get':
      case 'account.update':
      case 'account.changePassword':
      case 'account.changeUsername':
      case 'account.usernameChanges':
        return this.isPersonal();

      // -- Accesses
      case 'accesses.checkApp':
        return this.isPersonal();
      case 'accesses.get':
      case 'accesses.getOne':
      case 'accesses.create':
      case 'accesses.update':
        return !this.isShared();

      // -- Profile
      case 'profile.get':
      case 'profile.update':
        return this.isPersonal();

      // -- Webhooks
      case 'webhooks.create':
        return !this.isPersonal();

      default:
        throw (new Error('Unknown method.id: ' + methodId));
    }
  }

  /** ----------- ACCESSES -------------- */

  canCreateAccessForAccountStream (permissionLevel: string) {
    return isHigherOrEqualLevel('contribute', permissionLevel);
  }

  // -- accesses.get
  canListAnyAccess () {
    return this.isPersonal();
  }

  // Whether the current access delete manage the given access
  async canDeleteAccess (access: { type: string; id?: string; createdBy?: string }) {
    // The account owner can do everything.
    if (this.isPersonal()) return true;
    // App and Shared accesses can delete themselves (selfRevoke)
    if (access.id === this.id) {
      return this._canSelfRevoke();
    }

    if (this.isShared()) return false;

    // App token can delete the one they created
    return this.id === access.createdBy;
  }

  // Whether the current access can update the given target access.
  // Encodes the update matrix (no self-update, personal-immutable, app can
  // only update shared accesses it manages). Does NOT check whether the
  // proposed changes are valid — that's the chain-rules check at apply
  // time. Chain match is by `base`
  // (`parseAccessRef(target.createdBy).base === this.id`), not by composite
  // id.
  async canUpdateAccess (target: Record<string, unknown>): Promise<boolean> {
    if (target == null) return false;
    // No self-update — mutation always flows top-down from a parent.
    // Parse the target id so a future composite-form ref still matches the
    // caller's bare-base `this.id`.
    if (typeof target.id !== 'string') return false;
    if (parseAccessRef(target.id).base === this.id) return false;
    // Personal accesses are fully immutable via this method.
    if (target.type === 'personal') return false;
    // Owner identity — personal accesses can update any non-personal access
    // they own (subject to chain rules applied at write time).
    if (this.isPersonal()) return true;
    // Shared accesses cannot update anything.
    if (this.isShared()) return false;
    // App accesses can update only shared accesses they directly manage.
    if (target.type !== 'shared') return false;
    if (typeof target.createdBy !== 'string') return false;
    const parentBase = parseAccessRef(target.createdBy).base;
    return parentBase === this.id;
  }

  // Whether the current access can create the given access.
  //
  async canCreateAccess (candidate: { permissions?: Permission[]; [k: string]: unknown }) {
    // The account owner can do everything.
    if (this.isPersonal()) return true;
    // Shared accesses don't manage anything.
    if (this.isShared()) return false;

    // App accesses can only manage shared accesses.
    if (candidate.type !== 'shared') return false;

    let hasStreamPermissions = false;
    for (const perm of (candidate.permissions ?? [])) {
      if ('streamId' in perm && perm.streamId != null) {
        hasStreamPermissions = true;
        const myLevel = await this._getStreamPermissionLevel(perm.streamId);
        if (!myLevel || isLowerLevel(String(myLevel), perm.level) || myLevel === 'create-only') {
          return false;
        }
      } else if ('feature' in perm && perm.feature != null) {
        const allow = this._canCreateAccessWithFeaturePermission(perm);
        if (!allow) return false;
      }
    }
    // can only manage shared accesses with permissions
    if (!hasStreamPermissions) return false;

    // all OK
    return true;
  }

  /** ------------ STREAMS ------------- */

  async canListStream (streamId: string) {
    if (this.isPersonal()) return true;

    // Same rule as reading the events: an access sees only its own shared-secret
    // substream, so listing cannot be used to enumerate which other accesses
    // have secrets outstanding.
    const secretsOwner = sharedSecretsOwnerOf(streamId);
    if (secretsOwner != null) return secretsOwner === this.id;

    const level = await this._getStreamPermissionLevel(streamId);
    return !!(((level != null) && isHigherOrEqualLevel(level, 'read')));
  }

  async canCreateChildOnStream (streamId: string) {
    return await this._canManageStream(streamId);
  }

  async canDeleteStream (streamId: string) {
    return await this._canManageStream(streamId);
  }

  async canUpdateStream (streamId: string) {
    return await this._canManageStream(streamId);
  }

  /** @private internal  */
  async _canManageStream (streamId: string) {
    if (this.isPersonal()) return true;
    const level = await this._getStreamPermissionLevel(streamId || undefined);
    if (level === 'create-only') return false;
    return (level != null) && isHigherOrEqualLevel(level, 'manage');
  }

  /** ------------ EVENTS --------------- */

  async canGetEventsOnStream (streamId: string, storeId: string) {
    if (this.isPersonal()) return true;

    // Shared secrets are readable only by the access that created them, whatever
    // else that access was granted: a broad `*` permission must not become a way
    // to read another app's one-time secrets. (A personal token, handled above,
    // still sees the whole account.)
    const secretsOwner = sharedSecretsOwnerOf(streamId);
    if (secretsOwner != null) return secretsOwner === this.id;

    const fullStreamId = storeDataUtils.getFullItemId(storeId, streamId);

    const level = await this._getStreamPermissionLevel(fullStreamId);
    if (level == null || level === 'create-only') return false;
    return isHigherOrEqualLevel(level, 'read');
  }

  async canCreateEventsOnStream (streamId: string) {
    if (this.isPersonal()) return true;
    const level = await this._getStreamPermissionLevel(streamId);
    return (level != null) && isHigherOrEqualLevel(level, 'contribute');
  }

  async canUpdateEventsOnStream (streamId: string) {
    if (this.isPersonal()) return true;
    const level = await this._getStreamPermissionLevel(streamId);
    if (level === 'create-only') return false;
    return await this.canCreateEventsOnStream(streamId);
  }

  /**
   * new fashion to retrieve stream permissions
   * @param fullStreamId :{storeId}:{streamId}
   */
  async _getStreamPermissionLevel (fullStreamId: string | undefined) {
    if (fullStreamId == null) fullStreamId = '*'; // to be investgated why this happens

    if (this.isPersonal()) return 'manage';
    const cachedLevel = this._streamPermissionLevelCache[fullStreamId];
    if (cachedLevel != null) {
      return cachedLevel.level;
    }

    const permissions = await this._getStreamPermissions(fullStreamId);
    this._streamPermissionLevelCache[fullStreamId] = permissions;

    return permissions?.level;
  }

  async _getStreamPermissions (fullStreamId: string) {
    const [storeId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(fullStreamId);

    let currentStream = (storeStreamId !== '*') ? storeStreamId : null;

    const mall = await getMall();

    while (currentStream != null) { // should never execute
      const permissions = this.getStreamPermission(storeId, currentStream);
      if (permissions != null) return permissions; // found

      // not found, look for parent
      const stream = await mall.streams.getOneWithNoChildren(this._userId, currentStream, storeId);
      currentStream = stream ? stream.parentId : null;
    }

    // Here -- Stream Has not been found in permissions.. look for a '*' permission
    // Account streams are safe: account store is not in includedInStarPermissions,
    // so star permissions never expand to it.
    const permissions = this.getStreamPermission(storeId, '*');
    return permissions;
  }

  /**
   * return true is this access can create an access with this feature
   */
  _canCreateAccessWithFeaturePermission (featurePermission: FeaturePermission) {
    if (featurePermission.feature === 'selfRevoke') {
      // true if this acces canSelfRevoke or if requested setting is identical to this access
      return this._canSelfRevoke() || featurePermission.setting === this.featurePermissionsMap.selfRevoke.setting;
    }
    if (featurePermission.feature === 'selfAudit') {
      // true if this acces has no setting for selfAudit or if requested setting is identical to this access
      return this.featurePermissionsMap.selfAudit == null || featurePermission.setting === this.featurePermissionsMap.selfAudit.setting;
    }
  }

  /**
   * return true is does not have "feature selfRevoke" permission with level "forbidden"
   */
  _canSelfRevoke () {
    if (this.featurePermissionsMap.selfRevoke == null) return true; // default allow
    return this.featurePermissionsMap.selfRevoke.setting !== 'forbidden';
  }

  /**
   * Whether this access may hand secrets over through a one-time shared secret.
   *
   * Default allow, like selfRevoke: a token is only barred when it carries an
   * explicit `secretSharing: forbidden`. Publicly exposed tokens are the case
   * this exists for — they should not be able to mint redeemable credentials.
   */
  canCreateSharedSecrets () {
    // The map is absent on accesses built without a permission set (personal
    // tokens in some paths), which means nothing was forbidden.
    if (this.featurePermissionsMap?.secretSharing == null) return true; // default allow
    return this.featurePermissionsMap.secretSharing.setting !== 'forbidden';
  }
}

export default AccessLogic;
export { AccessLogic };
AccessLogic.PERMISSION_LEVEL_CONTRIBUTE = 'contribute';
AccessLogic.PERMISSION_LEVEL_MANAGE = 'manage';
AccessLogic.PERMISSION_LEVEL_READ = 'read';
AccessLogic.PERMISSION_LEVEL_CREATE_ONLY = 'create-only';

/**
 * return true is A >= B
 * @param permissionLevelA - level to challenge
 * @param permissionLevelB  - level
 */
function isHigherOrEqualLevel (permissionLevelA: string, permissionLevelB: string) {
  return (PermissionLevels as Record<string, number>)[permissionLevelA] >= (PermissionLevels as Record<string, number>)[permissionLevelB];
}
function isLowerLevel (permissionLevelA: string, permissionLevelB: string) {
  return !isHigherOrEqualLevel(permissionLevelA, permissionLevelB);
}
