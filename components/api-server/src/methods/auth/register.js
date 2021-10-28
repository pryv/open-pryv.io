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
const _ = require('lodash');
const commonFns = require('./../helpers/commonFunctions');
const errors = require('errors').factory;
const { ErrorMessages, ErrorIds } = require('errors');
const methodsSchema = require('api-server/src/schema/authMethods');
const { getServiceRegisterConn } = require('business/src/auth/service_register');
const Registration = require('business/src/auth/registration');
const { getUsersRepository } = require('business/src/users');
const { getConfigUnsafe } = require('@pryv/boiler');
const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils');
const { getLogger, getConfig } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');

import type { MethodContext } from 'business';
import type Result  from '../Result';
import type { ApiCallback }  from '../API';

/**
 * Auth API methods implementations.
 *
 * @param api
 */
module.exports = async function (api) {
  const config = await getConfig();
  const logging = await getLogger('register');
  const storageLayer = await getStorageLayer();
  const servicesSettings = config.get('services')
  const isDnsLess = config.get('dnsLess:isActive');

  // REGISTER
  const registration: Registration = new Registration(logging, storageLayer, servicesSettings);
  const serviceRegisterConn: ServiceRegister = getServiceRegisterConn();
  const usersRepository = await getUsersRepository(); 

  function skip(context, params, result, next) { next(); }
  function ifDnsLess(ifTrue, ifFalse) {
    if (isDnsLess) {
      return ifTrue || skip;
    } 
    return ifFalse || skip;
  }

  api.register('auth.register',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    // data validation methods        
    commonFns.getParamsValidation(methodsSchema.register.params),
    registration.prepareUserData,
    ifDnsLess(skip, registration.validateUserInServiceRegister.bind(registration)),
    //user registration methods
    ifDnsLess(skip, registration.deletePartiallySavedUserIfAny.bind(registration)),
    registration.createUser.bind(registration),
    ifDnsLess(skip, registration.createUserInServiceRegister.bind(registration)),
    registration.buildResponse.bind(registration),
    registration.sendWelcomeMail.bind(registration),
  );
  
  // Username check
  /**
   * Seem to be use only in dnsLess..  
   */
  api.register('auth.usernameCheck',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    commonFns.getParamsValidation(methodsSchema.usernameCheck.params),
    ifDnsLess(checkUniqueField, checkUsername)
  );


  //
  /**
   * DNSLess Only
   */
  api.register('auth.emailCheck',
    setAuditAccessId(AuditAccessIds.PUBLIC),
    commonFns.getParamsValidation(methodsSchema.emailCheck.params),
    checkUniqueField
  );

  /**
   * Check in service-register if user id is reserved
   * !ONLY DnsLess = true
   * @param {*} context 
   * @param {*} params 
   * @param {*} result 
   * @param {*} next 
   */
  async function checkUniqueField(context: MethodContext, params: mixed, result: Result, next: ApiCallback) {
    result.reserved = false;
    // the check for the required field is done by the schema
    const field = Object.keys(params)[0];
    try {
      await usersRepository.checkDuplicates({ [field]: params[field]});
    } catch (error) {
      return next(error);
    }
    next();
  }



  /**
   * Check in service-register if user id is reserved
   * !ONLY DnsLess = false
   * @param {*} context 
   * @param {*} params 
   * @param {*} result 
   * @param {*} next 
   */
  async function checkUsername(context: MethodContext, params: mixed, result: Result, next: ApiCallback) {
    result.reserved = false;
    try {
      const response = await serviceRegisterConn.checkUsername(params.username);

      if (response.reserved === true) {
        return next(errors.itemAlreadyExists('user', { username: params.username }));
      }else if (response.reserved != null) {
        result.reserved = false;
      }
      
    } catch (error) {
      return next(errors.unexpectedError(error));
    }
    next();
  }

};