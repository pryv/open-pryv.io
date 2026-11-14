/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { AppLike, PryvRequest } from './_types.ts';
import type { Response, NextFunction, Application as ExpressApp } from 'express';
const require = createRequire(import.meta.url);
const methodCallback = require('./methodCallback.ts').default;
const Paths = require('./Paths.ts');
const middleware = require('middleware');
const { setMethodId } = require('middleware');
const tryCoerceStringValues = require('../schema/validation.ts').tryCoerceStringValues;

// Audit trail routes (the rows themselves are read with events.get on the
// `:_audit:` streams; these are computed views of them).
export default function (expressApp: ExpressApp, app: AppLike) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.get(Paths.Audit + '/summary', setMethodId('audit.getSummary'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    const params = Object.assign({}, req.query);
    tryCoerceStringValues(params, {
      fromTime: 'number',
      toTime: 'number',
      accessIds: 'array'
    });
    api.call(req.context, params, methodCallback(res, next, 200));
  });
}
