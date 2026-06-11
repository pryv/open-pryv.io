/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Helper functions for error handling.
 */
import { createRequire } from 'node:module';
import type { APIError as APIErrorType } from './APIError.ts';
const require = createRequire(import.meta.url);

const { APIError } = require('./APIError.ts');
const { ErrorIds } = require('./ErrorIds.ts');

type LogFnLike = (msg: string, metadata?: unknown) => void;
type ReqLike = { url?: string, method?: string, body?: unknown } | null;
type LoggerLike = { debug: LogFnLike, info: LogFnLike, warn: LogFnLike, error: LogFnLike };
type PublicErrorData = { id: string, message: string, data?: unknown };
interface ErrorHandling {
  logError: (error: Error, req: ReqLike, logger: LoggerLike) => void;
  getPublicErrorData: (error: Error) => PublicErrorData;
}

// Populated by the assignments below.
const errorHandling: ErrorHandling = {} as ErrorHandling;
export { errorHandling };
export type { ErrorHandling };
/**
 * Logs the given error.
 *
 * @param error The error object (can be an API error or not)
 * @param req The request context; expected properties: url, method, body
 * @param logger The logger object (expected methods: debug, info, warn, error)
 */
errorHandling.logError = function (error: Error, req: ReqLike, logger: LoggerLike) {
  // console.log('XXXXXX', error); // uncomment to log 500 errors on test running using InstanceManager
  type ErrorLogMetadata = {
    context?: { location?: string; method?: string; data?: unknown };
    errorData?: unknown;
    innerError?: string;
  };
  const metadata: ErrorLogMetadata = {};
  if (req) {
    metadata.context = {
      location: req.url,
      method: req.method,
      data: req.body
    };
  }
  if (error instanceof APIError) {
    const apiError = error as APIErrorType;
    const logMsg = apiError.id +
            ' error (' +
            (apiError.httpStatus || 'n/a') +
            '): ' +
            apiError.message;
    if (apiError.data) {
      metadata.errorData = apiError.data;
    }
    if (apiError.innerError) {
      metadata.innerError =
                apiError.id === ErrorIds.UnexpectedError
                  ? apiError.innerError.stack || apiError.innerError.message
                  : apiError.innerError.message;
    }
    if (apiError.id === ErrorIds.UnexpectedError) {
      logger.error(logMsg, metadata);
    } else {
      logger.info(logMsg, metadata);
    }
  } else {
    // Assumes that error is in fact instanceof Error...
    logger.error('Unhandled API error (' +
            error.name +
            '): ' +
            error.message +
            '\n' +
            error.stack, metadata);
  }
};
/**
 * Returns a public-safe error object from the given API error.
 */
errorHandling.getPublicErrorData = function (error: Error) {
  if (error instanceof APIError) {
    const apiError = error as APIErrorType;
    const publicError: { id: string, message: string, data?: unknown } = {
      id: apiError.id,
      message: apiError.message
    };
    if (apiError.data) {
      publicError.data = apiError.data;
    }
    return publicError;
  } else {
    return {
      id: ErrorIds.UnexpectedError,
      message: 'An unexpected error occurred. Our bad! Please accept our humble apologies and ' +
                'notify us if it happens repeatedly. Thank you.'
    };
  }
};
