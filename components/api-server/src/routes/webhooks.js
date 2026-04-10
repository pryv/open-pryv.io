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
/**
 * Webhooks route handling.
 *
 * @param {App} expressApp
 * @param {Object} api The API object for registering methods
 */
module.exports = function (expressApp, app) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.get(Paths.Webhooks, loadAccessMiddleware, setMethodId('webhooks.get'), function (req, res, next) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  expressApp.get(Paths.Webhooks + '/:id', loadAccessMiddleware, setMethodId('webhooks.getOne'), function (req, res, next) {
    const params = _.extend({ id: req.params.id }, req.query);
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Webhooks, loadAccessMiddleware, setMethodId('webhooks.create'), function (req, res, next) {
    api.call(req.context, req.body, methodCallback(res, next, 201));
  });
  expressApp.put(Paths.Webhooks + '/:id', loadAccessMiddleware, setMethodId('webhooks.update'), function (req, res, next) {
    const params = { id: req.params.id, update: req.body };
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.delete(Paths.Webhooks + '/:id', loadAccessMiddleware, setMethodId('webhooks.delete'), function (req, res, next) {
    const params = _.extend({ id: req.params.id }, req.query);
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Webhooks + '/:id/test', loadAccessMiddleware, setMethodId('webhooks.test'), function (req, res, next) {
    const params = _.extend({ id: req.params.id }, req.query);
    api.call(req.context, params, methodCallback(res, next, 200));
  });
};
