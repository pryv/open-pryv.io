/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
const cookieParser = require('cookie-parser');
const lodash = require('lodash');
const errors = require('errors').factory;
const middleware = require('middleware');
const { setMethodId } = require('middleware');
const methodCallback = require('../methodCallback');
const Paths = require('../Paths');
const { getConfigUnsafe } = require('@pryv/boiler');
/**
 * Auth routes.
 *
 * @param {Object} api The API object for registering methods
 */
module.exports = function (expressApp, app) {
  const config = getConfigUnsafe();
  const api = app.api;
  const ms14days = 1000 * 60 * 60 * 24 * 14;
  const sessionMaxAge = config.get('auth:sessionMaxAge') || ms14days;
  const ssoCookieDomain = config.get('auth:ssoCookieDomain') || config.get('http:ip');
  const ssoCookieSignSecret = config.get('auth:ssoCookieSignSecret') || 'Hallowed Be Thy Name, O Node';
  const ssoCookieSecure = process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test';
  const ssoHttpOnly = true;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  // Returns true if the given `obj` has all of the property values identified
  // by the names contained in `keys`.
  //
  function hasProperties (obj, keys) {
    if (obj == null) {
      return false;
    }
    if (typeof obj !== 'object') {
      return false;
    }
    for (const key of keys) {
      if (!lodash.has(obj, key)) { return false; }
    }
    return true;
  }
  function setSSOCookie (data, res) {
    res.cookie('sso', data, {
      domain: ssoCookieDomain,
      maxAge: sessionMaxAge,
      secure: ssoCookieSecure,
      signed: true,
      httpOnly: ssoHttpOnly
    });
  }
  function clearSSOCookie (res) {
    res.clearCookie('sso', {
      domain: ssoCookieDomain,
      secure: ssoCookieSecure,
      httpOnly: ssoHttpOnly
    });
  }
  // Define local routes
  expressApp.all(Paths.Auth + '*', cookieParser(ssoCookieSignSecret));
  expressApp.get(Paths.Auth + '/who-am-i', function routeWhoAmI (req, res, next) {
    return next(errors.goneResource());
  });
  expressApp.post(Paths.Auth + '/login', setMethodId('auth.login'), function routeLogin (req, res, next) {
    if (typeof req.body !== 'object' ||
            req.body == null ||
            !hasProperties(req.body, ['username', 'password', 'appId'])) {
      return next(errors.invalidOperation('Missing parameters: username, password and appId are required.'));
    }
    const body = req.body;
    const params = {
      username: body.username,
      password: body.password,
      appId: body.appId,
      // some browsers provide origin, some provide only referer
      origin: req.headers.origin || req.headers.referer || ''
    };
    api.call(req.context, params, function (err, result) {
      if (err) { return next(err); }
      setSSOCookie({ username: req.context.user.username, token: result.token }, res);
      methodCallback(res, next, 200)(err, result);
    });
  });
  expressApp.post(Paths.Auth + '/logout', setMethodId('auth.logout'), loadAccessMiddleware, function routeLogout (req, res, next) {
    clearSSOCookie(res);
    api.call(req.context, {}, methodCallback(res, next, 200));
  });
  return {
    hasProperties
  };
};
