/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Helper function for handling method responses.
 *
 * @param {Object} res
 * @param {Function} next
 * @param {Number|Function} successCode Can be a function accepting the result in arg
 *                                      and returning a number
 * @returns {Function}
 */
module.exports = function (res, next, successCode) {
  return function (err, result) {
    if (err != null) {
      return next(err);
    }
    if (result == null) { throw new Error('AF: either err or result must be non-null.'); }
    result.writeToHttpResponse(res, successCode);
  };
};
