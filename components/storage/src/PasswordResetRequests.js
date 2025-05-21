/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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
/**
 * Tiny store for password reset requests.
 * TODO: migrate to SQLite storage.
 */
module.exports = PasswordResetRequests;

const generateId = require('cuid');
const _ = require('lodash');

const collectionInfo = {
  name: 'passwordResets',
  indexes: [
    // set TTL index for auto cleanup of expired requests
    {
      index: { expires: 1 },
      options: { expireAfterSeconds: 0 }
    }
  ]
};

/**
 * Creates a new instance with the given database and options.
 *
 * @param {Object} database
 * @param {Object} options Possible options: `maxAge` (in milliseconds)
 * @constructor
 */
function PasswordResetRequests (database, options) {
  this.database = database;
  this.options = _.merge({
    maxAge: 1000 * 60 * 60 // one hour
  }, options);
}

/**
 * Fetches the specified reset request's data (or null if the request doesn't exist or has expired).
 *
 * @param {String} id
 * @param {String} username
 * @param {Function} callback Args: err, data
 */
PasswordResetRequests.prototype.get = function (id, username, callback) {
  const query = {
    _id: id,
    username
  };
  this.database.findOne(collectionInfo, query, null, function (err, resetReq) {
    if (err) {
      return callback(err);
    }

    if (!resetReq) {
      return callback(null, null);
    }

    if (!resetReq.expires || new Date() < resetReq.expires) {
      callback(null, resetReq);
    } else {
      this.destroy(id, username, callback);
    }
  }.bind(this));
};

/**
 * Creates a new reset request for requesting username.
 *
 * @param {String} requesting username
 * @param {Function} callback Args: err, id
 */
PasswordResetRequests.prototype.generate = function (username, callback) {
  const resetReq = {
    _id: generateId(),
    username,
    expires: this.getNewExpirationDate()
  };
  this.database.insertOne(collectionInfo, resetReq, function (err) {
    if (err) { return callback(err); }
    callback(null, resetReq._id);
  });
};

/**
 * Deletes the specified reset request.
 *
 * @param {String} id
 * @param {String} username
 * @param {Function} callback
 */
PasswordResetRequests.prototype.destroy = function (id, username, callback) {
  const query = {
    _id: id,
    username
  };
  this.database.deleteOne(collectionInfo, query, callback);
};

/**
 * Destroys all reset requests.
 *
 * @param {Function} callback
 */
PasswordResetRequests.prototype.clearAll = function (callback) {
  this.database.deleteMany(collectionInfo, {}, callback);
};

PasswordResetRequests.prototype.getNewExpirationDate = function () {
  return new Date((new Date()).getTime() + this.options.maxAge);
};
