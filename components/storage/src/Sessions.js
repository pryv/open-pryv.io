/**
 * Simple cookie-less user session store.
 * Fetches, generates, touches and destroys sessions.
 */
module.exports = Sessions;

var generateId = require('cuid'),
    _ = require('lodash');

var collectionInfo = {
  name: 'sessions',
  indexes: [
    // set TTL index for auto cleanup of expired sessions
    {
      index: {expires: 1},
      options: {expireAfterSeconds: 0}
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
function Sessions(database, options) {
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
  this.database.findOne(collectionInfo, {_id: id}, null, function (err, session) {
    if (err) {
      return callback(err);
    }

    if (! session) {
      return callback(null, null);
    }

    if (! session.expires || new Date() < session.expires) {
      callback(null, session.data);
    } else {
      this.destroy(id, callback);
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
  this.database.findOne(collectionInfo, {data: data}, null, function (err, session) {
    if (err) {
      return callback(err);
    }

    if (! session) {
      return callback(null, null);
    }

    if (! session.expires || new Date() < session.expires) {
      callback(null, session._id);
    } else {
      this.destroy(session._id, callback);
    }
  }.bind(this));
};

/**
 * Creates a new session with the given data.
 *
 * @param {Object} data
 * @param {Function} callback Args: err, id
 */
Sessions.prototype.generate = function (data, callback) {
  var session = {
    _id: generateId(),
    data: typeof data === 'object' ? data : {},
    expires: this.getNewExpirationDate()
  };
  this.database.insertOne(collectionInfo, session, function (err) {
    if (err) { return callback(err); }
    callback(null, session._id);
  });
};

/**
 * Renews the specified session's expiration date.
 *
 * @param {String} id
 * @param {Function} callback
 */
Sessions.prototype.touch = function (id, callback) {
  var update = {$set: {expires: this.getNewExpirationDate()}};
  this.database.updateOne(collectionInfo, {_id: id}, update, callback);
};

/**
 * Deletes the specified session.
 *
 * @param {String} id
 * @param {Function} callback
 */
Sessions.prototype.destroy = function (id, callback) {
  this.database.deleteOne(collectionInfo, {_id: id}, callback);
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

