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

const { getLogger, getConfig } = require('@pryv/boiler');
const logger = getLogger('platform');

const errors = require('errors').factory;

const { getServiceRegisterConn } = require('platform/src/service_register');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');

const DB = require('./DB');

const platformCheckIntegrity = require('./platformCheckIntegrity');

/**
 * @class Platform
 * @property {Users} users
 */
class Platform {
  #initialized;
  #db;
  #serviceRegisterConn;
  #config;

  constructor () {
    this.#initialized = false;
    this.#db = new DB();
  }

  async init () {
    if (this.#initialized) {
      logger.warn('Platform already initialized, skipping');
      return this;
    }
    this.initialized = true;
    this.#config = await getConfig();
    const isDnsLess = this.#config.get('dnsLess:isActive');
    await this.#db.init();
    if (!isDnsLess) {
      this.#serviceRegisterConn = await getServiceRegisterConn();
    }

    return this;
  }

  async checkIntegrity () {
    return await platformCheckIntegrity(this.#db);
  }

  /**
   * during tests forward to register might be activated and deactivated
   */
  #shouldForwardToRegister () {
    return this.#serviceRegisterConn != null && (process.env.NODE_ENV !== 'test' || !this.#config.get('testsSkipForwardToRegister'));
  }

  // for tests only - called by repository
  async deleteAll () {
    await this.#db.deleteAll();
  }

  /**
   * Get if value exists for this unique key (only test on local db)
   * Exposes directly a platform db method as it's needed by service_register in dnsLess mode
   */
  async getLocalUsersUniqueField (field, value) {
    return await this.#db.getUsersUniqueField(field, value);
  }

  /**
   * Use cases
   * a) When performing updateUserAndForward pre check if there are some uniqueness errors.
   * b) When creating a user, if a uniqueness error is username has been detected, we want to
   *    complete the error message with other eventual conflicts
   */
  async checkUpdateOperationUniqueness (username, operations) {
    const localUniquenessErrors = {};
    for (const op of operations) {
      if (op.action !== 'delete' && op.isUnique) {
        const value = await this.#db.getUsersUniqueField(op.key, op.value);
        if (value != null) localUniquenessErrors[op.key] = op.value;
      }
    }
    return localUniquenessErrors;
  }

  /**
   * @param {*} username
   * @param {*} operations
   * @param {*} isActive
   * @param {*} isCreation
   * @param {boolean} skipFowardToRegister - for tests only
   */
  async updateUserAndForward (username, operations, skipFowardToRegister = false) {
    // ** 1st check on local index before forwarding to register
    // This should be removed when platformWideDB will be implemented
    // This code is redundant with some check that will be performed by #updateUser after updating register

    const localUniquenessErrors = await this.checkUpdateOperationUniqueness(username, operations);
    if (Object.keys(localUniquenessErrors).length > 0) {
      throw (errors.itemAlreadyExists('user', localUniquenessErrors));
    }

    // ** Execute request on register
    if (!skipFowardToRegister && this.#shouldForwardToRegister()) {
      const ops2 = operations.map(op => {
        const action = op.action === 'delete' ? 'delete' : 'update';
        const isCreation = op.action === 'create';
        return { [action]: { key: op.key, value: op.value, isUnique: op.isUnique, isCreation, isActive: op.isActive } };
      });
      await this.#serviceRegisterConn.updateUserInServiceRegister(username, ops2);
    }
    // ** execute request locally
    await this.#updateUser(username, operations);
  }

  /**
   * @private as long as we don't use a distributed db.
   * @see updateUserAndForward to update an user
   * Replace updateUserInServiceRegister()
   * @param {*} key
   */
  async #updateUser (username, operations) {
    // otherwise deletion
    for (const op of operations) {
      switch (op.action) {
        case 'create':
          if (op.isUnique) {
            if (!op.isActive) break; // only change value of (active setting)
            const potentialCollisionUsername = await this.#db.getUsersUniqueField(op.key, op.value);
            if (potentialCollisionUsername !== null && potentialCollisionUsername !== username) {
              throw (errors.itemAlreadyExists('user', { [op.key]: op.value }));
            }
            await this.#db.setUserUniqueField(username, op.key, op.value);
          } else { // is Indexed
            await this.#db.setUserIndexedField(username, op.key, op.value);
          }
          break;

        case 'update':
          if (!op.isActive) break; // only change value of (active setting) -- figure out what it means ;)
          if (op.isUnique) {
            const existingUsernameValue = await this.#db.getUsersUniqueField(op.key, op.previousValue);
            if (existingUsernameValue !== null && existingUsernameValue === username) {
              // only delete eventual existing value if it is the same user
              await this.#db.deleteUserUniqueField(op.key, op.previousValue);
            }

            const potentialCollisionUsername = await this.#db.getUsersUniqueField(op.key, op.value);
            if (potentialCollisionUsername !== null && potentialCollisionUsername !== username) {
              throw (errors.itemAlreadyExists('user', { [op.key]: op.value }));
            }
            await this.#db.setUserUniqueField(username, op.key, op.value);
          } else { // is Indexed
            await this.#db.setUserIndexedField(username, op.key, op.value);
          }
          break;

        case 'delete':
          if (op.isUnique) {
            const existingValue = await this.#db.getUsersUniqueField(op.key, op.value);
            if (existingValue !== null && existingValue !== username) {
              throw (errors.forbidden('unique field ' + op.key + ' with value ' + op.value + ' is associated to another user'));
            }
            if (existingValue != null) {
              await this.#db.deleteUserUniqueField(op.key, op.value);
            }
          } else { // is Indexed
            await this.#db.deleteUserIndexedField(username, op.key);
          }
          break;

        default:
          throw new Error('Unknown action');
      }
    }
  }

  /**
   * Fully delete a user
   * @param {string} username
   * @param {[User]} User -- // for some tests User might be null
   * @param {boolean} skipFowardToRegister -- for fixtures
   */
  async deleteUser (username, user, skipFowardToRegister = false) {
    // unique fields
    const operations = [];
    if (user != null) { // cannot delete unique keys if user is null! (as the current value is needed)
      for (const field of SystemStreamsSerializer.getUniqueAccountStreamsIdsWithoutPrefix()) {
        operations.push({ action: 'delete', key: field, value: user[field], isUnique: true });
      }
    }

    // indexed fields
    for (const field of SystemStreamsSerializer.getIndexedAccountStreamsIdsWithoutPrefix()) {
      operations.push({ action: 'delete', key: field, isUnique: false });
    }

    await this.#updateUser(username, operations);

    // forward to register
    if (!skipFowardToRegister && this.#shouldForwardToRegister()) {
      const res = await this.#serviceRegisterConn.deleteUser(username);
      logger.debug('delete on register: ' + username, res);
    }
  }

  // ----------------  Simple abstractions for service register calls (to be removed)  ----------------

  /**
   * Check if username is available (FW to service register)
   */
  async isUsernameReserved (username) {
    if (this.#serviceRegisterConn) {
      const response = await this.#serviceRegisterConn.checkUsername(username);
      if (response.reserved === true) {
        return true;
      }
      return false;
    }
  }

  /**
   * Validate user and pre-register it (FW to service register)
   */
  async createUserStep1_ValidateUser (username, invitationToken, uniqueFields, hostname) {
    await this.#serviceRegisterConn.validateUser(username, invitationToken, uniqueFields, hostname);
  }

  /**
   * Validate user and pre-register it (FW to service register)
   */
  async createUserStep2_CreateUser (userData) {
    await this.#serviceRegisterConn.createUser(userData);
  }
}

module.exports = new Platform();
