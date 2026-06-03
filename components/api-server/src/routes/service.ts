/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction, Application as ExpressApp } from 'express';
const require = createRequire(import.meta.url);
const Paths = require('./Paths.ts');
const methodCallback = require('./methodCallback.ts').default;
const { setMethodId } = require('middleware');

type AppLike = { api: { call: (...args: unknown[]) => unknown } };
type PryvRequest = Request & { context?: unknown };

/**
 * Set up events route handling.
 */
export default function (expressApp: ExpressApp, app: AppLike) {
  const api = app.api;
  expressApp.get(Paths.Service + '/info', setMethodId('service.info'), function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  // Backward-compatible alias (plural)
  expressApp.get(Paths.Service + '/infos', setMethodId('service.info'), function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
};
