/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const errors = require('errors').factory;
/**
 * Middleware to allow overriding HTTP method, "Authorization" header and JSON
 * body content by sending them as fields in urlencoded requests. Does not
 * perform request body parsing (expects req.body to exist), so must be executed
 * after e.g. bodyParser middleware.
 * @param {RequestWithOriginalMethodAndBody} req
 * @param {express$Response} res
 * @param {express$NextFunction} next
 * @returns {any}
 */
function normalizeRequest (req, res, next) {
  if (!req.is('application/x-www-form-urlencoded')) {
    return next();
  }
  const body = req.body;
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
      return next(errors.invalidRequestStructure(err.message));
    }
  }
  next();
}
module.exports = normalizeRequest;
