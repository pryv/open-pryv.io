/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Tiny store for password reset requests.
 * TODO: migrate to SQLite storage.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export { PasswordResetRequests };
const { createId: generateId } = require('@paralleldrive/cuid2');
const { deepMerge } = require('utils');

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
 * @param database
 * @param options Possible options: `maxAge` (in milliseconds)
 */
function PasswordResetRequests (database, options) {
  this.database = database;
  this.options = deepMerge({
    maxAge: 1000 * 60 * 60 // one hour
  }, options);
}

/**
 * Fetches the specified reset request's data (or null if the request doesn't exist or has expired).
 *
 * @param id
 * @param username
 * @param callback Args: err, data
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
 * @param requesting username
 * @param callback Args: err, id
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
 * @param id
 * @param username
 * @param callback
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
 * @param callback
 */
PasswordResetRequests.prototype.clearAll = function (callback) {
  this.database.deleteMany(collectionInfo, {}, callback);
};

PasswordResetRequests.prototype.getNewExpirationDate = function () {
  return new Date((new Date()).getTime() + this.options.maxAge);
};

// --- Migration methods --- //

/**
 * Export all password reset request documents (raw).
 * @param callback
 */
PasswordResetRequests.prototype.exportAll = function (callback) {
  this.database.find(collectionInfo, {}, {}, callback);
};

/**
 * Import raw password reset request documents.
 * @param data
 * @param callback
 */
PasswordResetRequests.prototype.importAll = function (data, callback) {
  if (!data || data.length === 0) return callback(null);
  this.database.insertMany(collectionInfo, data, callback);
};
