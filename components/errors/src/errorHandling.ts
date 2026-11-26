/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Helper functions for error handling.
 */
import type { APIError as APIErrorType } from './APIError.ts';
import { APIError } from './APIError.ts';
import { ErrorIds } from './ErrorIds.ts';
import { isStatementCancelled, isAccountGoneRefusal, accountGoneRefusalOf } from './factory.ts';
import { isPlatformNoAnswer } from 'storages/interfaces/platformStorage/noAnswer.ts';
// Logged URLs never carry the access token (`?auth=`).
import { redactUrl } from 'utils/src/redactUrl.ts';

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
// Request bodies carry credentials (passwords, reset tokens, recovery codes,
// invitation tokens...), so an error log keeps the body's keys and only the
// values of the fields below, which never hold one.
const LOGGABLE_BODY_FIELDS = ['appId', 'username', 'method', 'type', 'id', 'streamIds', 'streamId', 'name', 'languageCode'];

function summarizeBody (body: unknown): unknown {
  if (body == null || typeof body !== 'object') return body == null ? body : typeof body;
  if (Array.isArray(body)) return body.map((item) => summarizeBody(item));
  const record = body as Record<string, unknown>;
  const summary: Record<string, unknown> = { keys: Object.keys(record) };
  for (const field of LOGGABLE_BODY_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' || typeof value === 'number' || (Array.isArray(value) && value.every((v) => typeof v === 'string'))) {
      summary[field] = value;
    }
  }
  return summary;
}

// Schema validation errors echo the rejected value (an MFA code, a phone
// number, a custom account field) in their `params` and generated `message`:
// the log keeps only where each error points. The client answer is unchanged.
const LOGGABLE_VALIDATION_FIELDS = ['code', 'path', 'param'];

function summarizeValidationErrors (data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return data.map((item) => {
    if (item == null || typeof item !== 'object') return item;
    const record = item as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    for (const field of LOGGABLE_VALIDATION_FIELDS) {
      if (typeof record[field] === 'string') summary[field] = record[field];
    }
    return summary;
  });
}

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
      location: redactUrl(req.url),
      method: req.method,
      data: summarizeBody(req.body)
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
      metadata.errorData = apiError.id === ErrorIds.InvalidParametersFormat
        ? summarizeValidationErrors(apiError.data)
        : apiError.data;
    }
    if (apiError.innerError) {
      metadata.innerError =
                apiError.id === ErrorIds.UnexpectedError
                  ? apiError.innerError.stack || apiError.innerError.message
                  : apiError.innerError.message;
    }
    const inner = apiError.innerError;
    if (apiError.id === ErrorIds.UnexpectedError) {
      logger.error(logMsg, metadata);
    } else if (isStatementCancelled(inner)) {
      // A statement stopped by the database time limit: the operator's signal
      // for tuning it. Its text (truncated), never its parameters.
      logger.warn(logMsg, { ...metadata, statement: typeof inner.statementText === 'string' ? inner.statementText : undefined });
    } else if (isPlatformNoAnswer(inner)) {
      // The platform database did not answer: the operator's signal of a
      // leader change that lasts, or of an unreachable platform database.
      logger.warn(logMsg, metadata);
    } else if (isAccountGoneRefusal(inner)) {
      // The storage refused a write (or file) for an account it does not hold:
      // an account erased while the request ran, or a write under a wrong id
      // (a bug the 404 alone would hide). The refusal's own text and table.
      const refusal = accountGoneRefusalOf(inner);
      logger.warn(logMsg, { ...metadata, refusal: refusal?.message, table: typeof refusal?.table === 'string' ? refusal.table : undefined });
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
