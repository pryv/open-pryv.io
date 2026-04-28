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
 *
 * Equivalent semantics to fromCallback. Native to keep TS+ESM
 * migration simple — every call site becomes `await new Promise(...)` shaped
 * code paths once we lower the indirection.
 */
module.exports = function fromCallback (fn) {
  return new Promise((resolve, reject) => {
    fn((err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
};
