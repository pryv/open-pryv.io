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
const { APIError, factory: errorsFactory } = require('errors');
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
    if (error != null && error instanceof APIError) { safeError = error; } else if (typeof (error as { status?: unknown })?.status === 'number') {
      // From Express' body parser (malformed JSON, body too large): the
      // client's fault, answered like the API server does.
      safeError = errorsFactory.invalidRequestStructure((error as Error).message);
    } else {
      // A server-side fault: answered like the API server does (generic
      // message with a reference; the detail and stack go to the error log).
      safeError = errorsFactory.unexpectedError(error instanceof Error ? error : new Error(String(error)));
    }

    errorHandling.logError(safeError, req, logger);

    const status = safeError.httpStatus || 500;
    res.status(status).json({
      error: errorHandling.getPublicErrorData(safeError)
    });
  };
};
