/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const express = require('express');
const _ = require('lodash');
const bodyParser = require('body-parser');
const middleware = require('middleware');
const Paths = require('./routes/Paths');
const { getConfig } = require('@pryv/boiler');
// ------------------------------------------------------------ express app init
// Creates and returns an express application with a standard set of middleware.
// `version` should be the version string you want to show to API clients.
//
/**
 * @returns {Promise<any>}
 */
async function expressAppInit (logging) {
  const config = await getConfig();
  const app = express(); // register common middleware
  const commonHeadersMiddleware = await middleware.commonHeaders();
  const requestTraceMiddleware = middleware.requestTrace(app, logging);
  // register common middleware
  app.disable('x-powered-by');
  // Install middleware to hoist the username into the request path.
  //
  // NOTE Insert this bit in front of 'requestTraceMiddleware' to also see
  //  username in logged paths.
  //
  const ignorePaths = _.chain(Paths)
    .filter((e) => _.isString(e))
    .filter((e) => e.indexOf(Paths.Params.Username) < 0)
    .value();
  if (!config.get('dnsLess:isActive')) {
    const coreId = config.get('core:id');
    const ignoredSubdomains = coreId && coreId !== 'single' ? [coreId] : [];
    app.use(middleware.subdomainToPath(ignorePaths, ignoredSubdomains));
  }
  // Parse JSON bodies:
  app.use(bodyParser.json({
    limit: config.get('uploads:maxSizeMb') + 'mb'
  }));
  // This object will contain key-value pairs, where the value can be a string
  // or array (when extended is false), or any type (when extended is true).
  app.use(bodyParser.urlencoded({
    extended: false
  }));
  // Other middleware:
  app.use(requestTraceMiddleware);
  app.use(middleware.override);
  app.use(commonHeadersMiddleware);
  return app;
}
module.exports = expressAppInit;
