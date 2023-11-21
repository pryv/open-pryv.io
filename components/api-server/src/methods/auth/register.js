/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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
const commonFns = require('./../helpers/commonFunctions');
const errors = require('errors').factory;
const methodsSchema = require('api-server/src/schema/authMethods');
const Registration = require('business/src/auth/registration');
const { getPlatform } = require('platform');
const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils');
const { getLogger, getConfig } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');
const { getPasswordRules, getUsersRepository } = require('business').users;
/**
 * Auth API methods implementations.
 *
 * @param api
 */
module.exports = async function (api) {
  const config = await getConfig();
  const logging = await getLogger('register');
  const storageLayer = await getStorageLayer();
  const servicesSettings = config.get('services');
  const isDnsLess = config.get('dnsLess:isActive');
  const usersRepository = await getUsersRepository();
  const passwordRules = await getPasswordRules();
  // REGISTER
  const registration = new Registration(logging, storageLayer, servicesSettings);
  await registration.init();
  const platform = await getPlatform();
  function skip (context, params, result, next) {
    next();
  }
  function ifDnsLess (ifTrue, ifFalse) {
    if (isDnsLess) {
      return ifTrue || skip;
    }
    return ifFalse || skip;
  }
  api.register('auth.register', setAuditAccessId(AuditAccessIds.PUBLIC),
    // data validation methods
    commonFns.getParamsValidation(methodsSchema.register.params), enforcePasswordRules, registration.prepareUserData, ifDnsLess(skip, registration.createUserStep1_ValidateUserOnPlatform.bind(registration)),
    // user registration methods
    ifDnsLess(skip, registration.deletePartiallySavedUserIfAny.bind(registration)), ifDnsLess(skip, registration.createUserStep2_CreateUserOnPlatform.bind(registration)), registration.createUser.bind(registration), registration.buildResponse.bind(registration), registration.sendWelcomeMail.bind(registration));
  async function enforcePasswordRules (context, params, result, next) {
    try {
      await passwordRules.checkNewPassword(null, params.password);
      next();
    } catch (err) {
      return next(err);
    }
  }
  // Username check
  /**
   * Seem to be use only in dnsLess..
   */
  api.register('auth.usernameCheck',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    commonFns.getParamsValidation(methodsSchema.usernameCheck.params),
    checkUsername);

  /**
   * ⚠️ DNS-less only
   */
  api.register('auth.emailCheck',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    commonFns.getParamsValidation(methodsSchema.emailCheck.params),
    checkLocalUsersUniqueField);

  /**
   * Check in service-register if user id is reserved
   * ⚠️ DNS-less only
   * @param {*} context
   * @param {*} params
   * @param {*} result
   * @param {*} next
   */
  async function checkLocalUsersUniqueField (context, params, result, next) {
    result.reserved = false;
    // the check for the required field is done by the schema
    const field = Object.keys(params)[0];
    // username
    if (field === 'username') {
      if (await usersRepository.usernameExists(params[field])) {
        return next(errors.itemAlreadyExists('user', { username: params[field] }));
      }
    }
    // other unique fields
    const value = await platform.getLocalUsersUniqueField(field, params[field]);
    if (value != null) {
      return next(errors.itemAlreadyExists('user', { [field]: params[field] }));
    }
    next();
  }
  /**
   * Check with register service whether username is reserved
   * ⚠️ to be used only if dnsLess is NOT active.
   * @param {*} context
   * @param {*} params
   * @param {*} result
   * @param {*} next
   */
  async function checkUsername (context, params, result, next) {
    result.reserved = false;
    if (isDnsLess) {
      result.reserved = await usersRepository.usernameExists(params.username);
    } else {
      try {
        result.reserved = await platform.isUsernameReserved(params.username);
      } catch (error) {
        return next(errors.unexpectedError(error));
      }
    }
    if (result.reserved == null) {
      return next(errors.unexpectedError('usernamed reserved cannot be null'));
    }
    next();
  }
};
