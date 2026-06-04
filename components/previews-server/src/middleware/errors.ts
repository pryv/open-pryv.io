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
const APIError = require('errors').APIError;
const errors = require('errors').factory;
const { getLogger } = require('@pryv/boiler');

/**
 * Error route handling.
 */
export default function (logging: unknown) {
  const logger = getLogger('routes');

  return function handleError (error: Error & { httpStatus?: number }, req: Request, res: Response, next: NextFunction) {
    if (!(error instanceof APIError)) {
      error = errors.unexpectedError(error);
    }

    errorHandling.logError(error, req, logger);
    res
      .status(error.httpStatus || 500)
      .json({
        error: errorHandling.getPublicErrorData(error)
      });
  };
};
