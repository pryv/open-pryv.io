/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const methodCallback = require('./methodCallback');
const { setMethodId } = require('middleware');
module.exports = function (expressApp, app) {
  const api = app.api;
  // dnsLess compatible route
  expressApp.get('/reg/service/info', setMethodId('service.info'), function (req, res, next) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
};
