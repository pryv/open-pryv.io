/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
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
function produceHandleErrorMiddleware (logging: { getLogger: (name: string) => unknown }) {
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
      if (isAuditActive) { await audit!.errorApiCall(req.context, error); }
      // req.context.tracing.finishSpan('express1');
    }
    errorHandling.logError(error, req, logger);
    res
      .status(error.httpStatus || 500)
      .json(commonMeta.setCommonMeta({
        error: errorHandling.getPublicErrorData(error)
      }));
  };
}
