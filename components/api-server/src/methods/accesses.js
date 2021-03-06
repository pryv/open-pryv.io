/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
// @flow

const async = require('async');
const slugify = require('slug');
const _ = require('lodash');
const timestamp = require('unix-timestamp');
const bluebird = require('bluebird');

const APIError = require('errors').APIError;
const errors = require('errors').factory;
const ErrorIds = require('errors').ErrorIds;
const ErrorMessages = require('errors').ErrorMessages;

const treeUtils = require('utils').treeUtils;

const commonFns = require('./helpers/commonFunctions');
const methodsSchema = require('../schema/accessesMethods');
const accessSchema = require('../schema/access');
const string = require('./helpers/string');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');

const { getLogger } = require('@pryv/boiler');

import type { StorageLayer } from 'storage';
import type { MethodContext } from 'model';

import type API  from '../API';
import type { ApiCallback }  from '../API';
import type Notifications  from '../Notifications';
import type Result  from '../Result';

type Permission = {
  streamId: string, 
  level: 'manage' | 'contribute' | 'read' | 'create-only',
};
type Access = {
  type: 'personal' | 'app' | 'shared',
  permissions: Array<Permission>,
  expires: ?number,
  clientData: ?{},
};

type UpdatesSettingsHolder = {
  ignoreProtectedFields: boolean,
}

module.exports = function produceAccessesApiMethods(
  api: API, 
  notifications: Notifications, 
  updatesSettings: UpdatesSettingsHolder, 
  storageLayer: StorageLayer) 
{
  const logger = getLogger('methods:accesses');
  const dbFindOptions = { projection: 
    { calls: 0, deleted: 0 } };

  // COMMON

  function checkNoSharedAccess(
    context: MethodContext, params: mixed, result: Result, next: ApiCallback) 
  {
    const access = context.access;
    
    if (access == null || access.isShared()) {
      return next(errors.forbidden(
        'You cannot access this resource using a shared access token.')
      );
    }
    
    next();
  }

  // RETRIEVAL

  api.register('accesses.get',
    checkNoSharedAccess,
    commonFns.getParamsValidation(methodsSchema.get.params),
    findAccessibleAccesses,
    includeDeletionsIfRequested
  );

  function findAccessibleAccesses(context, params, result, next) {
    const currentAccess = context.access;
    const accessesRepository = storageLayer.accesses;
    const query = {};
    
    if (currentAccess == null) 
      return next(new Error('AF: Access cannot be null at this point.'));
    
    if (! currentAccess.isPersonal()) {
      // app -> only access it created
      query.createdBy = currentAccess.id;
    }

    accessesRepository.find(context.user, query, dbFindOptions, function (err, accesses) {
      if (err != null) return next(errors.unexpectedError(err)); 
      
      // We'll perform a few filter steps on this list, so let's start a chain.
      let chain = _.chain(accesses);
        
      // Filter expired accesses (maybe)
      chain = maybeFilterExpired(params, chain);

      // Return the chain result.
      result.accesses = chain.value();

      // Add apiEndpoind
      for (let i = 0; i < result.accesses.length; i++) {
        result.accesses[i].apiEndpoint = context.user.buildApiEndpoint(result.accesses[i].token);
      }

      next();
    });
    
    // Depending on 'includeExpired' in the query string, adds a filter to
    // `chain` that filters expired accesses.
    // 
    function maybeFilterExpired(params, chain: lodash$Chain<Access>) {
      const includeExpiredParam = params.includeExpired;
                  
      // If we also want to see expired accesses, don't filter them.
      if (includeExpiredParam === 'true' || includeExpiredParam === '1') 
        return chain;
      
      return chain.reject(
        a => isAccessExpired(a));
    }
  }

  function includeDeletionsIfRequested(context, params, result, next) {
    if (params.includeDeletions == null) { return next(); }

    const currentAccess = context.access;
    const accessesRepository = storageLayer.accesses;

    const query = {};
    if (!currentAccess.isPersonal()) {
      // app -> only access it created
      query.createdBy = currentAccess.id;
    }

    accessesRepository.findDeletions(context.user, query,  { projection: { calls: 0 } },
      function (err, deletions) {
        if (err) { return next(errors.unexpectedError(err)); }
        result.accessDeletions = deletions;
        next();
      });
  }


  // CREATION

  const notVisibleAccountStreamsIds = SystemStreamsSerializer.getAccountStreamsIdsForbiddenForReading();
  const visibleAccountStreamsIds = Object.keys(SystemStreamsSerializer.getReadableAccountStreams());

  api.register('accesses.create',
    checkNoSharedAccess,
    applyDefaultsForCreation,
    commonFns.getParamsValidation(methodsSchema.create.params),
    applyPrerequisitesForCreation,
    applyAccountStreamsValidation,
    createDataStructureFromPermissions,
    cleanupPermissions,
    createAccess);

  function applyDefaultsForCreation(context, params, result, next) {
    _.defaults(params, {type: 'shared'});
    next();
  }

  function applyPrerequisitesForCreation(context, params, result, next) {
    if (params.type === 'personal') {
      return next(errors.forbidden(
        'Personal accesses are created automatically on login.'
      ));
    }
    
    const access = context.access;
    if (access == null) 
      return next(errors.unexpectedError('AF: Access must not be null here.'));

    if (! access.canCreateAccess(params)) {
      return next(errors.forbidden(
        'Your access token has insufficient permissions ' +
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
      if (expireAfter >= 0) 
        params.expires = timestamp.now() + expireAfter;
      else 
        return next(
          errors.invalidParametersFormat('expireAfter cannot be negative.'));
    }

    context.initTrackingProperties(params);
    
    return next();
  }

  /**
   * If user is creating an access for default streams, apply some validations
   * @param {*} context 
   * @param {*} params 
   * @param {*} result 
   * @param {*} next 
   */
  function applyAccountStreamsValidation (context, params, result, next) {
    if (params.permissions == null) return next();

    // don't allow user to give access to not visible stream
    for (let i = 0; i < params.permissions.length; i++) {
      if (notVisibleAccountStreamsIds.includes(params.permissions[i].streamId)) {
        return next(errors.invalidOperation(
          ErrorMessages[ErrorIds.DeniedStreamAccess],
          { param: params.permissions[i].streamId }
        ));
      }
    }

    // don't allow user to give anything higher than contribute or read access
    //to visible stream
    for (let n = 0; n < params.permissions.length; n++) {
      if (visibleAccountStreamsIds.includes(params.permissions[n].streamId) &&
        params.permissions[n]?.level && !context.access.canCreateAccessForAccountStream(params.permissions[n].level)) {
        return next(errors.invalidOperation(
          ErrorMessages[ErrorIds.TooHighAccessForAccountStreams],
          { param: params.permissions[n].streamId }));
      }
    }

    return next();
  }

  // Creates default data structure from permissions if needed, for app
  // authorization. 
  // 
  function createDataStructureFromPermissions(context, params, result, next) {
    const access = context.access;
    if (access == null) 
      return next(errors.unexpectedError('AF: Access must not be null here.'));

    if (! access.isPersonal()) return next();
    if (params.permissions == null) return next(); 

    async.forEachSeries(params.permissions, ensureStream, next);
    function ensureStream (permission, streamCallback) {
      if (! permission.defaultName) return streamCallback();

      const streamsRepository = storageLayer.streams;
      const existingStream = treeUtils.findById(context.streams, permission.streamId);
      if (existingStream) {
        if (! existingStream.trashed) { return streamCallback(); }

        const update = {trashed: false};
        
        streamsRepository.updateOne(context.user, {id: existingStream.id}, update, function (err) {
          if (err) { return streamCallback(errors.unexpectedError(err)); }
          streamCallback();
        });
      } else {
        // create new stream
        const newStream = {
          id: permission.streamId,
          name: permission.defaultName,
          parentId: null
        };
        context.initTrackingProperties(newStream);
        
        streamsRepository.insertOne(context.user, newStream, function (err) {
          if (err != null) {
            // Duplicate errors
            if (err.isDuplicateIndex('id')) {
              // Stream already exists, log & proceed
              logger.info('accesses.create: stream "' + newStream.id + '" already exists: ' +
                  err.message);
            }
            else if (err.isDuplicateIndex('name')) {
              // Not OK: stream exists with same unique key but different id
              return streamCallback(errors.itemAlreadyExists(
                'stream', {name: newStream.name}, err
              ));
            }
            else {
              // Any other error
              return streamCallback(errors.unexpectedError(err));
            }
          }
          streamCallback();
        });
      }
    }
  }

  /**
   * Strips off the properties in permissions that are used to create the default data structure
   * (for app authorization).
   */
  function cleanupPermissions(context, params, result, next) {
    if (! params.permissions) { return next(); }

    params.permissions.forEach(function (perm) {
      delete perm.defaultName;
      delete perm.name;
    });
    next();
  }

  function createAccess(context, params, result, next) {
    const accessesRepository = storageLayer.accesses;
    
    accessesRepository.insertOne(context.user, params, function (err, newAccess) {
      if (err != null) {
        // Duplicate errors
        if (err.isDuplicateIndex('token')) {
          return next(errors.itemAlreadyExists('access', { token: '(hidden)' }));
        }
        if (err.isDuplicateIndex('type') && err.isDuplicateIndex('name') && err.isDuplicateIndex('deviceName')) {
          return next(errors.itemAlreadyExists('access', { 
            type: params.type,
            name: params.name,
            deviceName: params.deviceName,
          }));
        }
        // Any other error
        return next(errors.unexpectedError(err));
      }

      result.access = newAccess;
      result.access.apiEndpoint = context.user.buildApiEndpoint(result.access.token);
      notifications.accessesChanged(context.username);
      next();
    });
  }


  // UPDATE

  api.register('accesses.update',
    goneResource);

  function goneResource(context, params, result, next) {
    next(errors.goneResource('accesses.update has been removed'));
  }

  // Updates the access in `params.id` with the attributes in `params.update`.
  // 
  function updatePersonalAccess(context, params, result, next) {
    const accessesRepository = storageLayer.accesses;

    accessesRepository.updateOne(context.user, { id: params.id }, params.update,
      function (err, updatedAccess) {
        if (err != null) {
          // Expecting a duplicate error
          if (err.isDuplicateIndex('type') && err.isDuplicateIndex('name')) {
            return next(errors.itemAlreadyExists('access',
              { type: params.resource.type, name: params.update.name }));
          }
          // Any other error
          return next(errors.unexpectedError(err));
        }

        // cleanup internal fields
        delete updatedAccess.calls;

        // cleanup deleted
        delete updatedAccess.deleted;

        result.access = updatedAccess;
        notifications.accessesChanged(context.username);
        next();
      });
  }

  
  // DELETION

  api.register('accesses.delete',
    commonFns.getParamsValidation(methodsSchema.del.params),
    checkAccessForDeletion,
    findRelatedAccesses,
    deleteAccesses);

  async function checkAccessForDeletion(context, params, result, next) {
    const accessesRepository = storageLayer.accesses;
    const currentAccess = context.access;
    
    if (currentAccess == null)
      return next(new Error('AF: currentAccess cannot be null.'));

    let access;
    try {
      access = await bluebird.fromCallback(cb => {
        accessesRepository.findOne(
          context.user,
          { id: params.id },
          dbFindOptions,
          cb);
      });
    } catch (err) {
      return next(errors.unexpectedError(err));
    }

    if (access == null)
      return next(errors.unknownResource('access', params.id));
          
      if (! currentAccess.canDeleteAccess(access)) {
        return next(
          errors.forbidden(
            'Your access token has insufficient permissions to ' +
            'delete this access.'
          )
        );
      }
  
      // used in next function
      params.accessToDelete = access;
      next();
  }

  async function findRelatedAccesses(context, params, result, next) {
    const accessToDelete = params.accessToDelete;
    const accessesRepository = storageLayer.accesses;
    
    // deleting a personal access does not delete the accesses it created.
    if (! accessToDelete.type === 'personal') {
      return next();
    }

    let accesses;
    try {
      accesses = await bluebird.fromCallback(cb => {
        accessesRepository.find(context.user, { createdBy: params.id}, dbFindOptions, cb);
      });
    } catch (err) {
      return next(errors.unexpectedError(err)); 
    }
    if (accesses.length === 0) return next();

    accesses = accesses.filter(a => a.id !== params.id);
    accesses = accesses.filter(a => ! isAccessExpired(a));
    accesses = accesses.map(a => {
      return { id: a.id }
    });
    result.relatedDeletions = accesses;

    next();
  }

  async function deleteAccesses(context, params, result, next) {
    const accessesRepository = storageLayer.accesses;

    let idsToDelete: Array<{id: string}> = [{ id: params.id }];
    if (result.relatedDeletions != null) {
      idsToDelete = idsToDelete.concat(result.relatedDeletions);
    }

    try {
      await bluebird.fromCallback(cb => {
        accessesRepository.delete(context.user,
          { $or: idsToDelete },
          cb);
      });
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    result.accessDeletion = {id: params.id};
    notifications.accessesChanged(context.username);
    next();
  }

  // OTHER METHODS

  api.register('accesses.checkApp',
    commonFns.getParamsValidation(methodsSchema.checkApp.params),
    checkApp);

  function checkApp(context, params, result, next) {
    const currentAccess = context.access;
    if (currentAccess == null)
      return next(new Error('AF: currentAccess cannot be null.'));

    if (! currentAccess.isPersonal()) {
      return next(errors.forbidden(
        'Your access token has insufficient permissions to access this resource.'
      ));
    }

    const accessesRepository = storageLayer.accesses;
    const query = {
      type: 'app',
      name: params.requestingAppId,
      deviceName: params.deviceName || null
    };
    accessesRepository.findOne(context.user, query, dbFindOptions, function (err, access) {
      if (err != null) return next(errors.unexpectedError(err));

      // Do we have a match?
      if (accessMatches(access, params.requestedPermissions, params.clientData)) {
        result.matchingAccess = access;
        return next();
      } 
      
      // No, we don't have a match. Return other information:

      if (access != null) 
        result.mismatchingAccess = access;
      
      checkPermissions(context, params.requestedPermissions, function(
        err, checkedPermissions, checkError
      ) {
        if (err != null) 
          return next(err);

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
  function accessMatches(access: Access, requestedPermissions, clientData): boolean {
    if (access == null ||
        access.type !== 'app' ||
        access.permissions.length !== requestedPermissions.length) {
      return false;
    }
    
    // If the access is there but is expired, we consider it a mismatch. 
    if (isAccessExpired(access)) return false; 

    // Compare permissions
    let accessPerm, reqPerm;
    for (let i = 0, ni = access.permissions.length; i < ni; i++) {
      accessPerm = access.permissions[i];
      reqPerm = findByStreamId(requestedPermissions, accessPerm.streamId);

      if (! reqPerm ||
          reqPerm.level !== accessPerm.level) {
        return false;
      }
    }

    // Compare clientData
    if(! _.isEqual(access.clientData, clientData)) {
      return false;
    }

    return true;

    function findByStreamId(permissions, streamId) {
      return _.find(permissions, function (perm) { return perm.streamId === streamId; });
    }
  }

  // Iterates over the given permissions, replacing `defaultName` properties
  // with the actual `name` of existing streams. When defined, the callback's
  // `checkError` param signals issues with the requested permissions.
  // 
  function checkPermissions(context, permissions, callback) {
    // modify permissions in-place, assume no side fx
    const checkedPermissions = permissions; 
    let checkError = null;
    
    async.forEachSeries(checkedPermissions, checkPermission, function(err) {
      if (err != null) {
        return err instanceof APIError
          ? callback(err)
          : callback(errors.unexpectedError(err));
      }
      
      callback(null, checkedPermissions, checkError);
    });
    return;
    
    // NOT REACHED

    function checkPermission(permission, done) {
      if (permission.streamId === '*') {
        // cleanup ignored properties just in case
        delete permission.defaultName;
        return done();
      }

      if (permission.defaultName == null) {
        return done(
          errors.invalidParametersFormat(
            "The parameters' format is invalid.",
            'The permission for stream "' +
              permission.streamId +
              '" (and maybe others) is ' +
              'missing the required "defaultName".'
          )
        );
      }

      let permissionStream;
      const streamsRepository = storageLayer.streams;
      
      async.series(
        [
          function checkId(stepDone) {
            // NOT-OPTIMIZED: could return only necessary fields
            streamsRepository.findOne(
              context.user,
              { id: permission.streamId },
              null,
              function(err, stream) {
                if (err != null) 
                  return stepDone(err);

                permissionStream = stream;
                if (permissionStream != null) {
                  permission.name = permissionStream.name;
                  delete permission.defaultName;
                }

                stepDone();
              }
            );
          },
          function checkSimilar(stepDone) {
            if (permissionStream != null) 
              return stepDone();

            let nameIsUnique = false;
            let curSuffixNum = 0;
            
            async.until(
              () => nameIsUnique,
              checkName,
              stepDone
            );

            // Checks if a stream with a name of `defaultName` combined with 
            // `curSuffixNum` exists. Sets `nameIsUnique` to true if not. 
            function checkName(checkDone) {
              const checkedName = getAlternativeName(
                permission.defaultName,
                curSuffixNum
              );
              streamsRepository.findOne(
                context.user,
                { name: checkedName, parentId: null },
                null,
                function(err, stream) {
                  if (err != null)
                    return checkDone(err);
                    
                  // Is the name still free?
                  if (stream == null) {
                    nameIsUnique = true;
                    permission.defaultName = checkedName;
                  } else {
                    curSuffixNum++;
                    checkError = produceCheckError();
                  }

                  checkDone();
                }
              );
            }
          },
        ],
        done
      );
    }

    function produceCheckError() {
      return {
        id: ErrorIds.ItemAlreadyExists,
        message:
          'One or more requested streams have the same names as existing streams ' +
          'with different ids. The "defaultName" of the streams concerned have been updated ' +
          'with valid alternative proposals.',
      };
    }

    /**
     * Returns an alternative name proposal from the given base name, by adding a suffix based on
     * the given suffix number. If suffixNum is 0, the base name is left as-is.
     *
     * @param {string} name
     * @param {number} suffixNum
     * @return {string}
     */
    function getAlternativeName(name, suffixNum) {
      if (suffixNum === 0) return name; 
      
      return `${name} (${suffixNum})`;
    }
  }

  // Centralises the check for access expiry; yes, this should be part of some
  // business model about accesses. There is one more such check in MethodContext, 
  // called `checkAccessValid`.
  //
  function isAccessExpired(access: Access, nowParam?: number): boolean {
    const now = nowParam || timestamp.now(); 
    return access.expires != null && now > access.expires;
  }

};
