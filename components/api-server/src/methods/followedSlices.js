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
const async = require('async');
const commonFns = require('./helpers/commonFunctions');
const errors = require('errors').factory;
const methodsSchema = require('../schema/followedSlicesMethods');

const { pubsub } = require('messages');
const { getStorageLayer } = require('storage');
/**
 * Followed slices methods implementations.
 * TODO: refactor methods as chains of functions
 *
 * @param api
 */
module.exports = async function (api) {
  const storageLayer = await getStorageLayer();
  const userFollowedSlicesStorage = storageLayer.followedSlices;

  // RETRIEVAL

  api.register('followedSlices.get',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.get.params),
    function (context, params, result, next) {
      userFollowedSlicesStorage.find(context.user, {}, null, function (err, slices) {
        if (err) { return next(errors.unexpectedError(err)); }
        result.followedSlices = slices;
        next();
      });
    });

  // CREATION

  api.register('followedSlices.create',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.create.params),
    function (context, params, result, next) {
      userFollowedSlicesStorage.insertOne(context.user, params, function (err, newSlice) {
        if (err) {
          return next(getCreationOrUpdateError(err, params));
        }
        result.followedSlice = newSlice;
        pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_FOLLOWEDSLICES_CHANGED);
        next();
      });
    });

  // UPDATE

  api.register('followedSlices.update',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.update.params),
    function (context, params, result, next) {
      async.series([
        function checkSlice (stepDone) {
          userFollowedSlicesStorage.findOne(context.user, { id: params.id }, null,
            function (err, slice) {
              if (err) { return stepDone(errors.unexpectedError(err)); }

              if (!slice) {
                return stepDone(errors.unknownResource(
                  'followed slice', params.id
                ));
              }

              stepDone();
            });
        },
        function update (stepDone) {
          userFollowedSlicesStorage.updateOne(context.user, { id: params.id }, params.update,
            function (err, updatedSlice) {
              if (err) {
                return stepDone(getCreationOrUpdateError(err, params.update));
              }

              result.followedSlice = updatedSlice;
              pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_FOLLOWEDSLICES_CHANGED);
              stepDone();
            });
        }
      ], next);
    });

  /**
   * Returns the error to propagate given `dbError` and `params` as input.
   */
  function getCreationOrUpdateError (dbError, params) {
    // Duplicate errors
    if (dbError.isDuplicateIndex('name')) {
      return errors.itemAlreadyExists('followed slice',
        { name: params.name }, dbError);
    }
    if (dbError.isDuplicateIndex('username') && dbError.isDuplicateIndex('accessToken')) {
      return errors.itemAlreadyExists('followed slice',
        { url: params.url, accessToken: params.accessToken }, dbError);
    }
    // Any other error
    return errors.unexpectedError(dbError);
  }

  // DELETION

  api.register('followedSlices.delete',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.del.params),
    function (context, params, result, next) {
      userFollowedSlicesStorage.findOne(context.user, { id: params.id }, null, function (err, slice) {
        if (err) { return next(errors.unexpectedError(err)); }

        if (!slice) {
          return next(errors.unknownResource(
            'followed slice',
            params.id
          ));
        }

        userFollowedSlicesStorage.removeOne(context.user, { id: params.id }, function (err) {
          if (err) { return next(errors.unexpectedError(err)); }

          result.followedSliceDeletion = { id: params.id };
          pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_FOLLOWEDSLICES_CHANGED);
          next();
        });
      });
    });
};
