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

const urllib = require('url');
const superagent = require('superagent');
const ErrorIds = require('errors').ErrorIds;
const errors = require('errors').factory;
const ErrorMessages = require('errors/src/ErrorMessages');

type OperationType = 'update' | 'delete';
type AccountProperty = string;
type Value = string;
type Operation = {
  [OperationType]: {
    key: AccountProperty,
    value: Value,
    isUnique: ?boolean,
  },
};

const { getLogger, getConfigUnsafe, notifyAirbrake } = require('@pryv/boiler');
class ServiceRegister {
  config: {}; 
  logger: {};

  constructor(config: {}) {
    this.config = config; 
    this.logger = getLogger('service-register');
    this.logger.debug('created with config', config);
  }

  async validateUser (
    username: String,
    invitationToken: String,
    uniqueFields: Object,
    core: String,
  ): Promise<void> {
    const url = buildUrl('/users/validate', this.config.url);
    // log fact about the event
    this.logger.info(`POST ${url} for username: ${username}`);
    try {
      await superagent
        .post(url)
        .set('Authorization', this.config.key)
        .send({ 
          username: username,
          invitationToken: invitationToken,
          uniqueFields: uniqueFields,
          core: core
        });
    } catch (err) {
      if(((err.status == 409) || (err.status == 400)) && err?.response?.body?.error){
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

  async checkUsername(username: string): Promise<any> {
    const url = buildUrl(`/${username}/check_username`, this.config.url);
    // log fact about the event
    this.logger.info(`GET ${url} for username: ${username}`);
    try {
      const res = await superagent
        .get(url);
      return res.body;
    } catch (err) {
      if (err?.response?.body?.reserved === true) {
        return err.response.body;
      }
      this.logger.error(err, err);
      throw new Error(err.message || 'Unexpected error.');
    }
  }

  async createUser(user): Promise<void> {
    const url = buildUrl('/users', this.config.url);
    // log fact about the event
    this.logger.info(`POST ${url} for username:${user.user.username}`);
    try {
      const res = await superagent
        .post(url)
        .set('Authorization', this.config.key)
        .send(user);     
      return res.body;
    } catch (err) {
      this.logger.error(err, err);
      throw new Error(err.message || 'Unexpected error.');
    }
  }

  async deleteUser(username): Promise<void> {
    const url = buildUrl('/users/' + username + '?onlyReg=true', this.config.url);
    // log fact about the event
    this.logger.info(`DELETE ${url} for username:${username}`);
    try {
      const res = await superagent
        .delete(url)
        .set('Authorization', this.config.key);     
      return res.body;
    } catch (err) {
      this.logger.error(err, err);
      throw new Error(err.message || 'Unexpected error.');
    }
  }

  /**
   * After indexed fields are updated, service-register is notified to update
   * the information
   */
  async updateUserInServiceRegister (
    username: string,
    operations: Array<Operation>,
    isActive: boolean,
    isCreation: boolean
  ): Promise<void> {
    const url = buildUrl('/users', this.config.url);
    this.logger.info(`PUT ${url} for username:${username}`);

    // otherwise deletion
    const isUpdate: boolean = operations[0].update != null;
    const operationType: OperationType = isUpdate ? 'update' : 'delete';

    const fieldsForUpdate: {} = {}; // sent as user in payload
    const fieldsToDelete: {} = {};
    const updateParams: {} = {};

    if (isUpdate) {
      operations.forEach(operation => {
        const streamIdWithoutPrefix: string = operation.update.key;
        fieldsForUpdate[streamIdWithoutPrefix] = [
          {
            value: operation.update.value,
            isUnique: operation.update.isUnique,
            isActive,
            creation: isCreation,
          }
        ];
        updateParams[operation[operationType].key] = operation[operationType].value;
      });
    } else { // isDelete
      operations.forEach(operation => {
        const streamIdWithoutPrefix: string = operation.delete.key;
        fieldsToDelete[streamIdWithoutPrefix] = operation.delete.value;
        updateParams[operation[operationType].key] = operation[operationType].value;
      });
    }

    const payload: {} = {
      username,
      user: fieldsForUpdate,
      fieldsToDelete,
    }

    try {
      const res = await superagent.put(url)
        .send(payload)
        .set('Authorization', this.config.key);
      return res.body;
    } catch (err) {
      if (((err.status == 400) || (err.status == 409)) && err.response.body.error != null) {
        if (err.response.body.error.id === ErrorIds.ItemAlreadyExists) {
          throw errors.itemAlreadyExists('user', safetyCleanDuplicate(err.response.body.error.data, username, updateParams));
        } else {
          this.logger.error(err.response.body.error, err);
          throw errors.unexpectedError(err.response.body.error);
        }
      } if (err.status == 400 && err.response.body?.user === null) {
        // do not throw any error if no data was updated (double click for updating the event)
        this.logger.error('No data was updated');
      }else{
        // do not log validation errors
        this.logger.error(err, err);
        throw errors.unexpectedError(new Error(err.message || 'Unexpected error.'));
      }
    }
  }
}

function buildUrl(path: string, url): URL {
  return new urllib.URL(path, url);
}

let serviceRegisterConn = null;
/**
 * @returns {ServiceRegister}
 */
function getServiceRegisterConn() {
  if (! serviceRegisterConn) {
    serviceRegisterConn = new ServiceRegister(getConfigUnsafe().get('services:register'))
  }
  return serviceRegisterConn;
}

 /**
   * Temporary solution to patch a nasty bug, where "random" emails are exposed during account creations 
   * @param {object} foundDuplicates the duplicates to check
   * @param {string} username 
   * @param {object} params 
   */
  function safetyCleanDuplicate(foundDuplicates, username, params: {}): {} {
    if (foundDuplicates == null) return foundDuplicates;
    const res: {} = {};
    const newParams: {} = Object.assign({}, params);
    if (username != null) newParams.username = username; 
    for (const key of Object.keys(foundDuplicates)) {
      if (foundDuplicates[key] === newParams[key]) {
        res[key] = foundDuplicates[key] ;
      } else {
        notify(key + ' "' + foundDuplicates[key] + '" <> "' + newParams[key] + '"');
      }
    }
    return res;

    function notify(key) {
      const logger = getLogger('service-register'); 
      const error = new Error('Found unmatching duplicate key: ' + key);
      logger.error('To be investigated >> ', error);
      notifyAirbrake(error);
    }
  }

module.exports = {
  getServiceRegisterConn,
  safetyCleanDuplicate,
};
