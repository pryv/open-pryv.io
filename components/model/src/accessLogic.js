/**
 * Business logic for access objects.
 */

var treeUtils = require('components/utils').treeUtils,
    _ = require('lodash');

/**
 * Lists permission levels ordered by ascending level to help with permission assessment.
 */
var PermissionLevels = {
  'read': 0,
  'create-only': 1,
  'contribute': 1,
  'manage': 2,
};

Object.freeze(PermissionLevels);

/**
 * Usage example: _.extend(plainAccessObject, accessLogic);
 */
const accessLogic = module.exports = {

  isPersonal: function () {
    return this.type === 'personal';
  },

  isApp: function () {
    return this.type === 'app';
  },

  isShared: function () {
    return this.type === 'shared';
  },

  /**
   * Loads permissions from `this.permissions`.
   *
   * - Loads expanded streams permissions into `streamPermissions`/`streamPermissionsMap`
   *   using the given streams tree, filtering out unknown streams
   * - Loads tag permissions into `tagPermissions`/`tagPermissionsMap`.
   */
  loadPermissions: function (streams) {
    if (! this.permissions) {
      return;
    }

    // cache streams
    this._cachedStreams = streams;

    this.streamPermissions = [];
    this.streamPermissionsMap = {};
    this.tagPermissions = [];
    this.tagPermissionsMap = {};
    this.featurePermissions = [];
    this.featurePermissionsMap = {};


    this.permissions.forEach(function (perm) {
      if (perm.streamId) {
        this._loadStreamPermission(perm);
      } else if (perm.tag) {
        this._loadTagPermission(perm);
      } else if (perm.feature) {
        this._loadFeaturePermission(perm);
      }
    }.bind(this));

    // allow to read all tags if only stream permissions defined
    if (this.tagPermissions.length === 0 && this.streamPermissions.length > 0) {
      this._registerTagPermission({ tag: '*', level: 'read' });
    }
    // allow to read all streams if only tag permissions defined
    if (this.streamPermissions.length === 0 && this.tagPermissions.length > 0) {
      this._registerStreamPermission({ streamId: '*', level: 'read' });
    }
  },

  _loadStreamPermission: function (perm) {
    if (perm.streamId === '*') {
      this._registerStreamPermission(perm);
      return;
    }

    var expandedIds = treeUtils.expandIds(this._cachedStreams, [perm.streamId]);

    expandedIds.forEach(function (id) {
      var existingPerm = this.streamPermissionsMap[id];
      if (existingPerm && isHigherOrEqualLevel(existingPerm.level, perm.level)) {
        return;
      }

      var expandedPerm = id === perm.streamId ? perm : _.extend(_.clone(perm), {streamId: id});
      this._registerStreamPermission(expandedPerm);
    }.bind(this));
  },

  _registerStreamPermission: function (perm) {
    this.streamPermissions.push(perm);
    this.streamPermissionsMap[perm.streamId] = perm;
  },

  _loadFeaturePermission: function (perm) {
    // here we might want to check if permission is higher
    this._registerFeaturePermission(perm);
  },

  _registerFeaturePermission: function (perm) {
    this.featurePermissions.push(perm);
    this.featurePermissionsMap[perm.feature] = perm;
  },

  _loadTagPermission: function (perm) {
    var existingPerm = this.tagPermissionsMap[perm.tag];
    if (existingPerm && isHigherOrEqualLevel(existingPerm.level, perm.level)) {
      return;
    }
    this._registerTagPermission(perm);
  },

  _registerTagPermission: function (perm) {
    this.tagPermissions.push(perm);
    this.tagPermissionsMap[perm.tag] = perm;
  },

  canReadAllStreams: function () {
    return this.isPersonal() || !! this.getStreamPermissionLevel('*');
  },

  canReadStream: function (streamId) {
    const level = this.getStreamPermissionLevel(streamId);
    if (level === 'create-only') return false;
    return level && isHigherOrEqualLevel(level, 'read');
  },

  canListStream: function (streamId) {
    const level = this.getStreamPermissionLevel(streamId);
    return level && isHigherOrEqualLevel(level, 'read');
  },

  canContributeToStream: function (streamId) {
    const level = this.getStreamPermissionLevel(streamId);
    return level && isHigherOrEqualLevel(level, 'contribute');
  },

  canUpdateStream: function (streamId) {
    const level = this.getStreamPermissionLevel(streamId);
    if (level === 'create-only') return false;
    return this.canContributeToStream(streamId);
  },

  canManageStream: function (streamId) {
    const level = this.getStreamPermissionLevel(streamId || undefined);
    if (level === 'create-only') return false;
    return (level != null) && isHigherOrEqualLevel(level, 'manage');
  },

  canReadAllTags: function () {
    return this.isPersonal() || !!this.getTagPermissionLevel('*');
  },

  canReadTag: function (tag) {
    const level = this.getTagPermissionLevel(tag);
    if (level === 'create-only') return false;
    return level && isHigherOrEqualLevel(level, 'read');
  },

  canContributeToTag: function (tag) {
    const level = this.getTagPermissionLevel(tag);
    return level && isHigherOrEqualLevel(level, 'contribute');
  },

  canUpdateTag: function (tag) {
    const level = this.getTagPermissionLevel(tag);
    if (level === 'create-only') return false;
    return this.canContributeToTag(tag);
  },

  canManageTag: function (tag) {
    const level = this.getTagPermissionLevel(tag);
    if (level === 'create-only') return false;
    return level && isHigherOrEqualLevel(level, 'manage');
  },

  // Whether the current access delete manage the given access
  canDeleteAccess: function (access) {
    // The account owner can do everything. 
    if (this.isPersonal()) return true;
    // App and Shared accesses can delete themselves (selfRevoke)
    if (access.id === this.id) { 
      return this.canSelfRevoke();
    }

    if (this.isShared()) return false;

    // App token can delete the one they created
    return this.id === access.createdBy;
  },

  
  // Whether the current access can create the given access. 
  // 
  canCreateAccess: function (access) {
    //TODO handle tags
    
    // The account owner can do everything. 
    if (this.isPersonal()) return true;
    // Shared accesses don't manage anything. 
    if (this.isShared()) return false;
    
    // assert: this.isApp()

    // Augment the access with some logic.
    const candidate = _.extend(_.cloneDeep(access), accessLogic);
      
    // App accesses can only manage shared accesses.
    if (! candidate.isShared()) return false;
    
    // assert: candidate.isShared()

    candidate.loadPermissions(this._cachedStreams);

    if (! hasPermissions(this) || ! hasPermissions(candidate)) {
      // can only manage shared accesses with permissions
      return false;
    }

    // Can candidate access streams that `this` cannot? Does it elevate the 
    // permissions on common streams? If yes, abort. 
    for (const candidateStreamPermission of candidate.streamPermissions) {
      const candidateStreamId = candidateStreamPermission.streamId;

      // Check if `this` contains a permission on the candidate streamId.
      // A permission on the root stream (*) matches any candidate streamId and takes precedence.
      const rootPermission = this.streamPermissionsMap['*'];
      const myStreamPermission = rootPermission || this.streamPermissionsMap[candidateStreamId];
        
      // If `this` cannot access the candidate stream, then don't give access.
      if (myStreamPermission == null) return false; 
      
      // The level of `this` must >= the level of candidate streams.
      const myLevel = myStreamPermission.level; 
      const candidateLevel = candidateStreamPermission.level; 

      if (isLowerLevel(myLevel, candidateLevel) || myLevel === 'create-only') {
        return false; 
      }

      // continue looking for problems...
    }

    // Can candidate access tags that `this` cannot? Does it elevate the 
    // permissions on common tags? If yes, abort. 
    for (const candidateTagPermission of candidate.tagPermissions) {
      const myTagPermission = this.tagPermissionsMap[candidateTagPermission.tag];
      
      // If `this` has no permission on tag, so doesn't candidate.
      if (myTagPermission == null) return false; 

      // The level of `this` must >= the level of candidate tags.
      const myLevel = myTagPermission.level; 
      const candidateLevel = candidateTagPermission.level; 
      if (isLowerLevel(myLevel, candidateLevel)) return false; 
      
      // continue looking for problems...
    }

    return true;
  },

  /**
   * @returns {String} `null` if no matching permission exists.
   */
  getStreamPermissionLevel: function (streamId) {
    if (this.isPersonal()) {
      return 'manage';
    } else {
      var permission = this.streamPermissionsMap[streamId] || this.streamPermissionsMap['*'];
      return permission ? permission.level : null;
    }
  },

  /**
   * @returns {String} `null` if no matching permission exists.
   */
  getTagPermissionLevel: function (tag) {
    if (this.isPersonal()) {
      return 'manage';
    } else {
      var permission = this.tagPermissionsMap[tag] || this.tagPermissionsMap['*'];
      return permission ? permission.level : null;
    }
  },

  /**
   * return true is does not have "feature selfRevoke" permission with level "forbidden"
   */
  canSelfRevoke: function () {
    if (this.featurePermissionsMap.selfRevoke == null) return true; // default allow
    return this.featurePermissionsMap.selfRevoke.setting !== 'forbidden';
  },
};

function isHigherOrEqualLevel(permissionLevelA, permissionLevelB) {
  return PermissionLevels[permissionLevelA] >= PermissionLevels[permissionLevelB];
}
function isLowerLevel(permissionLevelA, permissionLevelB) {
  return ! isHigherOrEqualLevel(permissionLevelA, permissionLevelB);
}

function hasPermissions(access) {

  return access.permissions && access.permissions.length > 0 &&
    ((access.streamPermissions && access.streamPermissions.length > 0)
      || (access.tagPermissions && access.tagPermissions.length > 0));
}

