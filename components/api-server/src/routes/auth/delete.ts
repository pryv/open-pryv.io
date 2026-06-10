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
const methodCallback = require('../methodCallback.ts').default;
const middleware = require('middleware');

type PryvContext = {
  user: { username?: string };
  authorizationHeader?: string | string[];
};
type PryvRequest = Request & { context?: PryvContext };

/**
 * Routes for users
 */
export default function (expressApp: ExpressApp, app: AppLike): void {
  const api = app.api;
  const initContextMiddleware = middleware.initContext(app.storageLayer);
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.delete('/users/:username',
    middleware.getAuth,
    initContextMiddleware,
    middleware.setMethodId('auth.delete'),
    function (req: PryvRequest, res: Response, next: NextFunction) {
      loadAccessMiddleware(req, res, function (err: unknown) { // eslint-disable-line n/handle-callback-err
        // ignore errors as a valid adminAuthentication token might be presented
        next();
      });
    },
    function callMethodAuthDelete (req: PryvRequest, res: Response, next: NextFunction) {
      // express @types narrow params/headers slightly — both behave as `string`
      // at runtime here (single-valued path param + standard Authorization header).
      req.context!.user.username = req.params.username as string;
      req.context!.authorizationHeader = req.headers.authorization;
      api.call(req.context, req.params, methodCallback(res, next, 200));
    }
  );
};
