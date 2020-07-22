/**
 * Tiny store for password reset requests.
 */
module.exports = PasswordResetRequests;

var generateId = require('cuid'),
    _ = require('lodash');

var collectionInfo = {
  name: 'passwordResets',
  indexes: [
    // set TTL index for auto cleanup of expired requests
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
function PasswordResetRequests(database, options) {
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
    username: username,
  };
  this.database.findOne(collectionInfo, query, null, function (err, resetReq) {
    if (err) {
      return callback(err);
    }

    if (! resetReq) {
      return callback(null, null);
    }

    if (! resetReq.expires || new Date() < resetReq.expires) {
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
    username: username,
    expires: this.getNewExpirationDate(),
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
    username: username,
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
