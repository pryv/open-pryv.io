/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const { DummyTracing } = require('tracing');

class MinimalMethodContext {
  source;

  user;

  username;

  access;

  originalQuery;

  _tracing;
  constructor (req) {
    this.source = {
      name: 'http',
      ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress
    };
    this.originalQuery = structuredClone(req.query);
    if (this.originalQuery?.auth) { delete this.originalQuery.auth; }
    this._tracing = req.tracing;
  }

  get tracing () {
    if (this._tracing == null) {
      console.log('Null tracer');
      this._tracing = new DummyTracing();
    }
    return this._tracing;
  }

  set tracing (tracing) {
    this._tracing = tracing;
  }
}
/**
 * Helper for express to set a Minimal Context, for methods that does use the standard MethodContext.
 * Note: will have no effect is a context already exists.
 * @param {express$Request} req
 * @param {express$Response} res
 * @param {express$NextFunction} next
 * @returns {any}
 */
function setMinimalMethodContext (req, res, next) {
  if (req.context) {
    return next(new Error('Context already set'));
  }
  req.context = new MinimalMethodContext(req);
  next();
}
module.exports = setMinimalMethodContext;
