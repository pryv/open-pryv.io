/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
const require = createRequire(import.meta.url);

const errorHandling = require('errors').errorHandling;
const { APIError } = require('errors');
/** Produces a middleware function that will handle all errors and augment
 * them with a JSON error body.
 *
 * To use this, you need to add it to your middleware stack _after_ all other
 * routes have been added.
 *
 * @param  {Logger} logger logger to use for `logError` call
 * @return express middleware function that logs errors and responds
 *    to them properly.
 */
export default function produceErrorHandlingMiddleware (logger: unknown) {
  return function handleError (error: unknown, req: Request, res: Response, next: NextFunction) {
    let safeError;
    if (error != null && error instanceof APIError) { safeError = error; } else {
      // Assume that we can toString the mystery object
      safeError = new APIError((error as { toString(): string }).toString());
    }

    errorHandling.logError(safeError, req, logger);

    const status = safeError.httpStatus || 500;
    res.status(status).json({
      error: errorHandling.getPublicErrorData(safeError)
    });
  };
};
