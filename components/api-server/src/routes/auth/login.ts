/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { AppLike } from '../_types.ts';
import type { Request, Response, NextFunction, Application as ExpressApp } from 'express';
const require = createRequire(import.meta.url);
const cookieParser = require('cookie-parser');
const errors = require('errors').factory;
const middleware = require('middleware');
const { setMethodId } = require('middleware');
const methodCallback = require('../methodCallback.ts').default;
const Paths = require('../Paths.ts');
const { getConfigSync } = require('@pryv/boiler');

type PryvRequest = Request & { context?: { user?: { username?: string; [k: string]: unknown }; [k: string]: unknown } };

/**
 * Auth routes.
 *
 * @param api The API object for registering methods
 */
export default function (expressApp: ExpressApp, app: AppLike) {
  const config = getConfigSync();
  const api = app.api;
  const ms14days = 1000 * 60 * 60 * 24 * 14;
  const sessionMaxAge = config.get('auth:sessionMaxAge') || ms14days;
  const ssoCookieDomain = config.get('auth:ssoCookieDomain') || config.get('http:ip');
  const ssoCookieSignSecret = config.get('auth:ssoCookieSignSecret') || 'Hallowed Be Thy Name, O Node';
  const ssoCookieSecure = process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test';
  const ssoHttpOnly = true;
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
  function setSSOCookie (data: Record<string, unknown>, res: Response): void {
    res.cookie('sso', data, {
      domain: ssoCookieDomain,
      maxAge: sessionMaxAge,
      secure: ssoCookieSecure,
      signed: true,
      httpOnly: ssoHttpOnly
    });
  }
  function clearSSOCookie (res: Response): void {
    res.clearCookie('sso', {
      domain: ssoCookieDomain,
      secure: ssoCookieSecure,
      httpOnly: ssoHttpOnly
    });
  }
  // Define local routes
  expressApp.all(Paths.Auth + '*', cookieParser(ssoCookieSignSecret));
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
    api.call(req.context, params, function (err: Error | null, result: { token?: string; [k: string]: unknown }) {
      if (err) { return next(err); }
      setSSOCookie({ username: req.context?.user?.username, token: result.token }, res);
      methodCallback(res, next, 200)(err, result);
    });
  });
  expressApp.post(Paths.Auth + '/logout', setMethodId('auth.logout'), loadAccessMiddleware, function routeLogout (req: PryvRequest, res: Response, next: NextFunction) {
    clearSSOCookie(res);
    api.call(req.context, {}, methodCallback(res, next, 200));
  });
  return {
    hasProperties
  };
};
