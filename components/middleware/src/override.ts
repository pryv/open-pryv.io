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

// The verbs the API routes answer; `_method` cannot name any other.
const OVERRIDE_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

/**
 * Middleware to allow overriding HTTP method, "Authorization" header and JSON
 * body content by sending them as fields in urlencoded requests. Does not
 * perform request body parsing (expects req.body to exist), so must be executed
 * after e.g. bodyParser middleware.
 *
 * Each field yields what the real thing could carry, or the request is
 * refused: `_method` one of the API verbs, `_auth` one string, `_json` an
 * object or an array (what the JSON body parser accepts).
 */
function normalizeRequest (req: PryvRequest, res: Response, next: NextFunction) {
  if (!req.is('application/x-www-form-urlencoded')) {
    return next();
  }
  const body = req.body as Record<string, unknown>;
  if (body == null || typeof body !== 'object') { return next(); }
  if (body._method != null) {
    const method = typeof body._method === 'string' ? body._method.toUpperCase() : null;
    if (method == null || !OVERRIDE_METHODS.has(method)) {
      return next(errors.invalidRequestStructure('"_method" must be one of ' + [...OVERRIDE_METHODS].join(', ') + '.'));
    }
    req.originalMethod = req.originalMethod || req.method;
    req.method = method;
    delete body._method;
  }
  if (body._auth != null && body._auth !== '') {
    if (typeof body._auth !== 'string') {
      return next(errors.invalidRequestStructure('"_auth" must be a single string.'));
    }
    if (req.headers.authorization) {
      req.headers['original-authorization'] = req.headers.authorization;
    }
    req.headers.authorization = body._auth;
    delete body._auth;
  }
  if (typeof body._json === 'string') {
    req.originalBody = req.originalBody || body;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body._json);
    } catch (err) {
      return next(errors.invalidRequestStructure((err as Error).message));
    }
    if (parsed == null || typeof parsed !== 'object') {
      return next(errors.invalidRequestStructure('"_json" must hold a JSON object or array.'));
    }
    req.body = parsed;
  }
  next();
}
export default normalizeRequest;
