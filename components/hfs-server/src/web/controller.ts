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
const business = require('business');
const cls = require('../tracing/cls.ts').default;

type HfsContext = unknown;
type ControllerHandler = (ctx: HfsContext, req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;
type ExpressHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

function mount (ctx: HfsContext, handler: ControllerHandler): ExpressHandler {
  return catchAndNext(handler.bind(null, ctx) as ExpressHandler);
}
function catchAndNext (handler: ExpressHandler): ExpressHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      return await handler(req, res, next);
    } catch (err) {
      storeErrorInTrace(err);
      const e = err as Error & { constructor: { name: string } };
      if (e.constructor.name === 'ServiceNotAvailableError') {
        return next(errors.apiUnavailable(e.message));
      }
      if (err instanceof business.types.errors.InputTypeError) {
        return next(errors.invalidRequestStructure(e.message));
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
function storeErrorInTrace (err: unknown): void {
  try {
    const root = cls.getRootSpan();
    if (root == null) { return; }
    root.setTag('error', true);
    const e = err as { message?: string };
    if (e.message != null) { root.setTag(TAG_ERROR_MESSAGE, e.message); }
  } catch (err) {
    // IGNORE
  }
}
// --------------------------------------------------------------------- factory
export default function (ctx: HfsContext) {
  return {
    storeSeriesData: mount(ctx, require('./op/store_series_data.ts').default),
    querySeriesData: mount(ctx, require('./op/query_series_data.ts').default),
    storeSeriesBatch: mount(ctx, require('./op/store_series_batch.ts').default)
  };
}

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
