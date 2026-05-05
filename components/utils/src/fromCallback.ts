/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


/**
 * Tiny stand-in for the (legacy) `fromCallback` idiom. Wraps a
 * function that accepts a node-style `(err, value)` callback into a Promise.
 *
 *   await fromCallback((cb) => storage.findOne(user, query, cb));
 */
function fromCallback (fn) {
  return new Promise((resolve, reject) => {
    fn((err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

export { fromCallback };
