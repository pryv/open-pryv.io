/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
/**
 * Business logic for access objects.
 */

const _ = require('lodash');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');

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

    // by default lock all permisssions on system streams by adding them in order at start of permissions
    // in case they are allowed, they will be overwritten by permissions
    for (const forbiddenStream of SystemStreamsSerializer.getAllRootStreamIdsThatRequireReadRightsForEventsGet()) {
      this.permissions.unshift({ streamId: forbiddenStream, level: 'none' });
    }

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
   * - Loads tag permissions into `tagPermissions`/`tagPermissionsMap`.
   */
  async loadPermissions () {
    if (!this.permissions) {
      return;
    }

    this.tagPermissions = [];
    this.tagPermissionsMap = {};
    this.featurePermissionsMap = {};
    this._streamByStorePermissionsMap = {};
    this._streamByStoreForced = {};

    for (const perm of this.permissions) {
      if (perm.streamId != null) {
        await this._loadStreamPermission(perm);
      } else if (perm.tag != null) {
        this._loadTagPermission(perm);
      } else if (perm.feature != null) {
        this._loadFeaturePermission(perm);
      }
    }

    // allow to read all tags if only stream permissions defined
    if (!this.hasTagPermissions() && this.hasStreamPermissions()) {
      this._registerTagPermission({ tag: '*', level: 'read' });
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
   * returns the account streams with Authorizations
   * @returns {Array<permission>}
   */
  getAccountStreamPermissions () {
    const localPerms = this._streamByStorePermissionsMap.local;
    if (localPerms == null) return [];
    return Object.values(localPerms).filter(perm => SystemStreamsSerializer.isAccountStreamId(perm.streamId));
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
    const res = (storeId === 'local') ? [].concat(SystemStreamsSerializer.getAccountStreamsIdsForbiddenForReading()) : [];

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

  _loadTagPermission (perm) {
    const existingPerm = this.tagPermissionsMap[perm.tag];
    if ((existingPerm != null) && isHigherOrEqualLevel(existingPerm.level, perm.level)) {
      return;
    }
    this._registerTagPermission(perm);
  }

  _registerTagPermission (perm) {
    this.tagPermissions.push(perm);
    this.tagPermissionsMap[perm.tag] = perm;
  }

  /** ---------- GENERIC --------------- */

  can (methodId) {
    switch (methodId) {
      // -- Account
      case 'account.get':
      case 'account.update':
      case 'account.changePassword':
        return this.isPersonal();

      // -- Followed Slice
      case 'followedSlices.get':
      case 'followedSlices.create':
      case 'followedSlices.update':
      case 'followedSlices.delete':
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
      } else if (perm.tag != null) {
        const myTagPermission = this.tagPermissionsMap[perm.tag];
        const myLevel = myTagPermission?.level;
        if (!myLevel || isLowerLevel(myLevel, perm.level)) return false;
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

  canGetEventsWithAnyTag () {
    return this.isPersonal() || !!this._getTagPermissionLevel('*');
  }

  /** kept private as not used elsewhere */
  _canGetEventsWithTag (tag) {
    if (this.isPersonal()) return true;
    const level = this._getTagPermissionLevel(tag);
    if (level === 'create-only') return false;
    return (level != null) && isHigherOrEqualLevel(level, 'read');
  }

  /** kept private as not used elsewhere */
  _canCreateEventsWithTag (tag) {
    if (this.isPersonal()) return true;
    const level = this._getTagPermissionLevel(tag);
    return (level != null) && isHigherOrEqualLevel(level, 'contribute');
  }

  /** kept private as not used elsewhere */
  _canUpdateEventWithTag (tag) {
    if (this.isPersonal()) return true;
    const level = this._getTagPermissionLevel(tag);
    if (level === 'create-only') return false;
    return this._canCreateEventsWithTag(tag);
  }

  /*
  * Whether events in the given stream and tags context can be read.
  *
  * @param streamId
  * @param tags
  * @returns {Boolean}
  */
  async canGetEventsOnStreamAndWithTags (streamId, tags) {
    if (this.isPersonal()) return true;
    return (await this.canGetEventsOnStream(streamId, 'local')) &&
      (this.canGetEventsWithAnyTag() ||
        _.some(tags || [], this._canGetEventsWithTag.bind(this)));
  }

  /**
   * Whether events in the given stream and tags context can be updated/deleted.
   *
   * @param streamId
   * @param tags
   * @returns {Boolean}
   */
  async canUpdateEventsOnStreamAndWIthTags (streamId, tags) {
    if (this.isPersonal()) return true;
    return (await this.canUpdateEventsOnStream(streamId)) ||
      (this._canUpdateEventWithTag('*') ||
        _.some(tags || [], this._canUpdateEventWithTag.bind(this)));
  }

  /**
   * Whether events in the given stream and tags context can be created/updated/deleted.
   *
   * @param streamId
   * @param tags
   * @returns {Boolean}
   */
  async canCreateEventsOnStreamAndWIthTags (streamId, tags) {
    if (this.isPersonal()) return true;
    return (await this.canCreateEventsOnStream(streamId)) ||
      (this._canCreateEventsWithTag('*') ||
        _.some(tags || [], this._canCreateEventsWithTag.bind(this)));
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

    // do not allow star permissions for account streams
    if (SystemStreamsSerializer.isAccountStreamId(storeStreamId)) return null;

    const permissions = this.getStreamPermission(storeId, '*'); // found nothing finaly.. look for global access level if any
    return permissions;
  }

  /**
   * @returns {String} `null` if no matching permission exists.
   */
  _getTagPermissionLevel (tag) {
    if (this.isPersonal()) {
      return 'manage';
    } else {
      const permission = this.tagPermissionsMap[tag] || this.tagPermissionsMap['*'];
      return (permission != null) ? permission.level : null;
    }
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

  hasStreamPermissions () {
    return Object.keys(this._streamByStorePermissionsMap).length > 0;
  }

  hasTagPermissions () {
    return ((this.tagPermissions != null) && this.tagPermissions.length > 0);
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
