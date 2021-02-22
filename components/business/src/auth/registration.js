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
// @flow

const _ = require('lodash');
const cuid = require('cuid');
const errors = require('errors').factory;
const { errorHandling } = require('errors');
const mailing = require('api-server/src/methods/helpers/mailing');
const { getServiceRegisterConn, safetyCleanDuplicate } = require('./service_register');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const UsersRepository = require('business/src/users/repository');
const User = require('business/src/users/User');
const ErrorIds = require('errors').ErrorIds;

const { getLogger } = require('@pryv/boiler');

import type { MethodContext } from 'model';
import type { ApiCallback } from 'api-server/src/API';

/**
 * Create (register) a new user
 */
class Registration {
  logger: any;
  storageLayer: any;
  serviceRegisterConn: ServiceRegister;
  usersRepository: UsersRepository; 
  accountStreamsSettings: any = SystemStreamsSerializer.getFlatAccountStreamSettings();
  servicesSettings: any; // settigns to get the email to send user welcome email

  constructor(logging, storageLayer, servicesSettings) {
    this.logger = getLogger('business:registration');
    this.storageLayer = storageLayer;
    this.servicesSettings = servicesSettings;

    this.serviceRegisterConn = getServiceRegisterConn();
    this.usersRepository = new UsersRepository(
      this.storageLayer.events,
      this.storageLayer.sessions,
      this.storageLayer.accesses
    );
  }

  /**
   * Do minimal manipulation with data like username conversion to lowercase
   * @param {*} context 
   * @param {*} params 
   * @param {*} result 
   * @param {*} next 
   */
   async prepareUserData(context: MethodContext, params: mixed, result: Result, next: ApiCallback) {
    context.user = new User(params);
    next();
  }

  /**
   * Validation and reservation in service-register
   * @param {*} context
   * @param {*} params
   * @param {*} result
   * @param {*} next
   */
  async validateUserInServiceRegister(
    context: MethodContext,
    params: mixed,
    result: Result,
    next: ApiCallback
  ) {
    try {
      let uniqueFields = {};
      for (const [streamIdWithDot, streamSettings] of Object.entries(this.accountStreamsSettings)) {
        // if key is set as required - add required validation
        if (streamSettings?.isUnique === true) {
          let streamIdWithoutDot = SystemStreamsSerializer.removeDotFromStreamId(streamIdWithDot)
          uniqueFields[streamIdWithoutDot] = context.user[streamIdWithoutDot];
        }
      }
      
      // do the validation and reservation in service-register
      await this.serviceRegisterConn.validateUser(
        context.user.username,
        context.user.invitationToken,
        uniqueFields,
        context.host
      );
    } catch (error) {
      return next(error);
    }
    next();
  }

  /**
   * Check in service-register if email already exists
   * @param {*} context
   * @param {*} params
   * @param {*} result
   * @param {*} next
   */
  async deletePartiallySavedUserIfAny(
    context: MethodContext,
    params: mixed,
    result: Result,
    next: ApiCallback
  ) {
    try {
      // assert that we have obtained a lock on register, so any conflicting fields here 
      // would be failed registration attempts that partially saved user data.
      const existingUsers = await this.usersRepository.findExistingUniqueFields(context.user.getUniqueFields());

      // if any of unique fields were already saved, it means that there was an error
      // saving in service register (before this step there is a check that unique fields 
      // don't exist in service register)

      if (existingUsers.length > 0) {
        // DELETE users with conflicting unique properties
        let userIds = existingUsers.map(conflictingEvent => conflictingEvent.userId);
        const distinctUserIds = new Set(userIds);

        for (let userId of distinctUserIds){
          // assert that unique fields are free to take
          // so if we get conflicting ones here, we can simply delete them
          await this.usersRepository.deleteOne(userId);

          this.logger.error(
            `User with id ${
            userId
            } was deleted because it was not found on service-register but uniqueness conflicted on service-core`
          );
        }
      }
    } catch (error) {
      return next(errors.unexpectedError(error));
    }
    next();
  }

  /**
   * DEPRECATED
   * @param {*} context 
   * @param {*} params 
   * @param {*} result 
   * @param {*} next 
   */
  createPoolUser (context, params, result, next) {
    const POOL_USERNAME_PREFIX = 'pool@';
    const uniqueId = cuid();
    params.username = POOL_USERNAME_PREFIX + uniqueId;
    params.passwordHash = 'changeMe';
    params.language = 'en';
    params.email = POOL_USERNAME_PREFIX + uniqueId + '@email';
    context.user = new User(params);
    next();
  }

  /**
   * Save user to the database
   * Pool user is not consumed anymore
   * @param {*} context 
   * @param {*} params 
   * @param {*} result 
   * @param {*} next 
   */
  async createUser(
    context: MethodContext,
    params: mixed,
    result,
    next: ApiCallback
  ) {
    // if it is testing user, skip registration process
    if (context.user.username === 'recla') {
      result.id = 'dummy-test-user';
      context.user.id = result.id;
      return next();
    }

    try {
      const createUserWithSession = (context.calledMethodId === 'system.createPoolUser') ? false : true;
      context.user = await this.usersRepository.insertOne(context.user, createUserWithSession);
    } catch (err) {
      return next(Registration.handleUniquenessErrors(
        err,
        ErrorIds.UnexpectedError,
        params
      ));
    }
    next();
  }


  /**
   * Save user in service-register
   * @param {*} context
   * @param {*} params
   * @param {*} result
   * @param {*} next
   */
  async createUserInServiceRegister (
    context: MethodContext,
    params: mixed,
    result: Result,
    next: ApiCallback
  ) {
    try {
      // get streams ids from the config that should be retrieved
      const userStreamsIds = SystemStreamsSerializer.getIndexedAccountStreamsIdsWithoutDot();

      // build data that should be sent to service-register
      // some default values and indexed/uinique fields of the system
      const userData = {
        user: {
          id: context.user.id
        },
        host: { name: context.host },
        unique: SystemStreamsSerializer.getUniqueAccountStreamsIdsWithoutDot()
      };
      userStreamsIds.forEach(streamId => {
        if (context.user[streamId] != null) userData.user[streamId] = context.user[streamId];
      });

      await this.serviceRegisterConn.createUser(userData);
    } catch (error) {
      return next(errors.unexpectedError(error));
    }
    next();
  }
  
  /**
   * Build response for user registration
   * @param {*} context 
   * @param {*} params 
   * @param {*} result 
   * @param {*} next 
   */
  async buildResponse (
    context: MethodContext,
    params: mixed,
    result: Result,
    next: ApiCallback
  ) {
    result.username = context.user.username;
    result.apiEndpoint = context.user.getApiEndpoint();
    next();
  }
  /**
   *
   * @param {*} context
   * @param {*} params
   * @param {*} result
   * @param {*} next
   */
  sendWelcomeMail(
    context: MethodContext,
    params: mixed,
    result: Result,
    next: ApiCallback
  ) {
    
    const emailSettings = this.servicesSettings.email;
   
    // Skip this step if welcome mail is deactivated
    const emailActivation = emailSettings.enabled;
    if (emailActivation?.welcome === false) {
      return next();
    }

    const recipient = {
      email: context.user.email,
      name: context.user.username,
      type: 'to'
    };

    const substitutions = {
      USERNAME: context.user.username,
      EMAIL: context.user.email
    };

    mailing.sendmail(
      emailSettings,
      emailSettings.welcomeTemplate,
      recipient,
      substitutions,
      context.user.language,
      err => {
        // Don't fail creation process itself (mail isn't critical), just log error
        if (err) {
          errorHandling.logError(err, null, this.logger);
        }
        next();
      }
    );
  }

  /**
   * Build errors for api response
   * @param {*} err
   * @param {*} params
   */
  static handleUniquenessErrors (err, message, params) {
    // Duplicate errors
    const uniquenessErrors = {};
    if (err.isDuplicate) {
      let fieldName = err.getDuplicateSystemStreamId();
      uniquenessErrors[fieldName] = params[fieldName];     
    }

    if (Object.keys(uniquenessErrors).length > 0) {
      return errors.itemAlreadyExists('user', safetyCleanDuplicate(uniquenessErrors, null, params));
    }
    // Any other error
    return errors.unexpectedError(err, message);
  }
}

module.exports = Registration;
