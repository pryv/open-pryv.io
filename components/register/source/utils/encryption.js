/**
 * @license
 * Copyright (C) 2020 Pryv S.A. https://pryv.com - All Rights Reserved
 * Unauthorized copying of this file, via any medium is strictly prohibited
 * Proprietary and confidential
 */
/**
 * Encryption functions (wraps bcrypt functionality).
 * THIS FILE IS A COPY FROM ACTIVITY SERVER: don't modify one without the other.
 */

var bcrypt = require('bcrypt');

var envIsDevelopment = ! process.env.NODE_ENV || process.env.NODE_ENV === 'development';
var salt = bcrypt.genSaltSync(envIsDevelopment ? 1 : 10);

/**
 * Generate a hash from provided value
 * @param value: the value to be hashed
 * @param callback: callback (error, result), result being the generated hash
 */
exports.hash = function(value, callback) {
  bcrypt.hash(value, salt, callback);
};

/**
 * Synchronous hash function
 * For tests only
 * @param value: the value to be hashed
 */
exports.hashSync = function(value) {
  return bcrypt.hashSync(value, salt);
};

/**
 * @param {String} value The value to check
 * @param {String} hash The hash to check the value against
 * @param {Function} callback (error, {Boolean} result)
 */
/**
 * Check if a provided value, once hashed, matches the provided hash
 * @param value: the value to check
 * @param hash: the hash to check match
 * @param callback: function(err,res), res being 'true' if there is a match, 'false' otherwise
 */
exports.compare = function(value, hash, callback) {
  bcrypt.compare(value, hash, callback);
};
