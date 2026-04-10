/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const errors = require('errors').factory;
const business = require('business');
const opentracing = require('opentracing');
const cls = require('../tracing/cls');
/**
 * @param {Context} ctx
 * @param {ControllerMethod} handler
 * @returns {any}
 */
function mount (ctx, handler) {
  return catchAndNext(handler.bind(null, ctx));
}
/**
 * @param {ExpressHandler} handler
 * @returns {any}
 */
function catchAndNext (handler) {
  return async (req, res, next) => {
    try {
      return await handler(req, res, next);
    } catch (err) {
      storeErrorInTrace(err);
      if (err.constructor.name === 'ServiceNotAvailableError') {
        return next(errors.apiUnavailable(err.message));
      }
      if (err instanceof business.types.errors.InputTypeError) {
        return next(errors.invalidRequestStructure(err.message));
      }
      next(err);
    }
  };
}
const TAG_ERROR_MESSAGE = 'error.message';
// Tries to store the current error in the active trace. Traces are then
// all closed down by the 'trace' middleware, yielding a correct error trace
// in every case.
//
// NOTE This method should not throw an error!
//
/**
 * @param {any} err
 * @returns {void}
 */
function storeErrorInTrace (err) {
  try {
    const Tags = opentracing.Tags;
    const root = cls.getRootSpan();
    if (root == null) { return; }
    root.setTag(Tags.ERROR, true);
    if (err.message != null) { root.setTag(TAG_ERROR_MESSAGE, err.message); }
  } catch (err) {
    // IGNORE
  }
}
// --------------------------------------------------------------------- factory
module.exports = function (ctx) {
  return {
    storeSeriesData: mount(ctx, require('./op/store_series_data')),
    querySeriesData: mount(ctx, require('./op/query_series_data')),
    storeSeriesBatch: mount(ctx, require('./op/store_series_batch'))
  };
};

/**
 * @typedef {(
 *   ctx: Context,
 *   req: express$Request,
 *   res: express$Response,
 *   next: express$NextFunction
 * ) => unknown} ControllerMethod
 */

/**
 * @typedef {(
 *   req: express$Request,
 *   res: express$Response,
 *   next: express$NextFunction
 * ) => unknown} ExpressHandler
 */
