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
// Profile route handling.
module.exports = function (expressApp, app) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.get(Paths.Profile + '/public', setMethodId('profile.getPublic'), loadAccessMiddleware, function (req, res, next) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  expressApp.put(Paths.Profile + '/public', setMethodId('profile.update'), loadAccessMiddleware, function (req, res, next) {
    api.call(req.context, { id: 'public', update: req.body }, methodCallback(res, next, 200));
  });
  expressApp.get(Paths.Profile + '/app', setMethodId('profile.getApp'), loadAccessMiddleware, function (req, res, next) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  expressApp.put(Paths.Profile + '/app', setMethodId('profile.updateApp'), loadAccessMiddleware, function (req, res, next) {
    const params = { update: req.body };
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.get(Paths.Profile + '/private', setMethodId('profile.get'), loadAccessMiddleware, function (req, res, next) {
    api.call(req.context, _.extend(req.query, { id: 'private' }), methodCallback(res, next, 200));
  });
  expressApp.put(Paths.Profile + '/private', setMethodId('profile.update'), loadAccessMiddleware, function (req, res, next) {
    api.call(req.context, { id: 'private', update: req.body }, methodCallback(res, next, 200));
  });
};
