/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type {} from 'node:fs';

const express = require('express');
const middleware = require('middleware');
/**
 * The Express app definition.
 */
module.exports = function expressApp (commonHeadersMiddleware, errorsMiddleware, requestTraceMiddleware) {
  const app = express();
  /** Called once routes are defined on app, allows finalizing middleware stack
   * with things like error handling.
   **/
  function routesDefined () {
    app.use(errorsMiddleware);
  }
  app.disable('x-powered-by');
  app.use(middleware.subdomainToPath([]));
  app.use(requestTraceMiddleware);
  app.use(express.json());
  app.use(commonHeadersMiddleware);
  return {
    expressApp: app,
    routesDefined
  };
};

/**
 * @typedef {{
 *   expressApp: express$Application;
 *   routesDefined: () => unknown;
 * }} AppAndEndWare
 */
