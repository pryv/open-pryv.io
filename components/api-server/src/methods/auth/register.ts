/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const commonFns = require('./../helpers/commonFunctions.ts');
const errors = require('errors').factory;
const methodsSchema = require('api-server/src/schema/authMethods.ts');
const Registration = require('business/src/auth/registration.ts').default;
const { getPlatform } = require('platform');
const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils.ts');
const { ready } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');
const { getPasswordRules, getUsersRepository } = require('business').users;

// Match serviceInfo.{register,api,access} convention (slash-terminated).
// Naive `host + 'users'` concatenation in clients/tests would otherwise
// produce `https://single.example.devusers`. coreIdToUrl() normalizes
// internally; this helper covers the two ApiEndpoint.build() fallback
// sites below that bypass it.
function withTrailingSlash (url: any) {
  if (url == null || url === '') return url;
  return url.endsWith('/') ? url : url + '/';
}

/**
 * Auth API methods implementations.
 *
 */
export default async function (api: any) {
  const config = await ready();
  const storageLayer = await getStorageLayer();
  const servicesSettings = config.get('services');
  const usersRepository = await getUsersRepository();
  const passwordRules = await getPasswordRules();
  // REGISTER
  const registration = new Registration(null, storageLayer, servicesSettings);
  await registration.init();
  const platform = await getPlatform();

  api.register('auth.register',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    commonFns.getParamsValidation(methodsSchema.register.params),
    enforcePasswordRules,
    registration.prepareUserData.bind(registration),
    // in multi-core mode, if the selected hosting maps
    // to a different core, transparently HTTPS-proxy the POST to the
    // target core and return its response. Atomic on target; clients
    // don't need to re-POST.
    registration.forwardIfCrossCore.bind(registration),
    registration.validateOnPlatform.bind(registration),
    registration.createUser.bind(registration),
    registration.buildResponse.bind(registration),
    registration.sendWelcomeMail.bind(registration));

  async function enforcePasswordRules (context: any, params: any, result: any, next: any) {
    try {
      await passwordRules.checkNewPassword(null, params.password);
      next();
    } catch (err) {
      return next(err);
    }
  }

  // Username check
  api.register('auth.usernameCheck',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    commonFns.getParamsValidation(methodsSchema.usernameCheck.params),
    checkUsername);

  // Email / unique field check
  api.register('auth.emailCheck',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    commonFns.getParamsValidation(methodsSchema.emailCheck.params),
    checkUniqueField);

  /**
   * Check if username is taken
   */
  async function checkUsername (context: any, params: any, result: any, next: any) {
    result.reserved = await usersRepository.usernameExists(params.username);
    if (result.reserved == null) {
      return next(errors.unexpectedError('username reserved cannot be null'));
    }
    next();
  }

  /**
   * Check if a unique field value is already taken (email, etc.)
   */
  async function checkUniqueField (context: any, params: any, result: any, next: any) {
    result.reserved = false;
    const field = Object.keys(params)[0];
    if (field === 'username') {
      if (await usersRepository.usernameExists(params[field])) {
        return next(errors.itemAlreadyExists('user', { username: params[field] }));
      }
    }
    const value = await platform.getUsersUniqueField(field, params[field]);
    if (value != null) {
      return next(errors.itemAlreadyExists('user', { [field]: params[field] }));
    }
    next();
  }

  // Core discovery — find which core hosts a given user
  const { ApiEndpoint } = require('utils');

  api.register('auth.cores',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    coresLookup);

  async function coresLookup (context: any, params: any, result: any, next: any) {
    if (params.username == null && params.email == null) {
      return next(errors.invalidParametersFormat('provide "username" or "email" as query parameter'));
    }
    if (params.username != null && params.email != null) {
      return next(errors.invalidParametersFormat('provide only "username" or "email", not both'));
    }

    let username = params.username;

    // Resolve email → username via PlatformDB unique field
    if (params.email != null) {
      username = await platform.getUsersUniqueField('email', params.email);
      if (username == null) {
        // Unknown email — return self URL (client can attempt registration)
        result.core = { url: withTrailingSlash(platform.coreUrl || ApiEndpoint.build('', null)) };
        return next();
      }
    }

    // Multi-core: look up which core hosts this user via shared PlatformDB
    if (!platform.isSingleCore) {
      const userCoreId = await platform.getUserCore(username);
      if (userCoreId != null) {
        result.core = { url: platform.coreIdToUrl(userCoreId) };
        return next();
      }
      // User not in PlatformDB — unknown
      return next(errors.unknownResource('user', username));
    }

    // Single-core: check local users_index
    if (!(await usersRepository.usernameExists(username))) {
      return next(errors.unknownResource('user', username));
    }
    result.core = { url: ApiEndpoint.build(username, null) };
    next();
  }

  // Hostings — available cores (regions/zones/hostings hierarchy)
  api.register('auth.hostings',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    hostingsLookup);

  async function hostingsLookup (context: any, params: any, result: any, next: any) {
    try {
      const configHostings = config.get('hostings');
      const allCores = await platform.getAllCoreInfos();

      // Build hosting → available core URL map
      const hostingCores: any = {};
      for (const core of allCores) {
        if (core.available === false) continue;
        const h = core.hosting || 'default';
        if (!hostingCores[h]) hostingCores[h] = [];
        hostingCores[h].push(core);
      }

      if (configHostings != null && configHostings.regions != null) {
        // Use configured hierarchy, enrich with availability from PlatformDB
        type Hosting = { available?: boolean, availableCore?: string };
        type Zone = { hostings?: Record<string, Hosting> };
        type Region = { zones?: Record<string, Zone> };
        const regions: Record<string, Region> = JSON.parse(JSON.stringify(configHostings.regions));
        for (const region of Object.values(regions)) {
          for (const zone of Object.values(region.zones || {})) {
            for (const [hKey, hosting] of Object.entries(zone.hostings || {})) {
              const cores = hostingCores[hKey] || [];
              hosting.available = cores.length > 0;
              hosting.availableCore = cores.length > 0
                ? platform.coreIdToUrl(cores[0].id)
                : '';
            }
          }
        }
        result.regions = regions;
      } else {
        // Auto-generate minimal hierarchy for single-core / unconfigured
        const selfUrl = withTrailingSlash(platform.coreUrl || ApiEndpoint.build('', null));
        result.regions = {
          default: {
            name: 'Default',
            zones: {
              default: {
                name: 'Default',
                hostings: {
                  default: {
                    name: 'Default',
                    available: true,
                    availableCore: selfUrl
                  }
                }
              }
            }
          }
        };
      }
      next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
  }
};
