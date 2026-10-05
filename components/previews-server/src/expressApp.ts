/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { RequestHandler, ErrorRequestHandler, Express } from 'express';
const require = createRequire(import.meta.url);

const express = require('express');
const middleware = require('middleware');
const { getConfigSync } = require('@pryv/boiler');
const { configureTrustedProxies, expressTrustProxy } = require('middleware/src/clientIp.ts');
const { usernameInHost, ignoredUsernameSubdomains } = require('business/src/usernameSubdomains.ts');
/**
 * The Express app definition.
 */
export default function expressApp (commonHeadersMiddleware: RequestHandler, errorsMiddleware: ErrorRequestHandler, requestTraceMiddleware: RequestHandler) {
  const app = express();
  configureTrustedProxies(getConfigSync().get('http:trustedProxies'));
  app.set('trust proxy', expressTrustProxy);
  /** Called once routes are defined on app, allows finalizing middleware stack
   * with things like error handling.
   **/
  function routesDefined () {
    app.use(errorsMiddleware);
  }
  app.disable('x-powered-by');
  app.use(middleware.noSniff);
  // Username-in-host rewrite decided as the API server and the HFS worker decide
  // it: never in dnsLess mode, and never for the core's own or reserved subdomains.
  if (usernameInHost(getConfigSync())) {
    app.use(middleware.subdomainToPath(['/clean-up-cache'], ignoredUsernameSubdomains(getConfigSync())));
  }
  app.use(requestTraceMiddleware);
  app.use(express.json());
  app.use(commonHeadersMiddleware);
  return {
    expressApp: app,
    routesDefined
  };
};

type AppAndEndWare = {
  expressApp: Express;
  routesDefined: () => unknown;
};
