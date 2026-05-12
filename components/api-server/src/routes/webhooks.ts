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
/**
 * Webhooks route handling.
 *
 * @param api The API object for registering methods
 */
export default function (expressApp: any, app: any) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.get(Paths.Webhooks, loadAccessMiddleware, setMethodId('webhooks.get'), function (req: any, res: any, next: any) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  expressApp.get(Paths.Webhooks + '/:id', loadAccessMiddleware, setMethodId('webhooks.getOne'), function (req: any, res: any, next: any) {
    const params = Object.assign({ id: req.params.id }, req.query);
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Webhooks, loadAccessMiddleware, setMethodId('webhooks.create'), function (req: any, res: any, next: any) {
    api.call(req.context, req.body, methodCallback(res, next, 201));
  });
  expressApp.put(Paths.Webhooks + '/:id', loadAccessMiddleware, setMethodId('webhooks.update'), function (req: any, res: any, next: any) {
    const params = { id: req.params.id, update: req.body };
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.delete(Paths.Webhooks + '/:id', loadAccessMiddleware, setMethodId('webhooks.delete'), function (req: any, res: any, next: any) {
    const params = Object.assign({ id: req.params.id }, req.query);
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Webhooks + '/:id/test', loadAccessMiddleware, setMethodId('webhooks.test'), function (req: any, res: any, next: any) {
    const params = Object.assign({ id: req.params.id }, req.query);
    api.call(req.context, params, methodCallback(res, next, 200));
  });
};
