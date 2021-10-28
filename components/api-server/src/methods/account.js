/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
var errors = require('errors').factory,
  commonFns = require('./helpers/commonFunctions'),
  mailing = require('./helpers/mailing'),
  methodsSchema = require('../schema/accountMethods');

const { getConfig } = require('@pryv/boiler');
const { pubsub } = require('messages');
const { getStorageLayer } = require('storage');

const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils');

const Registration = require('business/src/auth/registration'),
  ErrorMessages = require('errors/src/ErrorMessages'),
  ErrorIds = require('errors').ErrorIds,
  { getServiceRegisterConn } = require('business/src/auth/service_register'),
  { getUsersRepository, UserRepositoryOptions} = require('business/src/users');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
  /**
 * @param api
 */
module.exports = async function (api) {
  const config = await getConfig();
  const authSettings = config.get('auth');
  const servicesSettings = config.get('services');
  const storageLayer = await getStorageLayer();
  const passwordResetRequestsStorage = storageLayer.passwordResetRequests;

  var emailSettings = servicesSettings.email,
    requireTrustedAppFn = commonFns.getTrustedAppCheck(authSettings);

  // initialize service-register connection
  const serviceRegisterConn = getServiceRegisterConn();
  const usersRepository = await getUsersRepository(); 

  const isDnsLess = config.get('dnsLess:isActive');

  // RETRIEVAL

  api.register('account.get',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.get.params),
    addUserBusinessToContext,
    async function (context, params, result, next) {
      try {
        result.account = context.userBusiness.getLegacyAccount();
        next();
      } catch (err) {
        return next(errors.unexpectedError(err));
      }
    });
  

  // UPDATE

  api.register('account.update',
    commonFns.basicAccessAuthorizationCheck,  
    commonFns.getParamsValidation(methodsSchema.update.params),
    validateThatAllFieldsAreEditable,
    notifyServiceRegister,
    updateAccount,
    addUserBusinessToContext,
    buildResultData,
  );

  /**
   * Validate if given parameters are allowed for the edit
   * 
   * @param {*} context 
   * @param {*} params 
   * @param {*} result 
   * @param {*} next 
   */
  function validateThatAllFieldsAreEditable (context, params, result, next) {
    const editableAccountMap: Map<string, SystemStream> = SystemStreamsSerializer.getEditableAccountMap();
    Object.keys(params.update).forEach(streamId => {
      const streamIdWithPrefix = SystemStreamsSerializer.addCorrectPrefixToAccountStreamId(streamId);
      if (editableAccountMap[streamIdWithPrefix] == null) {
        // if user tries to add new streamId from non editable streamsIds
        return next(errors.invalidOperation(
          ErrorMessages[ErrorIds.ForbiddenToEditNoneditableAccountFields],
          { field: streamId }
        ));
      }
    })
    next();
  }
  // CHANGE PASSWORD

  api.register('account.changePassword',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.changePassword.params),
    verifyOldPassword,
    addUserBusinessToContext,
    addNewPasswordParameter,
    updateAccount
  );

  async function verifyOldPassword (context, params, result, next) {
    try{
      const isValid = await usersRepository.checkUserPassword(context.user.id, params.oldPassword);
      if (!isValid) {
        return next(errors.invalidOperation(
          'The given password does not match.'));
      }
      next();
    } catch (err) {
      // handles unexpected errors
      return next(err);
    }
  }

  // REQUEST PASSWORD RESET

  api.register('account.requestPasswordReset',
    commonFns.getParamsValidation(methodsSchema.requestPasswordReset.params),
    requireTrustedAppFn,
    generatePasswordResetRequest,
    addUserBusinessToContext,
    sendPasswordResetMail,
    setAuditAccessId(AuditAccessIds.PASSWORD_RESET_REQUEST));

  

  function generatePasswordResetRequest(context, params, result, next) {
    const username = context.user.username;
    if (username == null) {
      return next(new Error('AF: username is not empty.'));
    }
    passwordResetRequestsStorage.generate(username, function (err, token) {
      if (err) { return next(errors.unexpectedError(err)); }

      context.resetToken = token;
      next();
    });
  }

  async function addUserBusinessToContext(context, params, result, next) {
    try {
      // get user details
      const usersRepository = await getUsersRepository();
      context.userBusiness = await usersRepository.getUserByUsername(context.user.username);
      if (! context.userBusiness) return next(errors.unknownResource('user', context.user.username));
    } catch (err) {
      return next(err);
    }
    next();
  }

  function sendPasswordResetMail(context, params, result, next) {
    // Skip this step if reset mail is deactivated
    const isMailActivated = emailSettings.enabled;
    if (isMailActivated === false ||
       (isMailActivated != null && isMailActivated.resetPassword === false)) {
      return next();
    }

    const recipient = {
      email: context.userBusiness.email,
      name: context.userBusiness.username,
      type: 'to'
    };

    const substitutions = {
      RESET_TOKEN: context.resetToken,
      RESET_URL: authSettings.passwordResetPageURL
    };

    mailing.sendmail(emailSettings, emailSettings.resetPasswordTemplate,
      recipient, substitutions, context.userBusiness.language, next);
  }

  // RESET PASSWORD

  api.register('account.resetPassword',
    commonFns.getParamsValidation(methodsSchema.resetPassword.params),
    requireTrustedAppFn,
    checkResetToken,
    addUserBusinessToContext,
    addNewPasswordParameter,
    updateAccount,
    setAuditAccessId(AuditAccessIds.PASSWORD_RESET_TOKEN)
  );

  function checkResetToken(context, params, result, next) {
    const username = context.user.username;
    if (username == null) {
      return next(new Error('AF: username is not empty.'));
    }
    passwordResetRequestsStorage.get(
      params.resetToken,
      username,
      function (err, reqData) {
        if (err) { return next(errors.unexpectedError(err)); }

        if (! reqData) {
          return next(errors.invalidAccessToken('The reset token is invalid or expired'));
        }
        next();
      }
    );
  }

  function addNewPasswordParameter (context, params, result, next) {
    if (!context.userBusiness.passwordHash) {
      return next(errors.unexpectedError());
    }
    params.update = { password: params.newPassword };
    next();
  }

  async function notifyServiceRegister (context, params, result, next) {
    // no need to update service register if it is single node setup
    if (isDnsLess) {
      return next();
    }
    try {
      const editableAccountMap: Map<string, SystemStream> = SystemStreamsSerializer.getEditableAccountMap();

      const operations: Array<{}> = [];
      for (const [key, value] of Object.entries(params.update)) {
        operations.push({
          update: {
            key,
            value,
            isUnique: editableAccountMap[SystemStreamsSerializer.addCorrectPrefixToAccountStreamId(key)].isUnique,
          }
        })
      }
      await serviceRegisterConn.updateUserInServiceRegister(
        context.user.username,
        operations,
        true,
        false,
      );
    } catch (err) {
      return next(err);
    }
    next();
  }

  async function updateAccount(context, params, result, next) {
    try {
      const accessId = (context.access?.id) ? context.access.id : UserRepositoryOptions.SYSTEM_USER_ACCESS_ID
      await usersRepository.updateOne(
        context.user,
        params.update,
        accessId,
      );
      pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_ACCOUNT_CHANGED);
    } catch (err) {
      return next(err);
    }
    next();
  }

  /**
   * Build response body for the account update
   * @param {*} context 
   * @param {*} params 
   * @param {*} result 
   * @param {*} next 
   */
  async function buildResultData (context, params, result, next) {
    Object.keys(params.update).forEach(key => {
      context.user[key] = params.update[key];
    });
    result.account = context.userBusiness.getLegacyAccount();
    next();
  }
};
