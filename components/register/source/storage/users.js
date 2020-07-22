/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
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
 * 
 */
// @flow

/**
 * Extension of database.js dedicated to user management
 */

const db = require('../storage/database');
const async = require('async');
const lodash = require('lodash');
const logger = require('winston');
const messages = require('../utils/messages');
const domain = '.' + require('../config').get('dns:domain');

const info = require('../business/service-info');
const Pryv = require('pryv');

type GenericCallback<T> = (err?: ?Error, res: ?T) => mixed;
type Callback = GenericCallback<mixed>;

export type UserInformation = {
  id?: string,

  username: string,
  email: string,
  language: string,

  password: string,
  passwordHash: string,

  invitationToken: string,
  registeredTimestamp?: number,

  server?: string,
}

type CreateResult = {
  username: string,
  server: string,
  apiEndpoint: string
};

/**
 * Create (register) a new user
 * 
 * @param host the hosting for this user
 * @param user the user data, a json object containing: username, password hash, language and email
 * @param callback function(error,result), result being a json object containing new user data
 */
exports.create = function create(host, inUser: UserInformation, callback: GenericCallback<CreateResult>) {
  const user = lodash.clone(inUser);

  // We store usernames and emails as lower case, allowing comparison with any
  // other lowercase string.
  user.username = user.username.toLowerCase();
  user.email = user.email.toLowerCase();

  // Construct the request for core, including the password. 
  const request = {
    username: user.username,
    passwordHash: user.passwordHash,
    language: user.language,
    email: user.email
  };

  // Remove to forget the password
  delete user.passwordHash;
  delete user.password;

  db.createUser(request, function (error, result) {
    if (error) return callback(error, null);
    if (! result || !result.id) return callback(new Error('Invalid answer from core'), null);
    callback(error, {
      username: user.username,
      server: user.username + domain,
      apiEndpoint: Pryv.Service.buildAPIEndpoint(info, user.username, null),
    });
  });
};

type ServerUsageStats = {
  [name: string]: number
};

/**
 * Get a list of users on a specific server
 * @param serverName: the name of the server
 * @param callback: function(error, result), result being an array of users
 */
exports.getUsersOnServer = function (serverName: string, callback: Callback) {
  getAllUsersInfos(callback);
};

/**
 * Get a list of all user's information (see getUserInfos)
 * @param callback: function(error, result), result being a list of information for all users
 */
function getAllUsersInfos (callback: GenericCallback<Array<UserInformation>>) {
  db.getAllUsers(callback);
};
exports.getAllUsersInfos = getAllUsersInfos;