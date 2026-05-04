/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const Paths = require('./Paths');
const methodCallback = require('./methodCallback');
const { setMethodId } = require('middleware');
/**
 * Set up events route handling.
 */
module.exports = function (expressApp, app) {
  const api = app.api;
  expressApp.get(Paths.Service + '/info', setMethodId('service.info'), function (req, res, next) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  // Backward-compatible alias (plural)
  expressApp.get(Paths.Service + '/infos', setMethodId('service.info'), function (req, res, next) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
};
