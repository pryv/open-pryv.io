/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const methodCallback = require('./methodCallback.ts').default;
const { setMethodId } = require('middleware');
const { getConfigUnsafe } = require('@pryv/boiler');
export default function (expressApp, app) {
  const api = app.api;
  // dnsLess compatible route
  expressApp.get('/reg/service/info', setMethodId('service.info'), function (req, res, next) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  // Multi-core (dnsLess=false): also serve /service/info at the root so that
  // clients hitting `https://reg.{domain}/service/info` — the natural URL
  // for a distribution-reserved subdomain — get a valid response without
  // the `/reg/` prefix.
  // Inside the default-export function — called from app bootstrap
  // post-`await getConfig()` — so the no-warnOnly variant is safe.
  const config = getConfigUnsafe();
  if (!config.get('dnsLess:isActive')) {
    expressApp.get('/service/info', setMethodId('service.info'), function (req, res, next) {
      api.call(req.context, req.query, methodCallback(res, next, 200));
    });
  }
};
