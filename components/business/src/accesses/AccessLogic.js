/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Business logic for access objects.
 */

const _ = require('lodash');
const accountStreams = require('business/src/system-streams');

const { getConfigUnsafe } = require('@pryv/boiler');
const { storeDataUtils, getMall } = require('mall');

let auditIsActive = null;
function addAuditStreams () {
  if (auditIsActive !== null) return auditIsActive;
  auditIsActive = getConfigUnsafe().get('audit:active');
  return auditIsActive;
}

/**
 * Lists permission levels ordered by ascending level to help with permission assessment.
 */
const PermissionLevels = {
  none: -1,
  read: 0,
  'create-only': 1,
  contribute: 1,
  manage: 2
};

Object.freeze(PermissionLevels);

class AccessLogic {
  _access; // Access right from the DB
  _userId;
  _streamPermissionLevelCache;
  _streamByStorePermissionsMap;

  constructor (userId, access) {
    this._access = access;
    this._userId = userId;
    this._streamPermissionLevelCache = {};
    _.merge(this, access);

    if (this.isPersonal()) return;
    if (!this.id) return; // this is an access "in" creation process

    if (!this.permissions) this.permissions = [];

    // Lock account streams by default — explicit permissions can override.
    // This also makes the 'none' level visible in access-info API responses.
    this.permissions.unshift({ streamId: accountStreams.STREAM_ID_ACCOUNT, level: 'none' });

    // add audit permissions
    if (!addAuditStreams()) return;

    let selfAudit = true;
    for (const permission of this.permissions) {
      if (permission.feature === 'selfAudit' && permission.setting === 'forbidden') {
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
      if (perm.streamId != null) {
        await this._loadStreamPermission(perm);
      } else if (perm.feature != null) {
        this._loadFeaturePermission(perm);
      }
    }
  }

  async _loadStreamPermission (perm) {
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
   * @param {identifier} storeId
   * @returns {Array<permission>}
   */
  getStoresPermissions (storeId) {
    const storeStreamPermissionMap = this._streamByStorePermissionsMap[storeId];
    if (storeStreamPermissionMap == null) return [];
    return Object.values(storeStreamPermissionMap);
  }

  /**
   * returns the permission for this stream if it exists
   * @param {identifier} storeId
   * @param {identifier} streamId
   * @returns {permission}
   */
  getStreamPermission (storeId, streamId) {
    const storeStreamPermissionMap = this._streamByStorePermissionsMap[storeId];
    if (storeStreamPermissionMap == null) return null;
    return storeStreamPermissionMap[streamId];
  }

  /**
   * get a List of readable (root) streams that can be read / listed
   * @param {*} storeId
   * @returns
   */
  getListableStreamIds () {
    const res = [];
    if (this._streamByStorePermissionsMap != null) {
      for (const storeId of Object.keys(this._streamByStorePermissionsMap)) {
        const storePermissions = this._streamByStorePermissionsMap[storeId];
        for (const perm of Object.values(storePermissions)) {
          if ((perm.streamId != null) && isHigherOrEqualLevel(perm.level, 'read')) {
            res.push({ streamId: perm.streamId, storeId });
          }
        }
      }
    }
    return res;
  }

  /**
   * get StreamIds with explicit "no-list" permissions ("none", ...)
   * @param {storeId} storeId
   * @returns {Array<cleanStreamIds>}
   */
  getCannotListStreamsStreamIds (storeId) {
    const res = (storeId === 'local') ? [].concat(accountStreams.hiddenStreamIds) : [];

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
   * @param {storeId} storeId
   * @returns {Array<cleanStreamIds>}
   */
  getForbiddenGetEventsStreamIds (storeId) {
    if (this._streamByStorePermissionsMap == null) return [];
    const localPerms = this._streamByStorePermissionsMap[storeId];
    if (localPerms == null) return [];
    const res = [];

    for (const perm of Object.values(localPerms)) {
      if (perm.level === 'create-only' || perm.level == null || perm.level === 'none') {
        res.push(storeDataUtils.parseStoreIdAndStoreItemId(perm.streamId)[1]);
      }
    }
    return res;
  }

  /**
   * get StreamIds with explicit which are forced for GetEvent by forceStreamIds
   * @param {storeId} storeId
   * @returns {Array<cleanStreamIds>}
   */
  getForcedStreamsGetEventsStreamIds (storeId) {
    if (this._streamByStoreForced == null) return null;
    return this._streamByStoreForced[storeId];
  }

  _loadFeaturePermission (perm) {
    // here we might want to check if permission is higher
    this._registerFeaturePermission(perm);
  }

  _registerFeaturePermission (perm) {
    this.featurePermissionsMap[perm.feature] = perm;
    if (perm.feature === 'forcedStreams') { // load them by store
      const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(perm.streams);
      if (this._streamByStoreForced[storeId] == null) this._streamByStoreForced[storeId] = [];
      this._streamByStoreForced[storeId].push(...perm.streams);
    }
  }

  /** ---------- GENERIC --------------- */

  can (methodId) {
    switch (methodId) {
      // -- Account
      case 'account.get':
      case 'account.update':
      case 'account.changePassword':
        return this.isPersonal();

      // -- Accesses
      case 'accesses.checkApp':
        return this.isPersonal();
      case 'accesses.get':
      case 'accesses.create':
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

  canCreateAccessForAccountStream (permissionLevel) {
    return isHigherOrEqualLevel('contribute', permissionLevel);
  }

  // -- accesses.get
  canListAnyAccess () {
    return this.isPersonal();
  }

  // Whether the current access delete manage the given access
  async canDeleteAccess (access) {
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

  // Whether the current access can create the given access.
  //
  async canCreateAccess (candidate) {
    // The account owner can do everything.
    if (this.isPersonal()) return true;
    // Shared accesses don't manage anything.
    if (this.isShared()) return false;

    // App accesses can only manage shared accesses.
    if (candidate.type !== 'shared') return false;

    let hasStreamPermissions = false;
    for (const perm of candidate.permissions) {
      if (perm.streamId != null) {
        hasStreamPermissions = true;
        const myLevel = await this._getStreamPermissionLevel(perm.streamId);
        if (!myLevel || isLowerLevel(myLevel, perm.level) || myLevel === 'create-only') {
          return false;
        }
      } else if (perm.feature != null) {
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

  async canListStream (streamId) {
    if (this.isPersonal()) return true;
    const level = await this._getStreamPermissionLevel(streamId);
    return !!(((level != null) && isHigherOrEqualLevel(level, 'read')));
  }

  async canCreateChildOnStream (streamId) {
    return await this._canManageStream(streamId);
  }

  async canDeleteStream (streamId) {
    return await this._canManageStream(streamId);
  }

  async canUpdateStream (streamId) {
    return await this._canManageStream(streamId);
  }

  /** @private internal  */
  async _canManageStream (streamId) {
    if (this.isPersonal()) return true;
    const level = await this._getStreamPermissionLevel(streamId || undefined);
    if (level === 'create-only') return false;
    return (level != null) && isHigherOrEqualLevel(level, 'manage');
  }

  /** ------------ EVENTS --------------- */

  async canGetEventsOnStream (streamId, storeId) {
    if (this.isPersonal()) return true;

    const fullStreamId = storeDataUtils.getFullItemId(storeId, streamId);

    const level = await this._getStreamPermissionLevel(fullStreamId);
    if (level == null || level === 'create-only') return false;
    return isHigherOrEqualLevel(level, 'read');
  }

  async canCreateEventsOnStream (streamId) {
    if (this.isPersonal()) return true;
    const level = await this._getStreamPermissionLevel(streamId);
    return (level != null) && isHigherOrEqualLevel(level, 'contribute');
  }

  async canUpdateEventsOnStream (streamId) {
    if (this.isPersonal()) return true;
    const level = await this._getStreamPermissionLevel(streamId);
    if (level === 'create-only') return false;
    return await this.canCreateEventsOnStream(streamId);
  }

  /**
   * new fashion to retrieve stream permissions
   * @param {identifier} fullStreamId :{storeId}:{streamId}
   * @returns {String}  `null` if no matching permission exists.
   */
  async _getStreamPermissionLevel (fullStreamId) {
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

  async _getStreamPermissions (fullStreamId) {
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
  _canCreateAccessWithFeaturePermission (featurePermission) {
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
}

module.exports = AccessLogic;

AccessLogic.PERMISSION_LEVEL_CONTRIBUTE = 'contribute';
AccessLogic.PERMISSION_LEVEL_MANAGE = 'manage';
AccessLogic.PERMISSION_LEVEL_READ = 'read';
AccessLogic.PERMISSION_LEVEL_CREATE_ONLY = 'create-only';

/**
 * return true is A >= B
 * @param {*} permissionLevelA - level to challenge
 * @param {*} permissionLevelB  - level
 * @returns
 */
function isHigherOrEqualLevel (permissionLevelA, permissionLevelB) {
  return PermissionLevels[permissionLevelA] >= PermissionLevels[permissionLevelB];
}
function isLowerLevel (permissionLevelA, permissionLevelB) {
  return !isHigherOrEqualLevel(permissionLevelA, permissionLevelB);
}
