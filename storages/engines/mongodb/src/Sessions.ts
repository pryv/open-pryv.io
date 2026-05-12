/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Simple cookie-less user session store.
 * Fetches, generates, touches and destroys sessions.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export { Sessions };
const { createId: generateId } = require('@paralleldrive/cuid2');
const { deepMerge } = require('utils');

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
 * @param options Possible options: `maxAge` (in milliseconds)
 */
function Sessions (this: any, database: any, options: any) {
  this.database = database;
  this.options = deepMerge({
    maxAge: 1000 * 60 * 60 * 24 * 14 // two weeks
  }, options);
}

/**
 * Fetches the specified session's data (or null if the session does not exist or has expired).
 *
 * @param callback Args: err, data
 */
Sessions.prototype.get = function (this: any, id: any, callback: any) {
  this.database.findOne(collectionInfo, { _id: id }, null, (err: any, session: any) => {
    if (err) {
      return callback(err);
    }

    if (!session) {
      return callback(null, null);
    }

    if (!session.expires || new Date() < session.expires) {
      callback(null, session.data);
    } else {
      this.destroy(id, function (err: any, res: any) {
        // the this.destroy() callback returns the op result, we must replace it with null
        callback(err, null);
      });
    }
  });
};

/**
 * Retrieves the valid session id matching the data (or null if not found).
 *
 * @param callback Args: err, id
 */
Sessions.prototype.getMatching = function (this: any, data: any, callback: any) {
  this.database.findOne(collectionInfo, { data }, null, (err: any, session: any) => {
    if (err) {
      return callback(err);
    }

    if (!session) {
      return callback(null, null);
    }

    if (!session.expires || new Date() < session.expires) {
      callback(null, session._id);
    } else {
      this.destroy(session._id, (err: any, res: any) => {
        // the this.destroy() callback returns the op result, we must replace it with null
        callback(err, null);
      });
    }
  });
};

/**
 * Creates a new session with the given data.
 *
 * @param callback Args: err, id
 */
Sessions.prototype.generate = function (data: any, options: any, callback: any) {
  const session = {
    _id: generateId(),
    data: typeof data === 'object' ? data : {},
    expires: this.getNewExpirationDate()
  };
  this.database.insertOne(collectionInfo, session, function (err: any) {
    if (err) { return callback(err); }
    callback(null, session._id);
  },
  options);
};

/**
 * Renews the specified session's expiration date.
 *
 */
Sessions.prototype.touch = function (id: any, callback: any) {
  const update = { $set: { expires: this.getNewExpirationDate() } };
  this.database.updateOne(collectionInfo, { _id: id }, update, callback);
};

/**
 * Used for tests ony.
 * Updates 'expires' to now, so that the session will be destroyed the next time Sessions.get()
 * or Sessions.getMatching() is called.
 *
 */
Sessions.prototype.expireNow = function (id: any, callback: any) {
  const update = { $set: { expires: new Date() } };
  this.database.updateOne(collectionInfo, { _id: id }, update, callback);
};

/**
 * Deletes the specified session.
 *
 */
Sessions.prototype.destroy = function (id: any, callback: any) {
  this.database.deleteOne(collectionInfo, { _id: id }, callback);
};

/**
 * Destroys all sessions.
 *
 */
Sessions.prototype.clearAll = function (callback: any) {
  this.database.deleteMany(collectionInfo, {}, callback);
};

Sessions.prototype.getNewExpirationDate = function () {
  return new Date((new Date()).getTime() + this.options.maxAge);
};

/**
 * Delete sessions whose data matches the given fields.
 * @param query — plain key/value to match inside session data
 */
Sessions.prototype.remove = function (query: any, callback: any) {
  // Convert plain {field: value} to MongoDB dot-notation on the data subdocument
  const mongoQuery: any = {};
  for (const [key, value] of Object.entries(query)) {
    mongoQuery[`data.${key}`] = value;
  }
  this.database.deleteMany(
    collectionInfo,
    mongoQuery,
    callback
  );
};

// --- Migration methods --- //

/**
 * Export all session documents (raw).
 */
Sessions.prototype.exportAll = function (callback: any) {
  this.database.find(collectionInfo, {}, {}, callback);
};

/**
 * Import raw session documents.
 */
Sessions.prototype.importAll = function (data: any, callback: any) {
  if (!data || data.length === 0) return callback(null);
  this.database.insertMany(collectionInfo, data, callback);
};
