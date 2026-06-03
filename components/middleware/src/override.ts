/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
const require = createRequire(import.meta.url);

const errors = require('errors').factory;

type PryvRequest = Request & { originalMethod?: string; originalBody?: unknown };
/**
 * Middleware to allow overriding HTTP method, "Authorization" header and JSON
 * body content by sending them as fields in urlencoded requests. Does not
 * perform request body parsing (expects req.body to exist), so must be executed
 * after e.g. bodyParser middleware.
 */
function normalizeRequest (req: PryvRequest, res: Response, next: NextFunction) {
  if (!req.is('application/x-www-form-urlencoded')) {
    return next();
  }
  const body = req.body as Record<string, string>;
  if (body == null || typeof body !== 'object') { return next(); }
  if (typeof body._method === 'string') {
    req.originalMethod = req.originalMethod || req.method;
    req.method = body._method.toUpperCase();
    delete body._method;
  }
  if (body._auth) {
    if (req.headers.authorization) {
      req.headers['original-authorization'] = req.headers.authorization;
    }
    req.headers.authorization = body._auth;
    delete body._auth;
  }
  if (typeof body._json === 'string') {
    req.originalBody = req.originalBody || body;
    try {
      req.body = JSON.parse(body._json);
    } catch (err) {
      return next(errors.invalidRequestStructure((err as Error).message));
    }
  }
  next();
}
export default normalizeRequest;
