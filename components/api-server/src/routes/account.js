/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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
const methodCallback = require('./methodCallback');
const Paths = require('./Paths');
const middleware = require('middleware');
const { setMethodId } = require('middleware');
// User account details route handling.
module.exports = function (expressApp, app) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);
  expressApp.get(Paths.Account, setMethodId('account.get'), loadAccessMiddleware, function (req, res, next) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  expressApp.put(Paths.Account, setMethodId('account.update'), loadAccessMiddleware, function (req, res, next) {
    api.call(req.context, { update: req.body }, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Account + '/change-password', setMethodId('account.changePassword'), loadAccessMiddleware, function (req, res, next) {
    api.call(req.context, req.body, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Account + '/request-password-reset', setMethodId('account.requestPasswordReset'), function (req, res, next) {
    const params = req.body;
    params.origin = req.headers.origin;
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Account + '/reset-password', setMethodId('account.resetPassword'), function (req, res, next) {
    const params = req.body;
    params.origin = req.headers.origin;
    api.call(req.context, params, methodCallback(res, next, 200));
  });
};
