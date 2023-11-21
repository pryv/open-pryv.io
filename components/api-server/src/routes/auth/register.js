/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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
const path = require('path');
const methodCallback = require('../methodCallback');
const { getConfigUnsafe } = require('@pryv/boiler');
const regPath = require('../Paths').Register;
const errors = require('errors').factory;
const { setMinimalMethodContext, setMethodId } = require('middleware');
/**
 * Routes for users
 * @param app
 */
module.exports = function (expressApp, app) {
  const api = app.api;
  const isDnsLess = getConfigUnsafe().get('dnsLess:isActive');
  const isOpenSource = getConfigUnsafe().get('openSource:isActive');
  // POST /users: create a new user
  expressApp.post('/users', setMinimalMethodContext, setMethodId('auth.register'), function (req, res, next) {
    req.context.host = req.headers.host;
    api.call(req.context, req.body, methodCallback(res, next, 201));
  });
  if (isDnsLess) {
    if (!isOpenSource) {
      expressApp.get(path.join(regPath, '/:email/check_email'), setMinimalMethodContext, setMethodId('auth.emailCheck'), (req, res, next) => {
        api.call(req.context, req.params, methodCallback(res, next, 200));
      });
    }
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
  }
};
