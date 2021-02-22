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

const path = require('path');
const methodCallback = require('../methodCallback');
const API = require('../../API');
import type Application  from '../../application';
const _ = require('lodash');
const { getConfigUnsafe } = require('@pryv/boiler');
const regPath = require('../Paths').Register;
const errors = require('errors').factory;

/**
 * Routes for users
 * @param app
 */
module.exports = function (expressApp: express$Application, app: Application) {

  const api: API = app.api;
  const isDnsLess = getConfigUnsafe().get('dnsLess:isActive');
  const isOpenSource = getConfigUnsafe().get('openSource:isActive');

  // POST /users: create a new user
  expressApp.post('/users', function (req: express$Request, res: express$Response, next: express$NextFunction) {
    const context = { host: req.headers.host };
    if (isDnsLess) {
      api.call('auth.register.dnsless', context, req.body, methodCallback(res, next, 201));
    } else {
      api.call('auth.register', context, req.body, methodCallback(res, next, 201));
    }
  });
  
  if (isDnsLess) {    
    expressApp.post(path.join(regPath, '/user'), function (req: express$Request, res: express$Response, next: express$NextFunction) {
      const context = { host: req.headers.host };
      if (req.body) req.body.appId = req.body.appid;
      api.call('auth.register.dnsless', context, req.body, methodCallback(res, next, 201));
    });
    expressApp.get(path.join(regPath, '/:username/check_username'), (req: express$Request, res, next) => {
      api.call('auth.usernameCheck.dnsless', {}, req.params, methodCallback(res, next, 200));
    });
    expressApp.get(path.join(regPath, '/:email/check_email'), (req: express$Request, res, next) => {
      api.call('auth.emailCheck.dnsless', {}, req.params, methodCallback(res, next, 200));
    });
    expressApp.post(path.join(regPath, '/username/check'), (req: express$Request, res, next) => {
      next(errors.goneResource());
    });
    expressApp.post(path.join(regPath, '/email/check'), (req: express$Request, res, next) => {
      next(errors.goneResource());
    });
  }

};