/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const methodCallback = require('./methodCallback.ts').default;
const Paths = require('./Paths.ts');
const middleware = require('middleware');
const { setMethodId } = require('middleware');
const tryCoerceStringValues = require('../schema/validation.ts').tryCoerceStringValues;
// Shared accesses route handling.
export default function (expressApp: any, app: any) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.get(Paths.Accesses, setMethodId('accesses.get'), loadAccessMiddleware, function (req: any, res: any, next: any) {
    const params = Object.assign({}, req.query);
    tryCoerceStringValues(params, {
      includeExpired: 'boolean',
      includeDeletions: 'boolean'
    });
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Accesses, setMethodId('accesses.create'), loadAccessMiddleware, function (req: any, res: any, next: any) {
    api.call(req.context, req.body, methodCallback(res, next, 201));
  });
  expressApp.get(Paths.Accesses + '/:id', setMethodId('accesses.getOne'), loadAccessMiddleware, function (req: any, res: any, next: any) {
    const params: any = Object.assign({ id: req.params.id }, req.query);
    tryCoerceStringValues(params, { includeHistory: 'boolean' });
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.put(Paths.Accesses + '/:id', setMethodId('accesses.update'), loadAccessMiddleware, function (req: any, res: any, next: any) {
    const params = { id: req.params.id, update: req.body };
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.delete(Paths.Accesses + '/:id', setMethodId('accesses.delete'), loadAccessMiddleware, function (req: any, res: any, next: any) {
    const params = Object.assign({ id: req.params.id }, req.query);
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Accesses + '/check-app', setMethodId('accesses.checkApp'), loadAccessMiddleware, function (req: any, res: any, next: any) {
    api.call(req.context, req.body, methodCallback(res, next, 200));
  });
};
