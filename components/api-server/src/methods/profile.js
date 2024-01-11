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
const errors = require('errors').factory;
const async = require('async');
const commonFns = require('./helpers/commonFunctions');
const methodsSchema = require('../schema/profileMethods');

const { getStorageLayer } = require('storage');

/**
 * Profile methods implementation.
 * TODO: add change notifications
 *
 * @param api
 */
module.exports = async function (api) {
  const storageLayer = await getStorageLayer();
  const userProfileStorage = storageLayer.profile;
  // RETRIEVAL / CREATION

  api.register('profile.getPublic',
    setPublicProfile,
    commonFns.getParamsValidation(methodsSchema.get.params),
    getProfile);

  function setPublicProfile (context, params, result, next) {
    params.id = 'public';
    next();
  }

  api.register('profile.getApp',
    setAppProfile,
    commonFns.getParamsValidation(methodsSchema.get.params),
    getProfile);

  api.register('profile.get',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.get.params),
    getProfile);

  function getProfile (context, params, result, next) {
    userProfileStorage.findOne(context.user, { id: params.id }, null, function (err, profileSet) {
      if (err) { return next(errors.unexpectedError(err)); }
      result.profile = profileSet ? profileSet.data : {};
      next();
    });
  }

  // UPDATE

  api.register('profile.updateApp',
    setAppProfile,
    commonFns.getParamsValidation(methodsSchema.update.params),
    updateProfile);

  api.register('profile.update',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.update.params),
    updateProfile);

  function updateProfile (context, params, result, next) {
    async.series([
      function checkExisting (stepDone) {
        userProfileStorage.findOne(context.user, { id: params.id }, null, function (err, profileSet) {
          if (err) { return stepDone(errors.unexpectedError(err)); }

          if (profileSet) { return stepDone(); }

          // item missing -> create it
          userProfileStorage.insertOne(context.user, { id: params.id, data: {} }, stepDone);
        });
      },
      function update (stepDone) {
        userProfileStorage.updateOne(context.user, { id: params.id }, { data: params.update },
          function (err, updatedProfile) {
            if (err) { return stepDone(errors.unexpectedError(err)); }

            result.profile = updatedProfile.data;
            stepDone();
          });
      }
    ], next);
  }

  function setAppProfile (context, params, result, next) {
    if (!context.access.isApp()) {
      return next(errors.invalidOperation(
        'This resource is only available to app accesses.'));
    }
    params.id = context.access.name;
    next();
  }
};
