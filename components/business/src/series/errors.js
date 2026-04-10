/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
// Thrown when the request parsing fails.
//
class ParseFailure extends Error {
}
/**
 * @param {string} msg
 * @returns {Error}
 */
function error (msg) {
  return new ParseFailure(msg);
}
module.exports = {
  // error class
  ParseFailure,
  // error factories
  error
};
