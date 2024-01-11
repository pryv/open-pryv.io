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
const { getUsersRepository } = require('business/src/users/repository');
const { getPlatform } = require('platform');
let platform = null;
let usersRepository = null;

exports.init = async function init() {
  platform = await getPlatform();
  usersRepository = await getUsersRepository();
}

/**
 * Check if an email address exists in the database
 * @param {string} email  : the email address to verify
 * @param {GenericCallback<boolean>} callback  : function(error,result), result being 'true' if it exists, 'false' otherwise
 * @returns {void}
 */
function emailExists(email, callback) {
  email = email.toLowerCase();
  getUIDFromMail(email, function (error, username) {
    callback(error, username !== null);
  });
}
exports.emailExists = emailExists;
/**
 * Check if an user id exists in the database
 * @param uid: the user id to verify
 * @param callback: function(error,result), result being 'true' if it exists, 'false' otherwise
 */
exports.uidExists = async function (uid, callback) {
  try {
    const username = uid.toLowerCase();
    const exists = await usersRepository.usernameExists(username);
    return callback(null, exists);
  } catch (err) {
    return callback(err);
  }
};
/**
 * Get the server linked with provided user id
 * @param uid: the user id
 * @param callback: function(error,result), result being the server name
 */
exports.getServer = function (uid, callback) {
  return callback(null, 'SERVER_NAME');
};
/**
 * Get user id linked with provided email address
 * @param {string} mail  : the email address
 * @param {GenericCallback<string>} callback  : function(error,result), result being the requested user id
 * @returns {void}
 */
async function getUIDFromMail(mail, callback) {
  try {
    const cleanmail = mail.toLowerCase();
    platform.getLocalUsersUniqueField('email', cleanmail).then(
      (result) => { callback(null, result); },
      (error) => { callback(error, null); }
    );
  } catch (err) {
    return callback(err, null);
  }
}
exports.getUIDFromMail = getUIDFromMail;
/**
 * Get all users
 * @returns {Users[]}
 */
async function getAllUsers() {
  // we are missing here 'server' and 'referer'
  const usersNamesAndIds = await usersRepository.getAllUsersIdAndName();
  const result = [];
  for(const userNameAndId of usersNamesAndIds) {
    const user = await usersRepository.getUserById(userNameAndId.id);
    if (user == null) {
      console.log('XXXXX Null user', userNameAndId);
    } else {
      const userAccountInfos = user.getFullAccount();
      let registeredTimestamp = Number.MAX_SAFE_INTEGER;
      // deduct creation data from smallest ceatedAt date in event
      for (const event of user.events) {
        if (event.created < registeredTimestamp) registeredTimestamp = event.created;
      }
      const userInfos = Object.assign({ id: userNameAndId.id, username: userNameAndId.username , registeredTimestamp }, userAccountInfos);
      result.push(userInfos);
    }
  }
  return result;
}
exports.getAllUsers = getAllUsers;
const dbAccessState = {};
/**
 * Update the state of an access in the database
 * @param key: the database key for this access
 * @param value: the new state of this access
 * @param callback: function(error,result), result being the result of the database transaction
 */
exports.setAccessState = function (key, value, callback) {
  dbAccessState[key] = { value: value, time: Date.now() };
  callback(null, value); // callback anyway
};
/** Get the current state of an access in the database.
 *
 * @param key {string} - the database key for this access
 * @param callback {nodejsCallback} - result being the corresponding JSON
 *    database entry
 */
exports.getAccessState = function (key, callback) {
  const res = dbAccessState[key];
  callback(null, res ? res.value : null);
};
/**
 * Timer to autoclean dbAccessState
 * @returns {void}
 */
function cleanAccessState() {
  const expired = Date.now() - 60 * 10 * 1000; // 10 minutes
  try {
    Object.keys(dbAccessState).forEach((key) => {
      if (dbAccessState[key].time < expired) delete dbAccessState[key];
    });
  } catch (e) {
    console.log(e);
  }
  setTimeout(cleanAccessState, 60 * 1000); // check every minutes
}
cleanAccessState(); // launch cleaner
let QUERY_GET_ALL = null;
/** @returns {any} */

/** @typedef {(err?: Error | null, res?: T | null) => unknown} GenericCallback */
/** @typedef {GenericCallback<unknown>} Callback */
/**
 * @typedef {{
 *   status: "NEED_SIGNIN" | "REFUSED" | "ERROR" | "ACCEPTED"
 *   // HTTP Status Code to send when polling.
 *   code: number
 *   // Poll Key
 *   key?: string
 *   requestingAppId?: string
 *   requestedPermissions?: PermissionSet
 *   url?: string
 *   poll?: string
 *   returnURL?: string | null
 *   oauthState?: OAuthState
 *   poll_rate_ms?: number
 * }} AccessState
 */
/** @typedef {string | null} OAuthState */
