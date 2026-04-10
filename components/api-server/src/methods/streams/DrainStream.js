/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const Writable = require('stream').Writable;
const inherits = require('util').inherits;
const errors = require('errors').factory;

module.exports = DrainStream;

/**
 * Writable stream used to drain items fed to it into an array and returns the said
 * array in the callback or an error if the limit of items is exceeded.
 *
 * @param params {Object}
 *        params.limit {Number} limit of objects to return, default is 100'000 (defined in API.js)
 * @param callback {Function} called when all items have been drained in the internal array
 *                            or the limit was reached, generating an error
 * @constructor
 */
function DrainStream (params, callback) {
  Writable.call(this, { objectMode: true });

  this.limit = 100000;

  if (params && (params.limit > 0)) {
    this.limit = params.limit;
  }

  this.array = [];
  this.size = 0;

  if (callback) {
    this.on('finish', function () {
      if (params.isArray) {
        return callback(null, this.array);
      }
      if (this.array.length !== 1) {
        return callback(new Error('Expected to find 1 item in array got: ' + JSON.stringify(this.array)));
      }
      callback(null, this.array[0]);
    });
  }

  this.on('error', callback);
}

inherits(DrainStream, Writable);

DrainStream.prototype._write = function (object, enc, next) {
  this.size++;

  if (this.size > this.limit) {
    return next(errors.tooManyResults(this.limit));
  }
  this.array.push(object);
  next();
};
