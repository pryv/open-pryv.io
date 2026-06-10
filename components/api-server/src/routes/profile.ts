/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { AppLike, PryvRequest } from './_types.ts';
import type { Request, Response, NextFunction, Application as ExpressApp } from 'express';
const require = createRequire(import.meta.url);
const methodCallback = require('./methodCallback.ts').default;
const Paths = require('./Paths.ts');
const middleware = require('middleware');
const { setMethodId } = require('middleware');


// Profile route handling.
export default function (expressApp: ExpressApp, app: AppLike) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.get(Paths.Profile + '/public', setMethodId('profile.getPublic'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  expressApp.put(Paths.Profile + '/public', setMethodId('profile.update'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { id: 'public', update: req.body }, methodCallback(res, next, 200));
  });
  expressApp.get(Paths.Profile + '/app', setMethodId('profile.getApp'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  expressApp.put(Paths.Profile + '/app', setMethodId('profile.updateApp'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    const params = { update: req.body };
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.get(Paths.Profile + '/private', setMethodId('profile.get'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, Object.assign(req.query, { id: 'private' }), methodCallback(res, next, 200));
  });
  expressApp.put(Paths.Profile + '/private', setMethodId('profile.update'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { id: 'private', update: req.body }, methodCallback(res, next, 200));
  });
};
