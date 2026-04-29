/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { fromCallback } = require('utils');
const errors = require('errors').factory;
const commonFns = require('./helpers/commonFunctions');
const methodsSchema = require('../schema/mfaMethods');
const { getStorageLayer } = require('storage');
const { getConfig } = require('@pryv/boiler');
const { getMFAService, getMFASessionStore, Profile } = require('business/src/mfa');
const { getUsersRepository } = require('business/src/users');

const PROFILE_ID = 'private';

module.exports = async function (api) {
  const storageLayer = await getStorageLayer();
  const userProfileStorage = storageLayer.profile;
  const config = await getConfig();

  // Read the MFA config block per-invocation so `config.injectTestConfig()`
  // in tests is honored.
  function getMfaConfig () {
    return config.get('services:mfa');
  }

  /**
   * Returns the MFA service if configured, or null. Methods that require MFA
   * to be enabled return `apiUnavailable` when this is null.
   */
  function maybeMFAService () {
    return getMFAService(getMfaConfig());
  }
  function sessionStore () {
    return getMFASessionStore(getMfaConfig());
  }
  function requireMFAEnabled (next) {
    if (maybeMFAService() == null) {
      next(errors.apiUnavailable('MFA is not enabled on this server.'));
      return false;
    }
    return true;
  }

  /**
   * Load the MFA profile from `profile.private.data.mfa`. Returns a fresh
   * empty Profile when nothing is stored yet.
   */
  async function loadMFAProfile (user) {
    const profileSet = await fromCallback(cb =>
      userProfileStorage.findOne(user, { id: PROFILE_ID }, null, cb));
    if (!profileSet || !profileSet.data || !profileSet.data.mfa) return new Profile();
    const stored = profileSet.data.mfa;
    return new Profile(stored.content || {}, stored.recoveryCodes || []);
  }

  /**
   * Persist the MFA profile (or clear it when `profile == null`). The user's
   * private profile doc is created if missing.
   *
   * The profile storage converter uses a dot-notation shape: passing
   * `{ data: { mfa: X } }` becomes `$set['data.mfa'] = X`, and passing
   * `{ data: { mfa: null } }` becomes `$unset['data.mfa']`.
   */
  async function saveMFAProfile (user, profile) {
    const existing = await fromCallback(cb =>
      userProfileStorage.findOne(user, { id: PROFILE_ID }, null, cb));
    const mfaValue = profile == null
      ? null // null → $unset['data.mfa']
      : { content: profile.content, recoveryCodes: profile.recoveryCodes };
    if (!existing) {
      // If the private profile doesn't exist yet, create it with the mfa block
      // (or skip when clearing — there's nothing to clear).
      if (profile == null) return;
      await fromCallback(cb =>
        userProfileStorage.insertOne(user, { id: PROFILE_ID, data: { mfa: mfaValue } }, cb));
      return;
    }
    await fromCallback(cb =>
      userProfileStorage.updateOne(user, { id: PROFILE_ID }, { data: { mfa: mfaValue } }, cb));
  }

  // ----------------------------------------------------------------------
  // mfa.activate
  // ----------------------------------------------------------------------
  api.register('mfa.activate',
    requirePersonalAccess,
    async function activate (context, params, result, next) {
      if (!requireMFAEnabled(next)) return;
      try {
        // Activate body is the profile content (e.g. { phone: '+41...' }) — arbitrary
        // key/value pairs that get templated into the SMS endpoint URL/headers/body.
        const profile = new Profile(Object.assign({}, params), []);
        await maybeMFAService().challenge(context.user.username, profile, { headers: {}, body: params });
        const token = await sessionStore().create(profile, { user: context.user });
        result.mfaToken = token;
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  // ----------------------------------------------------------------------
  // mfa.confirm — receives mfaToken from params (route extracts it from header/body)
  // ----------------------------------------------------------------------
  api.register('mfa.confirm',
    commonFns.getParamsValidation(methodsSchema.confirm.params),
    async function confirm (context, params, result, next) {
      if (!requireMFAEnabled(next)) return;
      try {
        const session = await sessionStore().get(params.mfaToken);
        if (!session) return next(errors.invalidAccessToken('Invalid or expired MFA session token.'));
        const user = session.context.user;
        const profile = session.profile;
        await maybeMFAService().verify(user.username, profile, { headers: {}, body: params });
        profile.generateRecoveryCodes();
        await saveMFAProfile(user, profile);
        await sessionStore().clear(params.mfaToken);
        result.recoveryCodes = profile.getRecoveryCodes();
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  // ----------------------------------------------------------------------
  // mfa.challenge — re-send SMS during a pending login (mfaToken is bound to a verify-pending session)
  // ----------------------------------------------------------------------
  api.register('mfa.challenge',
    commonFns.getParamsValidation(methodsSchema.challenge.params),
    async function challenge (context, params, result, next) {
      if (!requireMFAEnabled(next)) return;
      try {
        const session = await sessionStore().get(params.mfaToken);
        if (!session) return next(errors.invalidAccessToken('Invalid or expired MFA session token.'));
        const user = session.context.user;
        await maybeMFAService().challenge(user.username, session.profile, { headers: {}, body: params });
        result.message = 'Please verify the MFA challenge.';
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  // ----------------------------------------------------------------------
  // mfa.verify — finishes a login-with-MFA flow; returns the real Pryv access token
  // ----------------------------------------------------------------------
  api.register('mfa.verify',
    commonFns.getParamsValidation(methodsSchema.verify.params),
    async function verify (context, params, result, next) {
      if (!requireMFAEnabled(next)) return;
      try {
        const session = await sessionStore().get(params.mfaToken);
        if (!session) return next(errors.invalidAccessToken('Invalid or expired MFA session token.'));
        const user = session.context.user;
        await maybeMFAService().verify(user.username, session.profile, { headers: {}, body: params });
        // The session.context.token is the real access token issued by auth.login
        // and stashed by Phase 5's MFA-aware login flow.
        if (!session.context.token) {
          return next(errors.unexpectedError(new Error('MFA session has no token to release — login flow not wired')));
        }
        result.token = session.context.token;
        if (session.context.apiEndpoint) result.apiEndpoint = session.context.apiEndpoint;
        await sessionStore().clear(params.mfaToken);
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  // ----------------------------------------------------------------------
  // mfa.deactivate — personal token; clears the user's MFA profile
  // ----------------------------------------------------------------------
  api.register('mfa.deactivate',
    requirePersonalAccess,
    commonFns.getParamsValidation(methodsSchema.deactivate.params),
    async function deactivate (context, params, result, next) {
      try {
        await saveMFAProfile(context.user, null);
        result.message = 'MFA deactivated.';
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  // ----------------------------------------------------------------------
  // mfa.recover — no auth; validates user/password/recoveryCode then clears MFA
  // ----------------------------------------------------------------------
  api.register('mfa.recover',
    commonFns.getParamsValidation(methodsSchema.recover.params),
    async function recover (context, params, result, next) {
      try {
        const usersRepository = await getUsersRepository();
        const user = await usersRepository.getUserByUsername(params.username);
        if (!user) return next(errors.invalidCredentials());
        const isValid = await usersRepository.checkUserPassword(user.id, params.password);
        if (!isValid) return next(errors.invalidCredentials());
        const profile = await loadMFAProfile(user);
        if (!profile.isActive()) {
          return next(errors.invalidOperation('MFA is not active for this user.'));
        }
        if (!profile.recoveryCodes.includes(params.recoveryCode)) {
          return next(errors.invalidParametersFormat('Invalid recovery code.'));
        }
        await saveMFAProfile(user, null);
        result.message = 'MFA deactivated.';
        next();
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * Step that requires the call to be made with a personal access token.
   * Uses the same shape as other auth-bound steps in service-core.
   */
  function requirePersonalAccess (context, params, result, next) {
    if (!context.access || context.access.type !== 'personal') {
      return next(errors.forbidden('A personal access token is required for this operation.'));
    }
    next();
  }
};
