/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
 * 
 */
// @flow

const methodCallback = require('./methodCallback');
const Paths = require('./Paths');
const _ = require('lodash');
const middleware = require('components/middleware');

import type Application from '../application';

// Profile route handling.
module.exports = function (expressApp: express$Application, app: Application) {

  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);

  // Require access for all Profile API methods.
  expressApp.all(Paths.Profile + '*', loadAccessMiddleware);

  expressApp.get(Paths.Profile + '/public', function (req: express$Request, res, next) {
    api.call('profile.getPublic', req.context, req.query, methodCallback(res, next, 200));
  });

  expressApp.put(Paths.Profile + '/public', update('public'));

  expressApp.get(Paths.Profile + '/app', function (req: express$Request, res, next) {
    api.call('profile.getApp', req.context, req.query, methodCallback(res, next, 200));
  });

  expressApp.put(Paths.Profile + '/app', function (req: express$Request, res, next) {
    var params = {update: req.body};
    api.call('profile.updateApp', req.context, params, methodCallback(res, next, 200));
  });

  expressApp.get(Paths.Profile + '/private', get('private'));
  expressApp.put(Paths.Profile + '/private', update('private'));

  function get(id) {
    return function (req: express$Request, res, next) {
      api.call('profile.get', req.context, _.extend(req.query, {id: id}),
        methodCallback(res, next, 200));
    };
  }

  function update(id) {
    return function (req: express$Request, res, next) {
      api.call('profile.update', req.context, { id: id, update: req.body },
        methodCallback(res, next, 200));
    };
  }

};
