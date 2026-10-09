/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { AppLike, PryvRequest } from '../_types.ts';
import type { Request, Response, NextFunction, Application as ExpressApp } from 'express';
const require = createRequire(import.meta.url);
const errors = require('errors').factory;
const middleware = require('middleware');
const { setMethodId } = require('middleware');
const methodCallback = require('../methodCallback.ts').default;
const Paths = require('../Paths.ts');



/**
 * Auth routes.
 *
 * @param api The API object for registering methods
 */
export default function (expressApp: ExpressApp, app: AppLike) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  // Returns true if the given `obj` has all of the property values identified
  // by the names contained in `keys`.
  //
  function hasProperties (obj: unknown, keys: string[]): boolean {
    if (obj == null) {
      return false;
    }
    if (typeof obj !== 'object') {
      return false;
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) { return false; }
    }
    return true;
  }
  // Define local routes
  expressApp.get(Paths.Auth + '/who-am-i', function routeWhoAmI (_req: PryvRequest, _res: Response, next: NextFunction) {
    return next(errors.goneResource());
  });
  expressApp.post(Paths.Auth + '/login', setMethodId('auth.login'), function routeLogin (req: PryvRequest, res: Response, next: NextFunction) {
    if (typeof req.body !== 'object' ||
            req.body == null ||
            !hasProperties(req.body, ['username', 'password', 'appId'])) {
      return next(errors.invalidOperation('Missing parameters: username, password and appId are required.'));
    }
    const body = req.body;
    const params = {
      username: body.username,
      password: body.password,
      appId: body.appId,
      // some browsers provide origin, some provide only referer
      origin: req.headers.origin || req.headers.referer || ''
    };
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Auth + '/logout', setMethodId('auth.logout'), loadAccessMiddleware, function routeLogout (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, {}, methodCallback(res, next, 200));
  });
  return {
    hasProperties
  };
};
