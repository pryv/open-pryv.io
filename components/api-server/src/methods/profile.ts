/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MethodContext } from 'business/src/MethodContext.ts';
import type { MethodNext, NodeCallback } from './_types.ts';
const require = createRequire(import.meta.url);
const errors = require('errors').factory;
const commonFns = require('./helpers/commonFunctions.ts');
const methodsSchema = require('../schema/profileMethods.ts');

const { getStorageLayer } = require('storage');

type ProfileGetParams = { id?: string };
type ProfileUpdateParams = { id?: string; update: Record<string, unknown> };
type ProfileResult = { profile?: Record<string, unknown> };
type ProfileSet = { id: string; data: Record<string, unknown> } | null;

/**
 * Keys of the private profile that hold server-managed security state (the MFA
 * enrolment and the failed-attempt tally). Only the mfa.* methods read or write
 * them: they are never returned by profile reads, and profile updates refuse them.
 */
const RESERVED_PRIVATE_KEYS = ['mfa', 'mfaThrottle'];
/** Profile ids that are not app profiles, even for an app access bearing that name. */
const NON_APP_PROFILE_IDS = ['private', 'public'];

function withoutReserved (id: string | undefined, data: Record<string, unknown>): Record<string, unknown> {
  if (id !== 'private') return data;
  const out = { ...data };
  for (const k of RESERVED_PRIVATE_KEYS) delete out[k];
  return out;
}

/**
 * Profile methods implementation.
 */
export default async function (api: { register: (...args: unknown[]) => void }) {
  const storageLayer = await getStorageLayer();
  const userProfileStorage = storageLayer.profile;
  // RETRIEVAL / CREATION

  api.register('profile.getPublic',
    setPublicProfile,
    commonFns.getParamsValidation(methodsSchema.get.params),
    getProfile);

  function setPublicProfile (context: MethodContext, params: ProfileGetParams, result: ProfileResult, next: MethodNext) {
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

  function getProfile (context: MethodContext, params: ProfileGetParams, result: ProfileResult, next: MethodNext) {
    userProfileStorage.findOne(context.user, { id: params.id }, null, function (err: Error | null, profileSet: ProfileSet) {
      if (err) { return next(errors.unexpectedError(err)); }
      result.profile = profileSet ? withoutReserved(params.id, profileSet.data) : {};
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

  function updateProfile (context: MethodContext, params: ProfileUpdateParams, result: ProfileResult, next: MethodNext) {
    if (params.id === 'private') {
      const reserved = RESERVED_PRIVATE_KEYS.filter((k) => k in (params.update || {}));
      if (reserved.length > 0) {
        return next(errors.invalidOperation(
          `The private profile keys ${reserved.join(', ')} are managed by the MFA methods and cannot be set here.`,
          { keys: reserved }));
      }
    }
    userProfileStorage.findOne(context.user, { id: params.id }, null, function (err: Error | null, profileSet: ProfileSet) {
      if (err) return next(errors.unexpectedError(err));
      if (profileSet) return doUpdate();
      // item missing -> create it
      userProfileStorage.insertOne(context.user, { id: params.id, data: {} }, (function (err: Error | null) {
        if (err) return next(err);
        doUpdate();
      }) as NodeCallback<unknown>);
    });
    function doUpdate () {
      userProfileStorage.updateOne(context.user, { id: params.id }, { data: params.update },
        function (err: Error | null, updatedProfile: { data: Record<string, unknown> }) {
          if (err) return next(errors.unexpectedError(err));
          result.profile = withoutReserved(params.id, updatedProfile.data);
          next();
        });
    }
  }

  function setAppProfile (context: MethodContext, params: ProfileGetParams, result: ProfileResult, next: MethodNext) {
    if (!context.access.isApp()) {
      return next(errors.invalidOperation(
        'This resource is only available to app accesses.'));
    }
    // The app profile id is the access name, so an app access named "private"
    // or "public" would otherwise reach the user's own profiles.
    if (NON_APP_PROFILE_IDS.includes(context.access.name)) {
      return next(errors.invalidOperation(
        `An app access named "${context.access.name}" has no app profile: that name is reserved.`));
    }
    params.id = context.access.name;
    next();
  }
};
