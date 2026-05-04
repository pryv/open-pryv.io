/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const middleware = require('middleware');
const commonMeta = require('../methods/helpers/setCommonMeta');
const methodCallback = require('./methodCallback');
const Paths = require('./Paths');
const getAuth = require('middleware/src/getAuth');
const { setMethodId } = require('middleware');

(async () => {
  await commonMeta.loadSettings();
})();
// Handlers for path roots at various places; handler for batch calls and
// access-info.
/**
 * @param {express$Application} expressApp
 * @param {Application} app
 * @returns {void}
 */
function root (expressApp, app) {
  const api = app.api;

  const customAuthStepFn = app.getCustomAuthFunction('root.js');
  const initContextMiddleware = middleware.initContext(app.storageLayer, customAuthStepFn);
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  // Bootstrap to user's Pryv page (i.e. browser home).
  expressApp.get('/', rootIndex);
  expressApp.get(Paths.UserRoot + '/', rootIndex);
  // Plan 27 Phase 2: wrong-core check (DNSless multi-core).
  // Mounted BEFORE getAuth/initContextMiddleware so we don't waste cycles
  // loading user context for requests that will be rejected with 421.
  // No-op in single-core mode.
  expressApp.all(Paths.UserRoot + '/*', middleware.checkUserCore);
  // Load user for all user API methods.
  expressApp.all(Paths.UserRoot + '/*', getAuth);
  expressApp.all(Paths.UserRoot + '/*', initContextMiddleware);
  // Current access information.
  expressApp.get(Paths.UserRoot + '/access-info',
    setMethodId('getAccessInfo'),
    loadAccessMiddleware,
    function (req, res, next) {
      api.call(req.context, req.query,
        methodCallback(res, next, 200));
    });

  // Batch request of multiple API method calls.
  expressApp.post(Paths.UserRoot,
    initContextMiddleware,
    setMethodId('callBatch'),
    loadAccessMiddleware,
    function (req, res, next) {
      api.call(req.context, req.body,
        methodCallback(res, next, 200));
    }
  );
}
module.exports = root;

// Renders a greeting message; this route is displayed on the various forms
// of roots ('/', 'foo.pryv.me/')
//
/**
 * @param {express$Request} req
 * @returns {void}
 */
function rootIndex (req, res) {
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
