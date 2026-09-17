/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);
const errors = require('errors');
const errorsFactory = errors.factory;
const APIError = errors.APIError;
const errorHandling = errors.errorHandling;
const commonMeta = require('../methods/helpers/setCommonMeta.ts');
const { getConfigSync } = require('@pryv/boiler');

export default produceHandleErrorMiddleware;
export { produceHandleErrorMiddleware };
(async () => {
  await commonMeta.loadSettings();
})();

/**
 * Error route handling.
 */
function produceHandleErrorMiddleware (logging: { getLogger: (name: string) => Logger }) {
  const logger = logging.getLogger('error-middleware');
  const config = getConfigSync();
  const isAuditActive = config.get('audit:active');
  let audit: { errorApiCall: (context: unknown, error: unknown) => Promise<unknown> } | undefined;
  if (isAuditActive) {
    audit = require('audit').default;
  }
  // NOTE next is not used, since the request is terminated on all errors.

  return async function handleError (error: Error & { status?: number; httpStatus?: number }, req: Request & { context?: unknown }, res: Response, next: NextFunction) {
    if (!(error instanceof APIError) && error.status) {
      // it should be coming from Express' bodyParser: just wrap the error
      error = errorsFactory.invalidRequestStructure(error.message);
    }
    if (req.context != null) {
      // context is not initialized in case of malformed JSON
      // An audit-store failure must not stop the error answer, nor reject
      // unhandled out of this async handler and take the worker down.
      try {
        if (isAuditActive) { await audit!.errorApiCall(req.context, error); }
      } catch (auditError) {
        logger.error('Failed to audit an API error', auditError);
      }
      // req.context.tracing.finishSpan('express1');
    }
    errorHandling.logError(error, req, logger);
    // A streamed response can fail after its headers (and some body) are on the
    // wire. The status can no longer change, and writing one throws inside this
    // async handler, i.e. an unhandled rejection that takes the worker down,
    // while the client waits forever for the bytes its Content-Length promised.
    // The error is audited and logged above; cutting the connection is the only
    // honest answer left.
    if (res.headersSent) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    // Error-scoped response headers (e.g. WWW-Authenticate challenges
    // for auth-scheme failures) ride on the error object itself.
    const errorHeaders = (error as { httpHeaders?: Record<string, string> }).httpHeaders;
    if (errorHeaders != null) {
      for (const [name, value] of Object.entries(errorHeaders)) res.setHeader(name, value);
    }
    res
      .status(error.httpStatus || 500)
      .json(commonMeta.setCommonMeta({
        error: errorHandling.getPublicErrorData(error)
      }));
  };
}
