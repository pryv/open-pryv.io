/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const methodCallback = require('./methodCallback');
const { setMethodId } = require('middleware');
const { getConfigUnsafe } = require('@pryv/boiler');
module.exports = function (expressApp, app) {
  const api = app.api;
  // dnsLess compatible route
  expressApp.get('/reg/service/info', setMethodId('service.info'), function (req, res, next) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  // Multi-core (dnsLess=false): also serve /service/info at the root so that
  // clients hitting `https://reg.{domain}/service/info` — the natural URL
  // for a distribution-reserved subdomain — get a valid response without
  // the `/reg/` prefix.
  const config = getConfigUnsafe(true);
  if (!config.get('dnsLess:isActive')) {
    expressApp.get('/service/info', setMethodId('service.info'), function (req, res, next) {
      api.call(req.context, req.query, methodCallback(res, next, 200));
    });
  }
};
