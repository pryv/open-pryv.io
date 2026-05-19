/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');

const errors = require('errors').factory;
const commonFns = require('./helpers/commonFunctions.ts');
const mailing = require('./helpers/mailing.ts');
const methodsSchema = require('../schema/accountMethods.ts');

const { getConfig, getLogger } = require('@pryv/boiler');
const logger = getLogger('methods:account');
const { pubsub } = require('messages');
const { getStorageLayer } = require('storage');
const { getPlatform } = require('platform');

const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils.ts');

const { ErrorMessages } = require('errors/src/ErrorMessages.ts');
const ErrorIds = require('errors').ErrorIds;
const { getUsersRepository, UserRepositoryOptions, getPasswordRules } = require('business/src/users/index.ts');
const accountStreams = require('business/src/system-streams/index.ts');

export default async function (api: any) {
  const config = await getConfig();
  const authSettings = config.get('auth');
  const servicesSettings = config.get('services');
  const storageLayer = await getStorageLayer();
  const passwordResetRequestsStorage = storageLayer.passwordResetRequests;
  const platform = await getPlatform();
  const passwordRules = await getPasswordRules();
  const emailSettings = servicesSettings.email;
  const requireTrustedAppFn = commonFns.getTrustedAppCheck(authSettings);

  const usersRepository = await getUsersRepository();

  // RETRIEVAL

  api.register(
    'account.get',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.get.params),
    addUserBusinessToContext,
    async function (context: any, params: any, result: any, next: any) {
      try {
        result.account = context.userBusiness.getLegacyAccount();
        next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    }
  );

  // UPDATE

  api.register(
    'account.update',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.update.params),
    validateThatAllFieldsAreEditable,
    updateDataOnPlatform,
    updateAccount,
    addUserBusinessToContext,
    buildResultData
  );

  /**
   * Validate if given parameters are allowed for the edit
   *
   */
  function validateThatAllFieldsAreEditable (context: any, params: any, result: any, next: any) {
    const accountMap = accountStreams.accountMap;
    Object.keys(params.update).forEach((streamId: any) => {
      const streamIdWithPrefix = accountStreams.toStreamId(streamId);
      if (!accountMap[streamIdWithPrefix]?.isEditable) {
        // if user tries to add new streamId from non editable streamsIds
        return next(errors.invalidOperation(ErrorMessages[ErrorIds.ForbiddenToEditNoneditableAccountFields], { field: streamId }));
      }
    });
    next();
  }

  // CHANGE PASSWORD

  api.register(
    'account.changePassword',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.changePassword.params),
    verifyOldPassword,
    enforcePasswordRules,
    addUserBusinessToContext,
    setPassword
  );

  async function verifyOldPassword (context: any, params: any, result: any, next: any) {
    try {
      const isValid = await usersRepository.checkUserPassword(context.user.id, params.oldPassword);
      if (!isValid) {
        return next(errors.invalidOperation('The given password does not match.'));
      }
      next();
    } catch (err) {
      // handles unexpected errors
      return next(err);
    }
  }

  async function enforcePasswordRules (context: any, params: any, result: any, next: any) {
    try {
      await passwordRules.checkCurrentPasswordAge(context.user.id);
      await passwordRules.checkNewPassword(context.user.id, params.newPassword);
      next();
    } catch (err) {
      return next(err);
    }
  }

  // REQUEST PASSWORD RESET

  api.register(
    'account.requestPasswordReset',
    commonFns.getParamsValidation(methodsSchema.requestPasswordReset.params),
    requireTrustedAppFn,
    generatePasswordResetRequest,
    addUserBusinessToContext,
    sendPasswordResetMail,
    setAuditAccessId(AuditAccessIds.PASSWORD_RESET_REQUEST)
  );

  function generatePasswordResetRequest (context: any, params: any, result: any, next: any) {
    const username = context.user.username;
    if (username == null) {
      return next(new Error('AF: username is not empty.'));
    }
    passwordResetRequestsStorage.generate(username, function (err: any, token: any) {
      if (err) {
        return next(errors.unexpectedError(err));
      }
      context.resetToken = token;
      next();
    });
  }

  async function addUserBusinessToContext (context: any, params: any, result: any, next: any) {
    try {
      // get user details
      const usersRepository = await getUsersRepository();
      context.userBusiness = await usersRepository.getUserByUsername(context.user.username);
      if (!context.userBusiness) { return next(errors.unknownResource('user', context.user.username)); }
    } catch (err) {
      return next(err);
    }
    next();
  }

  async function setPassword (context: any, params: any, result: any, next: any) {
    try {
      const usersRepository = await getUsersRepository();
      await usersRepository.setUserPassword(context.userBusiness.id, params.newPassword, 'system');
      pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCOUNT_CHANGED);
    } catch (err) {
      return next(err);
    }
    next();
  }

  function sendPasswordResetMail (context: any, params: any, result: any, next: any) {
    // Skip this step if reset mail is deactivated
    const isMailActivated = emailSettings.enabled;
    if (isMailActivated === false ||
            (isMailActivated != null && isMailActivated.resetPassword === false)) {
      return next();
    }
    // Re-read `auth.passwordResetPageURL` fresh at request time. The
    // module-scope `authSettings = config.get('auth')` capture above is
    // taken at api init; in some boot orderings it can return a partially
    // -populated slice that misses values added later (notably by override
    // configs or extraConfig plugins). The freshly-resolved value falls
    // back to the captured one for back-compat.
    const passwordResetPageURL = config.get('auth:passwordResetPageURL') || authSettings.passwordResetPageURL;
    if (!passwordResetPageURL) {
      logger.warn('sendPasswordResetMail: auth.passwordResetPageURL is not configured — the reset email will contain a broken link.');
    }
    // Pre-compose the full reset link in code rather than concatenating in
    // the Pug template. This makes the surface less fragile (a missing
    // RESET_URL would otherwise render as a relative `?resetToken=<token>`
    // href that some clients silently rewrite). Existing templates that
    // still use `#{RESET_URL}?resetToken=#{RESET_TOKEN}` keep working
    // because both substitutions are still provided; new/updated templates
    // can simply use `#{RESET_LINK}`.
    const resetLink = passwordResetPageURL
      ? passwordResetPageURL + '?resetToken=' + encodeURIComponent(context.resetToken)
      : '?resetToken=' + encodeURIComponent(context.resetToken);
    const recipient = {
      email: context.userBusiness.email,
      name: context.userBusiness.username,
      type: 'to'
    };
    const substitutions = {
      RESET_TOKEN: context.resetToken,
      RESET_URL: passwordResetPageURL || '',
      RESET_LINK: resetLink
    };
    mailing.sendmail(emailSettings, emailSettings.resetPasswordTemplate, recipient, substitutions, context.userBusiness.language, next);
  }

  // RESET PASSWORD

  api.register(
    'account.resetPassword',
    commonFns.getParamsValidation(methodsSchema.resetPassword.params),
    requireTrustedAppFn,
    checkResetToken,
    enforcePasswordRules,
    addUserBusinessToContext,
    setPassword,
    destroyPasswordResetToken,
    setAuditAccessId(AuditAccessIds.PASSWORD_RESET_TOKEN)
  );

  function checkResetToken (context: any, params: any, result: any, next: any) {
    const username = context.user.username;
    if (username == null) {
      return next(new Error('AF: username is not empty.'));
    }
    passwordResetRequestsStorage.get(params.resetToken, username, function (err: any, reqData: any) {
      if (err) {
        return next(errors.unexpectedError(err));
      }
      if (!reqData) {
        return next(errors.invalidAccessToken('The reset token is invalid or expired'));
      }
      context.passwordResetRequest = reqData;
      next();
    });
  }

  async function updateDataOnPlatform (context: any, params: any, result: any, next: any) {
    try {
      const accountMap = accountStreams.accountMap;
      const operations: any[] = [];
      for (const [key, value] of Object.entries(params.update)) {
        // get previous value of the field;
        const previousValue = await usersRepository.getOnePropertyValue(context.user.id, key);
        operations.push({
          action: 'update',
          key,
          value,
          previousValue,
          isUnique: accountMap[accountStreams.toStreamId(key)].isUnique,
          isActive: true
        });
      }
      await platform.updateUser(context.user.username, operations);
    } catch (err) {
      return next(err);
    }
    next();
  }

  async function updateAccount (context: any, params: any, result: any, next: any) {
    try {
      const accessId = context.access?.id
        ? context.access.id
        : UserRepositoryOptions.SYSTEM_USER_ACCESS_ID;
      await usersRepository.updateOne(context.user, params.update, accessId);
      pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCOUNT_CHANGED);
    } catch (err) {
      return next(err);
    }
    next();
  }

  async function destroyPasswordResetToken (context: any, params: any, result: any, next: any) {
    const id = context.passwordResetRequest._id;
    await fromCallback((cb: any) => passwordResetRequestsStorage.destroy(id, context.user.username, cb));
    next();
  }

  /**
   * Build response body for the account update
   */
  async function buildResultData (context: any, params: any, result: any, next: any) {
    Object.keys(params.update).forEach((key: any) => {
      context.user[key] = params.update[key];
    });
    result.account = context.userBusiness.getLegacyAccount();
    next();
  }
};
