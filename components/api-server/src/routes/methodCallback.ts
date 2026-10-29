/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Response, NextFunction } from 'express';

type SuccessCode = number | ((result: unknown) => number);
type ResultLike = { writeToHttpResponse: (res: Response, successCode: number, onStreamError?: (err: Error) => void) => void };

/**
 * Helper function for handling method responses.
 *
 * @param successCode Can be a function accepting the result in arg
 *                                      and returning a number
 */
export default function (res: Response, next: NextFunction, successCode: SuccessCode) {
  return function (err: unknown, result: ResultLike | null) {
    if (err != null) {
      return next(err);
    }
    if (result == null) { throw new Error('AF: either err or result must be non-null.'); }
    // Resolved here: the result writes a number only (a function reaching it
    // never sends the response). A streamed result failing while it is read
    // goes to the error handler like any other method error.
    result.writeToHttpResponse(res, typeof successCode === 'function' ? successCode(result) : successCode, next);
  };
}
