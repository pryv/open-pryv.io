/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Writable } = require('stream');
const errors = require('errors').factory;

/**
 * Writable stream used to drain items fed to it into an array and returns the said
 * array in the callback or an error if the limit of items is exceeded.
 *
 * @param params {Object}
 *        params.limit {Number} limit of objects to return, default is 100'000 (defined in API.js)
 * @param callback {Function} called when all items have been drained in the internal array
 *                            or the limit was reached, generating an error
 */
interface DrainParams { limit?: number; isArray?: boolean }
type DrainCallback = (err: Error | null, result?: unknown) => void;

class DrainStream extends Writable {
  limit: number;
  array: unknown[];
  size: number;

  constructor (params: DrainParams, callback: DrainCallback) {
    super({ objectMode: true });

    this.limit = (params?.limit && params.limit > 0) ? params.limit : 100000;
    this.array = [];
    this.size = 0;

    if (callback) {
      this.on('finish', () => {
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

  _write (object: unknown, enc: BufferEncoding, next: (error?: Error | null) => void) {
    this.size++;
    if (this.size > this.limit) {
      return next(errors.tooManyResults(this.limit));
    }
    this.array.push(object);
    next();
  }
}

export default DrainStream;
export { DrainStream };
