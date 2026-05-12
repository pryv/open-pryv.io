/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const errors = require('errors').factory;
const commonFns = require('./helpers/commonFunctions.ts');
const methodsSchema = require('../schema/profileMethods.ts');

const { getStorageLayer } = require('storage');

/**
 * Profile methods implementation.
 * TODO: add change notifications
 *
 */
export default async function (api: any) {
  const storageLayer = await getStorageLayer();
  const userProfileStorage = storageLayer.profile;
  // RETRIEVAL / CREATION

  api.register('profile.getPublic',
    setPublicProfile,
    commonFns.getParamsValidation(methodsSchema.get.params),
    getProfile);

  function setPublicProfile (context: any, params: any, result: any, next: any) {
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

  function getProfile (context: any, params: any, result: any, next: any) {
    userProfileStorage.findOne(context.user, { id: params.id }, null, function (err: any, profileSet: any) {
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

  function updateProfile (context: any, params: any, result: any, next: any) {
    userProfileStorage.findOne(context.user, { id: params.id }, null, function (err: any, profileSet: any) {
      if (err) return next(errors.unexpectedError(err));
      if (profileSet) return doUpdate();
      // item missing -> create it
      userProfileStorage.insertOne(context.user, { id: params.id, data: {} }, function (err: any) {
        if (err) return next(err);
        doUpdate();
      });
    });
    function doUpdate () {
      userProfileStorage.updateOne(context.user, { id: params.id }, { data: params.update },
        function (err: any, updatedProfile: any) {
          if (err) return next(errors.unexpectedError(err));
          result.profile = updatedProfile.data;
          next();
        });
    }
  }

  function setAppProfile (context: any, params: any, result: any, next: any) {
    if (!context.access.isApp()) {
      return next(errors.invalidOperation(
        'This resource is only available to app accesses.'));
    }
    params.id = context.access.name;
    next();
  }
};
