/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
const require = createRequire(import.meta.url);

/**
 * Just validates that the request is of one of the specified content types; otherwise returns a
 * 415 error.
 */

const errors = require('errors').factory;

/**
 * Accepts a variable number of content types as arguments.
 */
function checkContentType (...acceptedTypes: string[]) {
  const count = acceptedTypes.length;
  return function (req: Request, res: Response, next: NextFunction) {
    if (count < 1) { return next(); }

    const contentType = req.headers['content-type'];
    if (!contentType) { return next(errors.missingHeader('Content-Type')); }

    for (let i = 0; i < count; i++) {
      if (req.is(acceptedTypes[i])) {
        return next();
      }
    }

    next(errors.unsupportedContentType(contentType));
  };
}

const json = checkContentType('application/json');
const jsonOrForm = checkContentType('application/json', 'application/x-www-form-urlencoded');
const multipartOrJson = checkContentType('multipart/form-data', 'application/json');

export { json, jsonOrForm, multipartOrJson };
