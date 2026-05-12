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
 * @param options Possible options: `maxAge` (in milliseconds)
 */
function PasswordResetRequests (this: any, database: any, options: any) {
  this.database = database;
  this.options = deepMerge({
    maxAge: 1000 * 60 * 60 // one hour
  }, options);
}

/**
 * Fetches the specified reset request's data (or null if the request doesn't exist or has expired).
 *
 * @param callback Args: err, data
 */
PasswordResetRequests.prototype.get = function (this: any, id: any, username: any, callback: any) {
  const query = {
    _id: id,
    username
  };
  this.database.findOne(collectionInfo, query, null, (err: any, resetReq: any) => {
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
  });
};

/**
 * Creates a new reset request for requesting username.
 *
 * @param requesting username
 * @param callback Args: err, id
 */
PasswordResetRequests.prototype.generate = function (username: any, callback: any) {
  const resetReq = {
    _id: generateId(),
    username,
    expires: this.getNewExpirationDate()
  };
  this.database.insertOne(collectionInfo, resetReq, function (err: any) {
    if (err) { return callback(err); }
    callback(null, resetReq._id);
  });
};

/**
 * Deletes the specified reset request.
 *
 */
PasswordResetRequests.prototype.destroy = function (id: any, username: any, callback: any) {
  const query = {
    _id: id,
    username
  };
  this.database.deleteOne(collectionInfo, query, callback);
};

/**
 * Destroys all reset requests.
 *
 */
PasswordResetRequests.prototype.clearAll = function (callback: any) {
  this.database.deleteMany(collectionInfo, {}, callback);
};

PasswordResetRequests.prototype.getNewExpirationDate = function () {
  return new Date((new Date()).getTime() + this.options.maxAge);
};

// --- Migration methods --- //

/**
 * Export all password reset request documents (raw).
 */
PasswordResetRequests.prototype.exportAll = function (callback: any) {
  this.database.find(collectionInfo, {}, {}, callback);
};

/**
 * Import raw password reset request documents.
 */
PasswordResetRequests.prototype.importAll = function (data: any, callback: any) {
  if (!data || data.length === 0) return callback(null);
  this.database.insertMany(collectionInfo, data, callback);
};
