/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
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
