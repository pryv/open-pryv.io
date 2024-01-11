/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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

const errors = require('errors').factory;
const { errorHandling } = require('errors');
const mailing = require('api-server/src/methods/helpers/mailing');
const { getPlatform } = require('platform');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const { getUsersRepository, User } = require('business/src/users');
const { getLogger } = require('@pryv/boiler');
const { ApiEndpoint } = require('utils');

/**
 * Create (register) a new user
 */
class Registration {
  logger;

  storageLayer;
  /** @default SystemStreamsSerializer.getAccountMap() */
  accountStreamsSettings = SystemStreamsSerializer.getAccountMap();

  servicesSettings; // settigns to get the email to send user welcome email

  platform;
  constructor (logging, storageLayer, servicesSettings) {
    this.logger = getLogger('business:registration');
    this.storageLayer = storageLayer;
    this.servicesSettings = servicesSettings;
  }

  /**
   * @returns {Promise<this>}
   */
  async init () {
    if (this.platform == null) {
      this.platform = await getPlatform();
    }
    return this;
  }

  /**
   * Do minimal manipulation with data like username conversion to lowercase
   * @param {MethodContext} context  undefined
   * @param {unknown} params  undefined
   * @param {Result} result  undefined
   * @param {ApiCallback} next  undefined
   * @returns {Promise<void>}
   */
  async prepareUserData (context, params, result, next) {
    context.newUser = new User(params);
    // accept passwordHash at creation only; TODO: remove this once deprecated method `system.createUser` is removed
    context.newUser.passwordHash = params.passwordHash;
    context.user = {
      id: context.newUser.id,
      username: context.newUser.username
    };
    next();
  }

  /**
   * Validation and reservation in service-register
   * @param {MethodContext} context  undefined
   * @param {unknown} params  undefined
   * @param {Result} result  undefined
   * @param {ApiCallback} next  undefined
   * @returns {Promise<any>}
   */
  async createUserStep1_ValidateUserOnPlatform (context, params, result, next) {
    try {
      const uniqueFields = { username: context.newUser.username };
      for (const [streamIdWithPrefix, streamSettings] of Object.entries(this.accountStreamsSettings)) {
        // if key is set as required - add required validation
        if (streamSettings?.isUnique) {
          const streamIdWithoutPrefix = SystemStreamsSerializer.removePrefixFromStreamId(streamIdWithPrefix);
          uniqueFields[streamIdWithoutPrefix] =
                        context.newUser[streamIdWithoutPrefix];
        }
      }
      // do the validation and reservation in service-register
      await this.platform.createUserStep1_ValidateUser(context.newUser.username, context.newUser.invitationToken, uniqueFields, context.host);
    } catch (error) {
      return next(error);
    }
    next();
  }

  /**
   * Check in service-register if email already exists
   * @param {MethodContext} context  undefined
   * @param {unknown} params  undefined
   * @param {Result} result  undefined
   * @param {ApiCallback} next  undefined
   * @returns {Promise<any>}
   */
  async deletePartiallySavedUserIfAny (context, params, result, next) {
    try {
      // assert that we have obtained a lock on register, so any conflicting fields here
      // would be failed registration attempts that partially saved user data.
      const usersRepository = await getUsersRepository();
      const matchingUserId = await usersRepository.getUserIdForUsername(context.newUser.username);
      if (matchingUserId != null) {
        await usersRepository.deleteOne(matchingUserId);
        this.logger.error(`User with id ${matchingUserId} was deleted because it was not found on service-register but uniqueness conflicted on service-core`);
      }
    } catch (error) {
      return next(errors.unexpectedError(error));
    }
    next();
  }

  /**
   * Save user to the database
   * @param {MethodContext} context  undefined
   * @param {unknown} params  undefined
   * @param {*} result
   * @param {ApiCallback} next  undefined
   * @returns {Promise<any>}
   */
  async createUser (context, params, result, next) {
    // if it is testing user, skip registration process
    if (context.newUser.username === 'recla') {
      result.id = 'dummy-test-user';
      context.newUser.id = result.id;
      context.user.username = context.newUser.username;
      return next();
    }
    try {
      const usersRepository = await getUsersRepository();
      await usersRepository.insertOne(context.newUser, true);
    } catch (err) {
      return next(err);
    }
    next();
  }

  /**
   * Save user in service-register
   * @param {MethodContext} context  undefined
   * @param {unknown} params  undefined
   * @param {Result} result  undefined
   * @param {ApiCallback} next  undefined
   * @returns {Promise<any>}
   */
  async createUserStep2_CreateUserOnPlatform (context, params, result, next) {
    try {
      // get streams ids from the config that should be retrieved
      const userStreamsIds = SystemStreamsSerializer.getIndexedAccountStreamsIdsWithoutPrefix();
      // build data that should be sent to service-register
      // some default values and indexed/uinique fields of the system
      const userData = {
        user: {
          id: context.newUser.id,
          username: context.newUser.username
        },
        host: { name: context.host },
        unique: [
          'username',
          ...SystemStreamsSerializer.getUniqueAccountStreamsIdsWithoutPrefix()
        ]
      };
      userStreamsIds.forEach((streamId) => {
        if (context.newUser[streamId] != null) { userData.user[streamId] = context.newUser[streamId]; }
      });
      await this.platform.createUserStep2_CreateUser(userData);
    } catch (error) {
      return next(errors.unexpectedError(error));
    }
    next();
  }

  /**
   * Build response for user registration
   * @param {MethodContext} context  undefined
   * @param {unknown} params  undefined
   * @param {Result} result  undefined
   * @param {ApiCallback} next  undefined
   * @returns {Promise<void>}
   */
  async buildResponse (context, params, result, next) {
    result.username = context.newUser.username;
    result.apiEndpoint = ApiEndpoint.build(context.newUser.username, context.newUser.token);
    next();
  }

  /**
   *
   * @param {MethodContext} context  undefined
   * @param {unknown} params  undefined
   * @param {Result} result  undefined
   * @param {ApiCallback} next  undefined
   * @returns {any}
   */
  sendWelcomeMail (context, params, result, next) {
    const emailSettings = this.servicesSettings.email;
    // Skip this step if welcome mail is deactivated
    const emailActivation = emailSettings.enabled;
    if (emailActivation?.welcome === false) {
      return next();
    }
    const recipient = {
      email: context.newUser.email,
      name: context.newUser.username,
      type: 'to'
    };
    const substitutions = {
      USERNAME: context.newUser.username,
      EMAIL: context.newUser.email
    };
    mailing.sendmail(emailSettings, emailSettings.welcomeTemplate, recipient, substitutions, context.newUser.language, (err) => {
      // Don't fail creation process itself (mail isn't critical), just log error
      if (err) {
        errorHandling.logError(err, null, this.logger);
      }
    });
    next();
  }
}
module.exports = Registration;
