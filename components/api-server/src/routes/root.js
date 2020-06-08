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

const _ = require('lodash');

const middleware = require('components/middleware');

const commonMeta = require('../methods/helpers/setCommonMeta');
const methodCallback = require('./methodCallback');
const Paths = require('./Paths');
const getAuth = require('../../../middleware/src/getAuth');
    
import type Application from '../application';

(async () => {
  await commonMeta.loadSettings();
})();

// Handlers for path roots at various places; handler for batch calls and 
// access-info. 
function root(expressApp: express$Application, app: Application) {
  const settings = app.settings;
  const api = app.api;
  
  const customAuthStepFn = settings.getCustomAuthFunction();
  const initContextMiddleware = middleware.initContext(
    app.storageLayer, customAuthStepFn);
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);

  // Bootstrap to user's Pryv page (i.e. browser home).
  expressApp.get('/', rootIndex);
  expressApp.get(Paths.UserRoot + '/', rootIndex);

  // Load user for all user API methods.
  expressApp.all(Paths.UserRoot + '/*', getAuth);
  expressApp.all(Paths.UserRoot + '/*', initContextMiddleware);

  // Current access information.
  expressApp.get(Paths.UserRoot + '/access-info',
    loadAccessMiddleware,
    function (req: express$Request, res, next) {
      // FLOW More request.context...
      api.call('getAccessInfo', req.context, req.query, 
        methodCallback(res, next, 200));
    });

  // Batch request of multiple API method calls.
  expressApp.post(Paths.UserRoot,
    initContextMiddleware,
    loadAccessMiddleware,
    function (req: express$Request, res, next) {
      // FLOW More request.context...
      api.call('callBatch', req.context, req.body, 
        methodCallback(res, next, 200));
    }
  );
}
module.exports = root; 

// Renders a greeting message; this route is displayed on the various forms
// of roots ('/', 'foo.pryv.me/')
// 
function rootIndex(req: express$Request, res) {
  const devSiteURL = 'https://api.pryv.com/';
  const result = commonMeta.setCommonMeta({});
  
  if (req.accepts('application/json')) {
    res.json(_.extend(result, {
      cheersFrom: 'Pryv API',
      learnMoreAt: devSiteURL
    }));
  } else {
    res.send('# Cheers from the Pryv API!\n\n' +
        '- API version: ' + result.meta.apiVersion + '\n' +
        '- Server time: ' + result.meta.serverTime + '\n\n' +
        'Learn more at ' + devSiteURL);
  }
}