/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
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
 */
// @flow

const methodCallback = require('./methodCallback');
const Paths = require('./Paths');
const tryCoerceStringValues = require('../schema/validation').tryCoerceStringValues;
const _ = require('lodash');
const middleware = require('middleware');

import type Application  from '../application';

// Event streams route handling.
module.exports = function (expressApp: express$Application, app: Application) {

  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);

  // Require access for all Streams API methods.
  expressApp.all(Paths.Streams + '*', loadAccessMiddleware);

  expressApp.get(Paths.Streams, function (req: express$Request, res, next) {
    var params = _.extend({}, req.query);
    tryCoerceStringValues(params, {
      includeDeletionsSince: 'number'
    });
    api.call('streams.get', req.context, params, methodCallback(res, next, 200));
  });

  expressApp.post(Paths.Streams, function (req: express$Request, res, next) {
    api.call('streams.create', req.context, req.body, methodCallback(res, next, 201));
  });

  expressApp.put(Paths.Streams + '/:id', function (req: express$Request, res, next) {
    api.call('streams.update', req.context, { id: req.params.id, update: req.body },
      methodCallback(res, next, 200));
  });

  expressApp.delete(Paths.Streams + '/:id', function (req: express$Request, res, next) {
    var params = _.extend({id: req.params.id}, req.query);
    tryCoerceStringValues(params, {
      mergeEventsWithParent: 'boolean'
    });
    api.call('streams.delete', req.context, params,
      methodCallback(res, next, 200));
  });

};
