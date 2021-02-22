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

const express = require('express');
const _ = require('lodash');
const bodyParser = require('body-parser');

const middleware = require('middleware');

const Paths = require('./routes/Paths');

const { ProjectVersion } = require('middleware/src/project_version');

// ------------------------------------------------------------ express app init

// Creates and returns an express application with a standard set of middleware. 
// `version` should be the version string you want to show to API clients. 
// 
async function expressAppInit(isDnsLess: boolean, logging) {
  const pv = new ProjectVersion();
  const version = pv.version();
  var app = express(); // register common middleware
  const commonHeadersMiddleware = middleware.commonHeaders(version);
  const requestTraceMiddleware = middleware.requestTrace(app, logging);

  // register common middleware

  app.disable('x-powered-by');

  // Install middleware to hoist the username into the request path. 
  // 
  // NOTE Insert this bit in front of 'requestTraceMiddleware' to also see 
  //  username in logged paths. 
  // 
  const ignorePaths = _.chain(Paths)
    .filter(e => _.isString(e))
    .filter(e => e.indexOf(Paths.Params.Username) < 0)
    .value(); 

  if (!isDnsLess)
    app.use(middleware.subdomainToPath(ignorePaths));

  // Parse JSON bodies: 
  app.use(bodyParser.json({
    limit: '10mb'}));

  // This object will contain key-value pairs, where the value can be a string
  // or array (when extended is false), or any type (when extended is true).
  app.use(bodyParser.urlencoded({
    extended: false}));

  // Other middleware:
  app.use(requestTraceMiddleware);
  app.use(middleware.override);
  app.use(commonHeadersMiddleware);

  return app;
}

module.exports = expressAppInit;