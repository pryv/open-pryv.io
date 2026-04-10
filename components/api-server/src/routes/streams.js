/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const methodCallback = require('./methodCallback');
const Paths = require('./Paths');
const tryCoerceStringValues = require('../schema/validation').tryCoerceStringValues;
const _ = require('lodash');
const middleware = require('middleware');
const { setMethodId } = require('middleware');
// Event streams route handling.
module.exports = function (expressApp, app) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.get(Paths.Streams, loadAccessMiddleware, setMethodId('streams.get'), function (req, res, next) {
    const params = _.extend({}, req.query);
    tryCoerceStringValues(params, {
      includeDeletionsSince: 'number'
    });
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Streams, loadAccessMiddleware, setMethodId('streams.create'), function (req, res, next) {
    api.call(req.context, req.body, methodCallback(res, next, 201));
  });
  expressApp.put(Paths.Streams + '/:id', loadAccessMiddleware, setMethodId('streams.update'), function (req, res, next) {
    api.call(req.context, { id: req.params.id, update: req.body }, methodCallback(res, next, 200));
  });
  expressApp.delete(Paths.Streams + '/:id', loadAccessMiddleware, setMethodId('streams.delete'), function (req, res, next) {
    const params = _.extend({ id: req.params.id }, req.query);
    tryCoerceStringValues(params, {
      mergeEventsWithParent: 'boolean'
    });
    api.call(req.context, params, methodCallback(res, next, 200));
  });
};
