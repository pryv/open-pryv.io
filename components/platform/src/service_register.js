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
const urllib = require('url');
const superagent = require('superagent');
const ErrorIds = require('errors').ErrorIds;
const errors = require('errors').factory;
const ErrorMessages = require('errors/src/ErrorMessages');
const { getLogger, getConfig } = require('@pryv/boiler');

class ServiceRegister {
  settings;

  logger;
  constructor () {
    this.logger = getLogger('service-register');
    this.settings = null;
  }

  /**
   * @returns {Promise<this>}
   */
  async init () {
    if (this.settings == null) {
      this.settings = (await getConfig()).get('services:register');
      this.logger.debug('created with setttings:', this.settings);
    }
    return this;
  }

  /**
   * @param {String} username
   * @param {String} invitationToken
   * @param {any} uniqueFields
   * @param {String} core
   * @returns {Promise<void>}
   */
  async validateUser (username, invitationToken, uniqueFields, core) {
    const url = buildUrl('/users/validate', this.settings.url);
    // log fact about the event
    this.logger.info(`POST ${url} for username: ${username}`);
    try {
      await superagent.post(url).set('Authorization', this.settings.key).send({
        username,
        invitationToken,
        uniqueFields,
        core
      });
    } catch (err) {
      if ((err.status === 409 || err.status === 400) &&
                err?.response?.body?.error) {
        if (err.response.body.error != null) {
          if (err.response.body.error.id === ErrorIds.InvalidInvitationToken) {
            throw errors.invalidOperation(ErrorMessages.InvalidInvitationToken);
          } else if (err.response.body.error.id === ErrorIds.ItemAlreadyExists) {
            const duplicatesSafe = safetyCleanDuplicate(err.response.body.error.data, username, uniqueFields);
            throw errors.itemAlreadyExists('user', duplicatesSafe);
          } else {
            throw errors.unexpectedError(err.response.body.error);
          }
        }
      }
      // do not log validation errors
      this.logger.error(err, err);
      throw errors.unexpectedError(new Error(err.message || 'Unexpected error.'));
    }
  }

  /**
   * @param {string} username
   * @returns {Promise<any>}
   */
  async checkUsername (username) {
    const url = buildUrl(`/${username}/check_username`, this.settings.url);
    // log fact about the event
    this.logger.info(`GET ${url} for username: ${username}`);
    try {
      const res = await superagent.get(url);
      return res.body;
    } catch (err) {
      if (err?.response?.body?.reserved === true) {
        return err.response.body;
      }
      this.logger.error(err, err);
      throw new Error(err.message || 'Unexpected error.');
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async createUser (user) {
    const url = buildUrl('/users', this.settings.url);
    // log fact about the event
    this.logger.info(`POST ${url} for username:${user.user.username}`);
    try {
      const res = await superagent
        .post(url)
        .set('Authorization', this.settings.key)
        .send(user);
      return res.body;
    } catch (err) {
      this.logger.error(err, err);
      throw new Error(err.message || 'Unexpected error.');
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async deleteUser (username) {
    const url = buildUrl('/users/' + username + '?onlyReg=true', this.settings.url);
    // log fact about the event
    this.logger.info(`DELETE ${url} for username:${username}`);
    try {
      const res = await superagent
        .delete(url)
        .set('Authorization', this.settings.key);
      return res.body;
    } catch (err) {
      this.logger.error(err, err);
      throw new Error(err.message || 'Unexpected error.');
    }
  }

  /**
   * After indexed fields are updated, service-register is notified to update
   * the information
   * @param {string} username
   * @param {Array<Operation>} operations
   * @returns {Promise<void>}
   */
  async updateUserInServiceRegister (username, operations) {
    const url = buildUrl('/users', this.settings.url);
    this.logger.info(`PUT ${url} for username:${username}`);
    // otherwise deletion
    const isUpdate = operations[0].update != null;
    const operationType = isUpdate ? 'update' : 'delete';
    const fieldsForUpdate = {}; // sent as user in payload
    const fieldsToDelete = {};
    const updateParams = {};
    if (isUpdate) {
      operations.forEach((operation) => {
        const streamIdWithoutPrefix = operation.update.key;
        fieldsForUpdate[streamIdWithoutPrefix] = [
          {
            value: operation.update.value,
            isUnique: operation.update.isUnique,
            isActive: operation.update.isActive || false,
            creation: operation.update.isCreation
          }
        ];
        updateParams[operation[operationType].key] =
                    operation[operationType].value;
      });
    } else {
      // isDelete
      operations.forEach((operation) => {
        const streamIdWithoutPrefix = operation.delete.key;
        fieldsToDelete[streamIdWithoutPrefix] = operation.delete.value;
        updateParams[operation[operationType].key] =
                    operation[operationType].value;
      });
    }
    const payload = {
      username,
      user: fieldsForUpdate,
      fieldsToDelete
    };
    try {
      const res = await superagent
        .put(url)
        .send(payload)
        .set('Authorization', this.settings.key);
      return res.body;
    } catch (err) {
      if ((err.status === 400 || err.status === 409) &&
                err.response.body.error != null) {
        if (err.response.body.error.id === ErrorIds.ItemAlreadyExists) {
          throw errors.itemAlreadyExists('user', safetyCleanDuplicate(err.response.body.error.data, username, updateParams));
        } else {
          this.logger.error(err.response.body.error, err);
          throw errors.unexpectedError(err.response.body.error);
        }
      }
      if (err.status === 400 && err.response.body?.user === null) {
        // do not throw any error if no data was updated (double click for updating the event)
        this.logger.error('No data was updated');
      } else {
        // do not log validation errors
        this.logger.error(err, err);
        throw errors.unexpectedError(new Error(err.message || 'Unexpected error.'));
      }
    }
  }
}
/**
 * @param {string} path
 * @returns {URL}
 */
function buildUrl (path, url) {
  return new urllib.URL(path, url);
}
let serviceRegisterConn = null;
/**
 * @returns {Promise<any>}
 */
async function getServiceRegisterConn () {
  if (!serviceRegisterConn) {
    serviceRegisterConn = new ServiceRegister();
    await serviceRegisterConn.init();
  }
  return serviceRegisterConn;
}
/**
 * Temporary solution to patch a nasty bug, where "random" emails are exposed during account creations
 * @param {object} foundDuplicates the duplicates to check
 * @param {string} username
 * @param {{}} params  undefined
 * @returns {{}}
 */
function safetyCleanDuplicate (foundDuplicates, username, params) {
  if (foundDuplicates == null) { return foundDuplicates; }
  const res = {};
  const newParams = structuredClone(params);
  if (username != null) { newParams.username = username; }
  for (const key of Object.keys(foundDuplicates)) {
    if (foundDuplicates[key] === newParams[key]) {
      res[key] = foundDuplicates[key];
    } else {
      notify(key + ' "' + foundDuplicates[key] + '" <> "' + newParams[key] + '"');
    }
  }
  return res;
  function notify (key) {
    const logger = getLogger('service-register');
    const error = new Error('Found unmatching duplicate key: ' + key);
    logger.error('To be investigated >> ', error);
  }
}
module.exports = {
  getServiceRegisterConn,
  safetyCleanDuplicate
};

/** @typedef {'update' | 'delete'} OperationType */

/** @typedef {string} AccountProperty */

/** @typedef {string} Value */

/**
 * @typedef {{
 *   [k in OperationType]: {
 *     key: AccountProperty;
 *     value: Value;
 *     isUnique: boolean | undefined | null;
 *     isActive: boolean | undefined | null;
 *     isCreation: boolean | undefined | null;
 *   };
 * }} Operation
 */
