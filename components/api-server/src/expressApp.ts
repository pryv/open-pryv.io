/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
const require = createRequire(import.meta.url);
const express = require('express');
const middleware = require('middleware');
const Paths = require('./routes/Paths.ts');
const { getConfig } = require('@pryv/boiler');
const { usernameInHost, ignoredUsernameSubdomains } = require('business/src/usernameSubdomains.ts');
const { configureTrustedProxies, expressTrustProxy } = require('middleware/src/clientIp.ts');
const { effectiveMaxSizeMb } = require('./middleware/uploads.ts');
// ------------------------------------------------------------ express app init
// Creates and returns an express application with a standard set of middleware.
// `version` should be the version string you want to show to API clients.
//
async function expressAppInit (logging: { getLogger: (name: string) => unknown }) {
  const config = await getConfig();
  const app = express(); // register common middleware
  // Client addresses (audit source.ip, req.ip) honour X-Forwarded-For only from
  // http.trustedProxies.
  configureTrustedProxies(config.get('http:trustedProxies'));
  app.set('trust proxy', expressTrustProxy);
  const commonHeadersMiddleware = await middleware.commonHeaders();
  const requestTraceMiddleware = middleware.requestTrace(app, logging);
  // register common middleware
  app.disable('x-powered-by');
  // First in the chain so every answer carries it, including the errors raised
  // by the body parsers below and the HTML page of the OAuth2 routes.
  app.use(middleware.noSniff);
  // Install middleware to hoist the username into the request path.
  //
  // NOTE Insert this bit in front of 'requestTraceMiddleware' to also see
  //  username in logged paths.
  //
  const ignorePaths = Object.values(Paths)
    .filter((e) => typeof e === 'string')
    .filter((e) => e.indexOf(Paths.Params.Username) < 0);
  if (usernameInHost(config)) {
    // Keep the core's own subdomain and the distribution-reserved service
    // subdomains out of the username-rewriter. Without this, e.g.
    // `access.pryv.me/service/info` (6 chars, matches username regex) gets
    // rewritten to `/access/service/info` and falls through to the username
    // router. reg/access/mfa are the distribution's reserved names (see
    // DnsServer.RESERVED_SERVICE_NAMES); operator-owned staticEntries names
    // (sw, mail, etc.) and hosted-site names (answered before express) are
    // harvested from config too. The HFS worker uses the same list.
    const ignoredSubdomains = ignoredUsernameSubdomains(config);

    // When Host matches a reserved service subdomain (reg/access/mfa), the
    // client-facing URL is rootless — e.g. `reg.pryv.me/perki/server` or
    // `access.pryv.me/access/`. Internally all the handlers live under
    // `/reg/*`, so prepend `/reg` before route matching. Idempotent for
    // clients that still send the `/reg/` prefix. Required for v1-style
    // URL shapes; tests and experimentation in confirm
    // that without this middleware the flows break (/service/info URLs
    // strip /reg/ but no route exists at root to serve them).
    app.use(function regSubdomainPathMap (req: Request, res: Response, next: NextFunction) {
      if (!req.headers.host) return next();
      const firstChunk = req.headers.host.split('.')[0].toLowerCase();
      if (firstChunk === 'reg' || firstChunk === 'access' || firstChunk === 'mfa') {
        if (!req.url.startsWith('/reg/') && req.url !== '/reg') {
          req.url = '/reg' + req.url;
        }
      }
      next();
    });

    app.use(middleware.subdomainToPath(ignorePaths, ignoredSubdomains));
  }
  // Parse JSON bodies (same size default as multipart uploads when the
  // setting is absent):
  app.use(express.json({
    limit: effectiveMaxSizeMb(config.get('uploads:maxSizeMb')) + 'mb'
  }));
  // This object will contain key-value pairs, where the value can be a string
  // or array (when extended is false), or any type (when extended is true).
  app.use(express.urlencoded({
    extended: false
  }));
  // Other middleware:
  app.use(requestTraceMiddleware);
  app.use(middleware.override);
  app.use(commonHeadersMiddleware);
  return app;
}
export default expressAppInit;
export { expressAppInit };