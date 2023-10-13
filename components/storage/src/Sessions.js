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
/**
 * Simple cookie-less user session store.
 * Fetches, generates, touches and destroys sessions.
 */
module.exports = Sessions;

const generateId = require('cuid');
const _ = require('lodash');

const collectionInfo = {
  name: 'sessions',
  indexes: [
    // set TTL index for auto cleanup of expired sessions
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
function Sessions (database, options) {
  this.database = database;
  this.options = _.merge({
    maxAge: 1000 * 60 * 60 * 24 * 14 // two weeks
  }, options);
}

/**
 * Fetches the specified session's data (or null if the session does not exist or has expired).
 *
 * @param {String} id
 * @param {Function} callback Args: err, data
 */
Sessions.prototype.get = function (id, callback) {
  this.database.findOne(collectionInfo, { _id: id }, null, function (err, session) {
    if (err) {
      return callback(err);
    }

    if (!session) {
      return callback(null, null);
    }

    if (!session.expires || new Date() < session.expires) {
      callback(null, session.data);
    } else {
      this.destroy(id, function (err, res) {
        // the this.destroy() callback returns the op result, we must replace it with null
        callback(err, null);
      });
    }
  }.bind(this));
};

/**
 * Retrieves the valid session id matching the data (or null if not found).
 *
 * @param {Object} data
 * @param {Function} callback Args: err, id
 */
Sessions.prototype.getMatching = function (data, callback) {
  this.database.findOne(collectionInfo, { data }, null, function (err, session) {
    if (err) {
      return callback(err);
    }

    if (!session) {
      return callback(null, null);
    }

    if (!session.expires || new Date() < session.expires) {
      callback(null, session._id);
    } else {
      this.destroy(session._id, (err, res) => {
        // the this.destroy() callback returns the op result, we must replace it with null
        callback(err, null);
      });
    }
  }.bind(this));
};

/**
 * Creates a new session with the given data.
 *
 * @param {Object} data
 * @param {Function} callback Args: err, id
 */
Sessions.prototype.generate = function (data, options, callback) {
  const session = {
    _id: generateId(),
    data: typeof data === 'object' ? data : {},
    expires: this.getNewExpirationDate()
  };
  this.database.insertOne(collectionInfo, session, function (err) {
    if (err) { return callback(err); }
    callback(null, session._id);
  },
  options);
};

/**
 * Renews the specified session's expiration date.
 *
 * @param {String} id
 * @param {Function} callback
 */
Sessions.prototype.touch = function (id, callback) {
  const update = { $set: { expires: this.getNewExpirationDate() } };
  this.database.updateOne(collectionInfo, { _id: id }, update, callback);
};

/**
 * Used for tests ony.
 * Updates 'expires' to now, so that the session will be destroyed the next time Sessions.get()
 * or Sessions.getMatching() is called.
 *
 * @param {String} id
 * @param {Function} callback
 */
Sessions.prototype.expireNow = function (id, callback) {
  const update = { $set: { expires: new Date() } };
  this.database.updateOne(collectionInfo, { _id: id }, update, callback);
};

/**
 * Deletes the specified session.
 *
 * @param {String} id
 * @param {Function} callback
 */
Sessions.prototype.destroy = function (id, callback) {
  this.database.deleteOne(collectionInfo, { _id: id }, callback);
};

/**
 * Destroys all sessions.
 *
 * @param {Function} callback
 */
Sessions.prototype.clearAll = function (callback) {
  this.database.deleteMany(collectionInfo, {}, callback);
};

Sessions.prototype.getNewExpirationDate = function () {
  return new Date((new Date()).getTime() + this.options.maxAge);
};

/**
 * Override.
 */
Sessions.prototype.remove = function (query, callback) {
  this.database.deleteMany(
    collectionInfo,
    query,
    callback
  );
};
