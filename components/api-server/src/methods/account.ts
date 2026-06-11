/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MethodNext as Next, ResultBag } from './_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';

const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');

type MethodContext = BaseMethodContext & {
  // scratchpad context: the method pipeline stashes typed-elsewhere objects
  // (userBusiness, passwordResetRequest, ...) here. Stays `any` until those
  // get real types (strongly-typed interface I/O follow-up plan).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

const errors = require('errors').factory;
const commonFns = require('./helpers/commonFunctions.ts');
const mailing = require('./helpers/mailing.ts');
const methodsSchema = require('../schema/accountMethods.ts');

const { ready } = require('@pryv/boiler');
const { pubsub } = require('messages');
const { getStorageLayer } = require('storage');
const { getPlatform } = require('platform');

const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils.ts');

const { ErrorMessages } = require('errors/src/ErrorMessages.ts');
const ErrorIds = require('errors').ErrorIds;
const { getUsersRepository, UserRepositoryOptions, getPasswordRules } = require('business/src/users/index.ts');
const accountStreams = require('business/src/system-streams/index.ts');

export default async function (api: { register: (...args: unknown[]) => void }) {
  const config = await ready();
  // Lazy getters instead of slice captures. Each call reads the current
  // config singleton via `.get()` — config.set() and injectTestConfig()
  // reach this factory's request handlers without a restart, and a
  // plugin or override that adds a key after factory init becomes
  // visible at request time. The boot-time REQUIRED_WHEN check
  // guarantees the keys this factory depends on are populated and
  // validated by the time `ready()` resolves.
  const getAuth = () => config.get('auth');
  const getEmail = () => config.get('services:email');
  const storageLayer = await getStorageLayer();
  const passwordResetRequestsStorage = storageLayer.passwordResetRequests;
  const platform = await getPlatform();
  const passwordRules = await getPasswordRules();
  const requireTrustedAppFn = commonFns.getTrustedAppCheck(getAuth);

  const usersRepository = await getUsersRepository();

  // RETRIEVAL

  api.register(
    'account.get',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.get.params),
    addUserBusinessToContext,
    async function (context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
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
  function validateThatAllFieldsAreEditable (_context: MethodContext, params: { update: Record<string, unknown> }, _result: ResultBag, next: Next) {
    const accountMap = accountStreams.accountMap;
    Object.keys(params.update).forEach((streamId: string) => {
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

  async function verifyOldPassword (context: MethodContext, params: { oldPassword: string }, _result: ResultBag, next: Next) {
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

  async function enforcePasswordRules (context: MethodContext, params: { newPassword: string }, _result: ResultBag, next: Next) {
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

  function generatePasswordResetRequest (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    const username = context.user.username;
    if (username == null) {
      return next(new Error('AF: username is not empty.'));
    }
    passwordResetRequestsStorage.generate(username, function (err: Error | null, token: string) {
      if (err) {
        return next(errors.unexpectedError(err));
      }
      context.resetToken = token;
      next();
    });
  }

  async function addUserBusinessToContext (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
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

  async function setPassword (context: MethodContext, params: { newPassword: string }, _result: ResultBag, next: Next) {
    try {
      const usersRepository = await getUsersRepository();
      await usersRepository.setUserPassword(context.userBusiness.id, params.newPassword, 'system');
      pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCOUNT_CHANGED);
    } catch (err) {
      return next(err);
    }
    next();
  }

  function sendPasswordResetMail (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    // Skip this step if reset mail is deactivated.
    const emailSettings = getEmail();
    const isMailActivated = emailSettings.enabled;
    if (isMailActivated === false ||
            (isMailActivated != null && isMailActivated.resetPassword === false)) {
      return next();
    }
    // The REQUIRED_WHEN boot check guarantees `auth.passwordResetPageURL`
    // is populated when the reset-password email feature is enabled
    // (boot exits with code 1 otherwise). No request-time fallback —
    // boot is the right place to catch missing config, not the
    // per-request mail path.
    const passwordResetPageURL = getAuth().passwordResetPageURL;
    const resetLink = passwordResetPageURL + '?resetToken=' + encodeURIComponent(context.resetToken);
    const recipient = {
      email: context.userBusiness.email,
      name: context.userBusiness.username,
      type: 'to'
    };
    const substitutions = {
      RESET_TOKEN: context.resetToken,
      RESET_URL: passwordResetPageURL,
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

  function checkResetToken (context: MethodContext, params: { resetToken: string }, _result: ResultBag, next: Next) {
    const username = context.user.username;
    if (username == null) {
      return next(new Error('AF: username is not empty.'));
    }
    passwordResetRequestsStorage.get(params.resetToken, username, function (err: Error | null, reqData: Record<string, unknown> | null) {
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

  async function updateDataOnPlatform (context: MethodContext, params: { update: Record<string, unknown> }, _result: ResultBag, next: Next) {
    try {
      const accountMap = accountStreams.accountMap;
      const operations: Array<Record<string, unknown>> = [];
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

  async function updateAccount (context: MethodContext, params: { update: Record<string, unknown> }, _result: ResultBag, next: Next) {
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

  async function destroyPasswordResetToken (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    const id = context.passwordResetRequest._id;
    await fromCallback((cb: (err?: unknown, result?: unknown) => void) => passwordResetRequestsStorage.destroy(id, context.user.username, cb));
    next();
  }

  /**
   * Build response body for the account update
   */
  async function buildResultData (context: MethodContext, params: { update: Record<string, unknown> }, result: ResultBag, next: Next) {
    Object.keys(params.update).forEach((key: string) => {
      (context.user as Record<string, unknown>)[key] = params.update[key];
    });
    result.account = context.userBusiness.getLegacyAccount();
    next();
  }
};
