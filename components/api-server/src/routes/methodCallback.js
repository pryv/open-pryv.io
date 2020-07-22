// @flow

import type Result from '../Result';

/**
 * Helper function for handling method responses.
 *
 * @param {Object} res
 * @param {Function} next
 * @param {Number|Function} successCode Can be a function accepting the result in arg
 *                                      and returning a number
 * @returns {Function}
 */
module.exports = function (res: express$Response, next: express$NextFunction, successCode: number) {
  return function (err: ?Error, result: ?Result) {

    if (err != null) {
      return next(err);
    }
    
    if (result == null)
      throw new Error('AF: either err or result must be non-null.');

    result.writeToHttpResponse(res, successCode);
  };
};
