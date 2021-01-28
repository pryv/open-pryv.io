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

const async = require('async');
const semver = require('semver');
const logger = require('winston');
const lodash = require('lodash');

const messages = require('../utils/messages');

type GenericCallback<T> = (err?: ?Error, res: ?T) => mixed;
type Callback = GenericCallback<mixed>;

import type { UserInformation } from './users';

export type AccessState = {
  status: 'NEED_SIGNIN' | 'REFUSED' | 'ERROR' | 'ACCEPTED',
  // HTTP Status Code to send when polling.
  code: number,
  // Poll Key
  key?: string,
  requestingAppId?: string,
  requestedPermissions?: PermissionSet,
  url?: string,
  poll?: string,
  returnURL?: ?string,
  oauthState?: OAuthState,
  poll_rate_ms?: number,
}
type OAuthState = string | null;
import type { PermissionSet } from '../utils/check-and-constraints';

const fakeRedis = {};

const references = {};

/**
 * Load external references
 */
function setReference(key, value) {
  references[key] = value;
}
exports.setReference = setReference;

function getRawEventCollection(callback) {
  references.storage.connection.getCollectionSafe({name: 'events'}, 
  function errorCallback(err) { callback(err, null); },
  function sucessCallback(col) { callback(null, col); })
}

function systemCall(...args) {
  return references.systemAPI.call(...args);
}


function createUser(request, callback) {
  systemCall('system.createUser', {}, request, callback);
}
exports.createUser = createUser;

/**
 * Check if an email address exists in the database
 * @param email: the email address to verify
 * @param callback: function(error,result), result being 'true' if it exists, 'false' otherwise
 */
function emailExists(email: string, callback: GenericCallback<boolean>) {
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
exports.uidExists = function (uid: string, callback: Callback) {
  uid = uid.toLowerCase();
  const context = {};
  async.series([
    function (done) { 
      getRawEventCollection(function(err, eventCollection) {  
        context.eventCollection = eventCollection;
        done(err);
      });
    },
    function (done) { 
      if (! context.userId) return done();
      context.eventCollection.findOne({content: uid, streamIds: {$in : ['.username']}, type: 'identifier/string'}, function(err, res) {
        context.username = res?.content;
        done(err);
      }); 
    }
  ], function(err) { 
    callback(err, context.username !== null);
  })
 
};

/**
 * Get the server linked with provided user id
 * @param uid: the user id
 * @param callback: function(error,result), result being the server name
 */
exports.getServer = function (uid: string, callback: GenericCallback<string>) {
  return callback(null, 'SERVER_NAME');
};

/**
 * Get user id linked with provided email address
 * @param mail: the email address
 * @param callback: function(error,result), result being the requested user id
 */
function getUIDFromMail(mail: string, callback: GenericCallback<string>) {
  mail = mail.toLowerCase();
  const context = {};
  async.series([
    function (done) { 
      getRawEventCollection(function(err, eventCollection) {  
        context.eventCollection = eventCollection;
        done(err);
      });
    },
    function (done) { 
      context.eventCollection.findOne({content: mail, streamIds: {$in : ['.email']}, type: 'email/string'}, function(err, res) {
        context.userId = res?.userId;
        done(err);
      }); 
    },
    function (done) { 
      if (! context.userId) return done();
      context.eventCollection.findOne({userId: context.userId, streamIds: {$in : ['.username']}, type: 'identifier/string'}, function(err, res) {
        context.username = res?.content;
        done(err);
      }); 
    }
  ], function(err) { 
    callback(err, context.username);
  })
 
};
exports.getUIDFromMail = getUIDFromMail;

/**
 * Get all users
 */
function getAllUsers(callback: GenericCallback<string>) {
  const context = {};
  async.series([
    function (done) { 
      getRawEventCollection(function(err, eventCollection) {  
        context.eventCollection = eventCollection;
        done(err);
      });
    },
    function (done) { 
      const cursor = context.eventCollection.aggregate(QUERY_GET_ALL, { cursor: { batchSize: 1 }}); 
  
      context.users = [];
      cursor.each(function(err, item) {
        if (err) return done(err);
        if (item === null) return done();
        const user = {
          id: item._id?.userId,
          registeredTimestamp: item.smallestCreatedAt * 1000
        }
        if (item.events) {
          for (let event of item.events) {
            if (event.type === 'email/string' && event.streamIds.includes('.email')) {
              user.email = event.content;
            } else if (event.type === 'language/iso-639-1' && event.streamIds.includes('.language')) {
              user.language = event.content;
            } else if (event.type === 'identifier/string' && event.streamIds.includes('.username')) {
              user.username = event.content;
            } else if (event.type === 'identifier/string' && event.streamIds.includes('.referer')) {
              user.referer = event.content;
            } else {
              console.log('Unkown field... ', event);
            }
          }
        }
        context.users.push(user);
      });
    }
  ], function(err) { 
    callback(err, context.users);
  });

};
exports.getAllUsers = getAllUsers;

const dbAccessState = {};
/**
 * Update the state of an access in the database
 * @param key: the database key for this access
 * @param value: the new state of this access
 * @param callback: function(error,result), result being the result of the database transaction
 */
exports.setAccessState = function (
  key: string, value: AccessState,
  callback: Callback,
) {
  dbAccessState[key] = { value: value, time: Date.now() };
  callback(null, value); // callback anyway
};

/** Get the current state of an access in the database.
 *
 * @param key {string} - the database key for this access
 * @param callback {nodejsCallback} - result being the corresponding JSON 
 *    database entry
 */
exports.getAccessState = function (key: string, callback: GenericCallback<AccessState>) {
  const res = dbAccessState[key];
  callback(null, res ? res.value : null);
};

/**
 * Timer to autoclean dbAccessState
 */
function cleanAccessState() {
  const expired = Date.now() - (60 * 10 * 1000); // 10 minutes
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


const QUERY_GET_ALL = [
  {
    '$match': {
      streamIds: { '$in': [ '.email', '.username', '.language', '.referer' ] }
    }
  },
  {
    '$group': {
      _id: { userId: '$userId' },
      smallestCreatedAt: { '$min': '$created' },
      events: {
        '$push': { content: '$content', streamIds: '$streamIds', type: '$type' }
      }
    }
  },
  {'$sort': { smallestCreatedAt: 1 }}
];