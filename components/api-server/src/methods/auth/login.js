/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const { fromCallback } = require('utils');
const commonFns = require('api-server/src/methods/helpers/commonFunctions');
const { ApiEndpoint } = require('utils');
const errors = require('errors').factory;
const methodsSchema = require('api-server/src/schema/authMethods');
const { getUsersRepository, UserRepositoryOptions, getPasswordRules } = require('business/src/users');
const { getStorageLayer } = require('storage');
const { getConfig } = require('@pryv/boiler');
const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils');
const timestamp = require('unix-timestamp');
const { getMFAService, getMFASessionStore, Profile: MFAProfile } = require('business/src/mfa');

const MFA_PROFILE_ID = 'private';

/**
 * Auth API methods implementations.
 *
 * @param api
 */
module.exports = async function (api) {
  const usersRepository = await getUsersRepository();
  const storageLayer = await getStorageLayer();
  const userAccessesStorage = storageLayer.accesses;
  const userProfileStorage = storageLayer.profile;
  const sessionsStorage = storageLayer.sessions;
  const config = await getConfig();
  const authSettings = config.get('auth');
  const passwordRules = await getPasswordRules();
  // Lazy per-request read so config.injectTestConfig() in tests is honored.
  const getMfaConfig = () => config.get('services:mfa');

  api.register('auth.login',
    commonFns.getParamsValidation(methodsSchema.login.params),
    commonFns.getTrustedAppCheck(authSettings),
    applyPrerequisitesForLogin,
    checkPassword,
    openSession,
    updateOrCreatePersonalAccess,
    addApiEndpoint,
    setAuditAccessId(AuditAccessIds.VALID_PASSWORD),
    setAdditionalInfo,
    mfaCheckIfActive);

  function applyPrerequisitesForLogin (context, params, result, next) {
    const fixedUsername = params.username.toLowerCase();
    if (context.user.username !== fixedUsername) {
      return next(errors.invalidOperation('The username in the path does not match that of ' +
          'the credentials.'));
    }
    next();
  }

  async function checkPassword (context, params, result, next) {
    try {
      const isValid = await usersRepository.checkUserPassword(context.user.id, params.password);
      if (!isValid) {
        return next(errors.invalidCredentials());
      }
      const expirationAndChangeTimes = await passwordRules.getPasswordExpirationAndChangeTimes(context.user.id);
      if (expirationAndChangeTimes.passwordExpires <= timestamp.now()) {
        const formattedExpDate = timestamp.toDate(expirationAndChangeTimes.passwordExpires).toISOString();
        const err = errors.invalidCredentials('Password expired since ' + formattedExpDate);
        err.data = { expiredTime: expirationAndChangeTimes.passwordExpires };
        return next(err);
      }
      Object.assign(result, expirationAndChangeTimes);
      next();
    } catch (err) {
      // handles unexpected errors
      return next(err);
    }
  }

  function openSession (context, params, result, next) {
    context.sessionData = {
      username: context.user.username,
      appId: params.appId
    };
    sessionsStorage.getMatching(context.sessionData, function (err, sessionId) {
      if (err) { return next(errors.unexpectedError(err)); }
      if (sessionId) {
        result.token = sessionId;
        next();
      } else {
        sessionsStorage.generate(context.sessionData, null, function (err, sessionId) {
          if (err) { return next(errors.unexpectedError(err)); }
          result.token = sessionId;
          next();
        });
      }
    });
  }

  function updateOrCreatePersonalAccess (context, params, result, next) {
    context.accessQuery = { name: params.appId, type: 'personal' };
    findAccess(context, (err, access) => {
      if (err) { return next(errors.unexpectedError(err)); }
      const accessData = { token: result.token };
      if (access != null) {
        // Access is already existing, updating it with new token (as we have updated the sessions with it earlier).
        updatePersonalAccess(accessData, context, next);
      } else {
        // Access not found, creating it
        createAccess(accessData, context, (err) => {
          if (err != null) {
            // Concurrency issue, the access is already created
            // by a simultaneous login (happened between a & b), retrieving and updating its modifiedTime, while keeping the same previous token
            if (err.isDuplicate) {
              findAccess(context, (err, access) => {
                if (err || access == null) { return next(errors.unexpectedError(err)); }
                result.token = access.token;
                accessData.token = access.token;
                updatePersonalAccess(accessData, context, next);
              });
            } else {
              // Any other error
              return next(errors.unexpectedError(err));
            }
          } else {
            next();
          }
        });
      }
    });

    function findAccess (context, callback) {
      userAccessesStorage.findOne(context.user, context.accessQuery, null, callback);
    }

    function createAccess (access, context, callback) {
      Object.assign(access, context.accessQuery);
      context.initTrackingProperties(access, UserRepositoryOptions.SYSTEM_USER_ACCESS_ID);
      userAccessesStorage.insertOne(context.user, access, callback);
    }

    function updatePersonalAccess (access, context, callback) {
      context.updateTrackingProperties(access, UserRepositoryOptions.SYSTEM_USER_ACCESS_ID);
      userAccessesStorage.updateOne(context.user, context.accessQuery, access, callback);
    }
  }

  function addApiEndpoint (context, params, result, next) {
    if (result.token) {
      result.apiEndpoint = ApiEndpoint.build(context.user.username, result.token);
    }
    next();
  }

  async function setAdditionalInfo (context, params, result, next) {
    // get user details
    const usersRepository = await getUsersRepository();
    const userBusiness = await usersRepository.getUserByUsername(context.user.username);
    if (!userBusiness) return next(errors.unknownResource('user', context.user.username));
    result.preferredLanguage = userBusiness.language;
    next();
  }

  /**
   * Plan 26 MFA integration. Runs as the final step of auth.login.
   *
   * If the user has MFA active (persistent state at `profile.private.data.mfa`)
   * AND the server has MFA enabled (`services.mfa.mode !== 'disabled'`):
   *   1. Call mfaService.challenge() — typically triggers an SMS to the user's phone
   *   2. Stash the already-issued Pryv access token + apiEndpoint + user in a new
   *      SessionStore session, keyed by a fresh mfaToken
   *   3. Delete `token`/`apiEndpoint` from the response and replace with `mfaToken`
   *
   * The caller must then call `mfa.verify` with the mfaToken + SMS code to
   * receive the real Pryv access token. If they fail / never verify, the session
   * expires (default 30 min) and the token is simply never released — matching
   * the original service-mfa proxy behaviour.
   *
   * When MFA is disabled server-wide OR the user has no `profile.mfa`, this step
   * is a no-op and the original login response is returned unchanged.
   */
  async function mfaCheckIfActive (context, params, result, next) {
    const mfaCfg = getMfaConfig();
    const mfaService = getMFAService(mfaCfg);
    if (mfaService == null) return next(); // MFA disabled server-wide
    try {
      const profileSet = await fromCallback(cb =>
        userProfileStorage.findOne(context.user, { id: MFA_PROFILE_ID }, null, cb));
      const storedMfa = profileSet && profileSet.data && profileSet.data.mfa;
      if (!storedMfa || !storedMfa.content || Object.keys(storedMfa.content).length === 0) {
        // No MFA configured for this user — login response stands as-is.
        return next();
      }
      const profile = new MFAProfile(storedMfa.content, storedMfa.recoveryCodes || []);
      await mfaService.challenge(context.user.username, profile, { headers: {}, body: params });

      // Stash the already-issued token in a pending session. Only release on mfa.verify.
      const mfaToken = await getMFASessionStore(mfaCfg).create(profile, {
        user: context.user,
        token: result.token,
        apiEndpoint: result.apiEndpoint
      });

      // Replace the response: caller must complete MFA before they see the real token.
      delete result.token;
      delete result.apiEndpoint;
      delete result.preferredLanguage;
      delete result.passwordExpires;
      delete result.passwordCanBeChanged;
      result.mfaToken = mfaToken;
      next();
    } catch (err) {
      next(err);
    }
  }

  // LOGOUT

  api.register('auth.logout',
    commonFns.getParamsValidation(methodsSchema.logout.params),
    destroySession);

  function destroySession (context, params, result, next) {
    sessionsStorage.destroy(context.accessToken, function (err) {
      next(err ? errors.unexpectedError(err) : null);
    });
  }
};
