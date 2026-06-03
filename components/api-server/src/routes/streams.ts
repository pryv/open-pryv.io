/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction, Application as ExpressApp } from 'express';
const require = createRequire(import.meta.url);
const methodCallback = require('./methodCallback.ts').default;
const Paths = require('./Paths.ts');
const tryCoerceStringValues = require('../schema/validation.ts').tryCoerceStringValues;
const middleware = require('middleware');
const { setMethodId } = require('middleware');

type AppLike = {
  api: { call: (...args: unknown[]) => unknown };
  storageLayer: unknown;
};
type PryvRequest = Request & { context?: unknown };

// Event streams route handling.
export default function (expressApp: ExpressApp, app: AppLike): void {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.get(Paths.Streams, loadAccessMiddleware, setMethodId('streams.get'), function (req: PryvRequest, res: Response, next: NextFunction) {
    const params = Object.assign({}, req.query);
    tryCoerceStringValues(params, {
      includeDeletionsSince: 'number'
    });
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Streams, loadAccessMiddleware, setMethodId('streams.create'), function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.body, methodCallback(res, next, 201));
  });
  expressApp.put(Paths.Streams + '/:id', loadAccessMiddleware, setMethodId('streams.update'), function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { id: req.params.id, update: req.body }, methodCallback(res, next, 200));
  });
  expressApp.delete(Paths.Streams + '/:id', loadAccessMiddleware, setMethodId('streams.delete'), function (req: PryvRequest, res: Response, next: NextFunction) {
    const params = Object.assign({ id: req.params.id }, req.query);
    tryCoerceStringValues(params, {
      mergeEventsWithParent: 'boolean'
    });
    api.call(req.context, params, methodCallback(res, next, 200));
  });
};
