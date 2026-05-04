/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const path = require('path');
const methodCallback = require('../methodCallback');
const regPath = require('../Paths').Register;
const errors = require('errors').factory;
const { setMinimalMethodContext, setMethodId } = require('middleware');
/**
 * Routes for users
 * @param app
 */
module.exports = function (expressApp, app) {
  const api = app.api;
  // POST /users: create a new user
  const registerHandler = function (req, res, next) {
    req.context.host = req.headers.host;
    api.call(req.context, req.body, methodCallback(res, next, 201));
  };
  expressApp.post('/users', setMinimalMethodContext, setMethodId('auth.register'), registerHandler);
  // Alias at /reg/users for reserved-subdomain clients: in multi-core mode,
  // `expressApp.js::regSubdomainPathMap` prepends `/reg` to every path when
  // Host is reg./access./mfa., so `POST reg.{domain}/users` arrives as
  // `POST /reg/users`. Without this alias it would fall through to the
  // `/:username/*` router and 404 as "Unknown user 'reg'".
  expressApp.post(path.join(regPath, '/users'), setMinimalMethodContext, setMethodId('auth.register'), registerHandler);
  expressApp.get(path.join(regPath, '/:email/check_email'), setMinimalMethodContext, setMethodId('auth.emailCheck'), (req, res, next) => {
    api.call(req.context, req.params, methodCallback(res, next, 200));
  });
  expressApp.post(path.join(regPath, '/user'), setMinimalMethodContext, setMethodId('auth.register'), function (req, res, next) {
    req.context.host = req.headers.host;
    if (req.body) { req.body.appId = req.body.appid; }
    api.call(req.context, req.body, methodCallback(res, next, 201));
  });
  expressApp.get(path.join(regPath, '/:username/check_username'), setMinimalMethodContext, setMethodId('auth.usernameCheck'), (req, res, next) => {
    api.call(req.context, req.params, methodCallback(res, next, 200));
  });
  expressApp.post(path.join(regPath, '/username/check'), (req, res, next) => {
    next(errors.goneResource());
  });
  expressApp.post(path.join(regPath, '/email/check'), (req, res, next) => {
    next(errors.goneResource());
  });

  // Core discovery — find which core hosts a given user
  expressApp.get(path.join(regPath, '/cores'), setMinimalMethodContext, setMethodId('auth.cores'), (req, res, next) => {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });

  // Hostings — available cores
  expressApp.get(path.join(regPath, '/hostings'), setMinimalMethodContext, setMethodId('auth.hostings'), (req, res, next) => {
    api.call(req.context, {}, methodCallback(res, next, 200));
  });
};
