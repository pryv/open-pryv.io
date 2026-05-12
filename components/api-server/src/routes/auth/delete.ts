/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const methodCallback = require('../methodCallback.ts').default;
const middleware = require('middleware');

/**
 * Routes for users
 */
export default function (expressApp: any, app: any) {
  const api = app.api;
  const initContextMiddleware = middleware.initContext(app.storageLayer);
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.delete('/users/:username',
    middleware.getAuth,
    initContextMiddleware,
    middleware.setMethodId('auth.delete'),
    function (req: any, res: any, next: any) {
      loadAccessMiddleware(req, res, function (err: any) { // eslint-disable-line n/handle-callback-err
        // ignore errors as a valid adminAuthentication token might be presented
        next();
      });
    },
    function callMethodAuthDelete (req: any, res: any, next: any) {
      req.context.user.username = req.params.username;
      req.context.authorizationHeader = req.headers.authorization;
      api.call(req.context, req.params, methodCallback(res, next, 200));
    }
  );
};
