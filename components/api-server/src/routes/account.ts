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
// User account details route handling.
export default function (expressApp: any, app: any) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.get(Paths.Account, setMethodId('account.get'), loadAccessMiddleware, function (req: any, res: any, next: any) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  expressApp.put(Paths.Account, setMethodId('account.update'), loadAccessMiddleware, function (req: any, res: any, next: any) {
    api.call(req.context, { update: req.body }, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Account + '/change-password', setMethodId('account.changePassword'), loadAccessMiddleware, function (req: any, res: any, next: any) {
    api.call(req.context, req.body, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Account + '/request-password-reset', setMethodId('account.requestPasswordReset'), function (req: any, res: any, next: any) {
    const params = req.body;
    params.origin = req.headers.origin;
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Account + '/reset-password', setMethodId('account.resetPassword'), function (req: any, res: any, next: any) {
    const params = req.body;
    params.origin = req.headers.origin;
    api.call(req.context, params, methodCallback(res, next, 200));
  });
};
