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

const errors = require('errors').factory;
const Paths = require('./Paths');
const methodCallback = require('./methodCallback');
const contentType = require('middleware').contentType;
const _ = require('lodash');
const { getLogger } = require('@pryv/boiler');
const { setMinimalMethodContext, setMethodId } = require('middleware');

import type { ContextSource } from 'business';

import type Application  from '../application';

// System (e.g. registration server) calls route handling.
module.exports = function system(expressApp: express$Application, app: Application) {

  const systemAPI = app.systemAPI;
  const config = app.config;
  
  const adminAccessKey = config.get('auth:adminAccessKey');

  const logger = getLogger('routes:system');

  /**
   * Handle common parameters.
   */
  expressApp.all(Paths.System + '/*', setMinimalMethodContext, checkAuth);


  expressApp.post(Paths.System + '/create-user', contentType.json,
    setMethodId('system.createUser'),
    createUser);

  // DEPRECATED: remove after all reg servers updated
  expressApp.post('/register/create-user', contentType.json, 
    setMinimalMethodContext,
    setMethodId('system.createUser'),
    createUser);

  function createUser(req: express$Request, res, next) {
    const params = _.extend({}, req.body); 
    systemAPI.call(req.context, params, methodCallback(res, next, 201));
  }

  expressApp.get(Paths.System + '/user-info/:username',
    setMethodId('system.getUserInfo'),
    function (req: express$Request, res, next) {
      const params = {
        username: req.params.username
      };
      systemAPI.call(req.context, params, methodCallback(res, next, 200));
  });

  expressApp.delete(Paths.System + '/users/:username/mfa', 
    setMethodId('system.deactivateMfa'),
    function (req: express$Request, res, next) {
      systemAPI.call(req.context, { username: req.params.username }, methodCallback(res, next, 204));
  });

  // Checks if `req` contains valid authorization to access the system routes. 
  // 
  function checkAuth(req: express$Request, res, next) {
    const secret = req.headers.authorization;
    if (secret==null || secret !== adminAccessKey) {
      logger.warn('Unauthorized attempt to access system route', {
        url: req.url,
        ip: req.ip,
        headers: req.headers,
        body: req.body });
      
      // return "not found" to avoid encouraging retries
      return next(errors.unknownResource());
    }
    
    next();
  }
};

