/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * Helper function for handling method responses.
 *
 * @param successCode Can be a function accepting the result in arg
 *                                      and returning a number
 */
export default function (res: any, next: any, successCode: any) {
  return function (err: any, result: any) {
    if (err != null) {
      return next(err);
    }
    if (result == null) { throw new Error('AF: either err or result must be non-null.'); }
    result.writeToHttpResponse(res, successCode);
  };
};
