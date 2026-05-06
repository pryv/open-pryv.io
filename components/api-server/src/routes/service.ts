/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Paths = require('./Paths');
const methodCallback = require('./methodCallback').default;
const { setMethodId } = require('middleware');
/**
 * Set up events route handling.
 */
export default function (expressApp, app) {
  const api = app.api;
  expressApp.get(Paths.Service + '/info', setMethodId('service.info'), function (req, res, next) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  // Backward-compatible alias (plural)
  expressApp.get(Paths.Service + '/infos', setMethodId('service.info'), function (req, res, next) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
};
