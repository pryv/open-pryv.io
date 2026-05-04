/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const express = require('express');
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
  const ignorePaths = Object.values(Paths)
    .filter((e) => typeof e === 'string')
    .filter((e) => e.indexOf(Paths.Params.Username) < 0);
  if (!config.get('dnsLess:isActive')) {
    const coreId = config.get('core:id');
    const ignoredSubdomains = coreId && coreId !== 'single' ? [coreId] : [];
    // Also keep distribution-reserved service subdomains out of the
    // username-rewriter. Without this, e.g. `access.pryv.me/service/info`
    // (6 chars, matches username regex) gets rewritten to
    // `/access/service/info` and falls through to the username router.
    // reg/access/mfa are the distribution's reserved names
    // (see DnsServer.RESERVED_SERVICE_NAMES); operator-owned staticEntries
    // names (sw, mail, etc.) are harvested from config too.
    ignoredSubdomains.push('reg', 'access', 'mfa');
    const staticEntries = config.get('dns:staticEntries') || {};
    for (const name of Object.keys(staticEntries)) {
      if (!ignoredSubdomains.includes(name)) ignoredSubdomains.push(name);
    }

    // When Host matches a reserved service subdomain (reg/access/mfa), the
    // client-facing URL is rootless — e.g. `reg.pryv.me/perki/server` or
    // `access.pryv.me/access/`. Internally all the handlers live under
    // `/reg/*`, so prepend `/reg` before route matching. Idempotent for
    // clients that still send the `/reg/` prefix. Required for v1-style
    // URL shapes; tests and experimentation in confirm
    // that without this middleware the flows break (/service/info URLs
    // strip /reg/ but no route exists at root to serve them).
    app.use(function regSubdomainPathMap (req, res, next) {
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
  // Parse JSON bodies:
  app.use(express.json({
    limit: config.get('uploads:maxSizeMb') + 'mb'
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
module.exports = expressAppInit;
