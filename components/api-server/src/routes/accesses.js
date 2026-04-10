/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const methodCallback = require('./methodCallback');
const Paths = require('./Paths');
const _ = require('lodash');
const middleware = require('middleware');
const { setMethodId } = require('middleware');
const tryCoerceStringValues = require('../schema/validation').tryCoerceStringValues;
// Shared accesses route handling.
module.exports = function (expressApp, app) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.get(Paths.Accesses, setMethodId('accesses.get'), loadAccessMiddleware, function (req, res, next) {
    const params = _.extend({}, req.query);
    tryCoerceStringValues(params, {
      includeExpired: 'boolean',
      includeDeletions: 'boolean'
    });
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Accesses, setMethodId('accesses.create'), loadAccessMiddleware, function (req, res, next) {
    api.call(req.context, req.body, methodCallback(res, next, 201));
  });
  expressApp.put(Paths.Accesses + '/:id', setMethodId('accesses.update'), loadAccessMiddleware, function (req, res, next) {
    const params = { id: req.params.id, update: req.body };
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.delete(Paths.Accesses + '/:id', setMethodId('accesses.delete'), loadAccessMiddleware, function (req, res, next) {
    const params = _.extend({ id: req.params.id }, req.query);
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Accesses + '/check-app', setMethodId('accesses.checkApp'), loadAccessMiddleware, function (req, res, next) {
    api.call(req.context, req.body, methodCallback(res, next, 200));
  });
};
