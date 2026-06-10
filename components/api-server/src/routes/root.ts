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
const middleware = require('middleware');
const commonMeta = require('../methods/helpers/setCommonMeta.ts');
const methodCallback = require('./methodCallback.ts').default;
const Paths = require('./Paths.ts');
const getAuth = require('middleware/src/getAuth.ts').default;
const { setMethodId } = require('middleware');

(async () => {
  await commonMeta.loadSettings();
})();


// Handlers for path roots at various places; handler for batch calls and
// access-info.
function root (expressApp: ExpressApp, app: AppLike): void {
  const api = app.api;

  const customAuthStepFn = app.getCustomAuthFunction('root.js');
  const initContextMiddleware = middleware.initContext(app.storageLayer, customAuthStepFn);
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  // Bootstrap to user's Pryv page (i.e. browser home).
  expressApp.get('/', rootIndex);
  expressApp.get(Paths.UserRoot + '/', rootIndex);
  // Wrong-core check (DNSless multi-core). Mounted BEFORE
  // getAuth/initContextMiddleware so we don't waste cycles loading user
  // context for requests that will be rejected with 421. No-op in
  // single-core mode.
  expressApp.all(Paths.UserRoot + '/*', middleware.checkUserCore);
  // Load user for all user API methods.
  expressApp.all(Paths.UserRoot + '/*', getAuth);
  expressApp.all(Paths.UserRoot + '/*', initContextMiddleware);
  // Current access information.
  expressApp.get(Paths.UserRoot + '/access-info',
    setMethodId('getAccessInfo'),
    loadAccessMiddleware,
    function (req: PryvRequest, res: Response, next: NextFunction) {
      api.call(req.context, req.query,
        methodCallback(res, next, 200));
    });

  // Batch request of multiple API method calls.
  expressApp.post(Paths.UserRoot,
    initContextMiddleware,
    setMethodId('callBatch'),
    loadAccessMiddleware,
    function (req: PryvRequest, res: Response, next: NextFunction) {
      api.call(req.context, req.body,
        methodCallback(res, next, 200));
    }
  );
}
export default root;
export { root };
// Renders a greeting message; this route is displayed on the various forms
// of roots ('/', 'foo.pryv.me/')
//
function rootIndex (req: Request, res: Response): void {
  const devSiteURL = 'https://pryv.github.io/';
  const result = commonMeta.setCommonMeta({});

  if (req.accepts('application/json')) {
    res.json(Object.assign(result, {
      cheersFrom: 'Pryv API',
      learnMoreAt: devSiteURL
    }));
  } else {
    res.send('# Cheers from the Pryv API!\n\n' +
            '- API version: ' +
            result.meta.apiVersion +
            '\n' +
            '- Server time: ' +
            result.meta.serverTime +
            '\n\n' +
            'Learn more at ' +
            devSiteURL);
  }
}
