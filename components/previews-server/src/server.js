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
const http = require('http');

const middleware = require('components/middleware');
const storage = require('components/storage');
const utils = require('components/utils');

const ExtensionLoader = utils.extension.ExtensionLoader;

const { ProjectVersion } = require('components/middleware/src/project_version');
const { getConfig } = require('components/api-server/config/Config');

import type { Extension } from 'components/utils';

function loadCustomAuthStepFn(customExtensions): ?Extension {
  const defaultFolder = customExtensions.defaultFolder;
  const customAuthStepFnPath = customExtensions.customAuthStepFn;

  const loader = new ExtensionLoader(defaultFolder);

  if (customAuthStepFnPath != null && customAuthStepFnPath !== '')
    return loader.loadFrom(customAuthStepFnPath);

  return loader.load('customAuthStepFn');
}

async function start() {
  /**
   * Runs the server.
   * Launch with `node server [options]`.
   */
  const newConfig = getConfig();
  await newConfig.init();

  // load config settings
  var config = require('./config');
  config.printSchemaAndExitIfNeeded();
  var settings = config.load();

  const customAuthStepExt = loadCustomAuthStepFn(settings.customExtensions);

  const logging = utils.logging(settings.logs); 

  const logger = logging.getLogger('server');

  const database = new storage.Database(
    settings.database, logging.getLogger('database'));

  const storageLayer = new storage.StorageLayer(
    database, logger,
    settings.eventFiles.attachmentsDirPath,
    settings.eventFiles.previewsDirPath,
    10, settings.auth.sessionMaxAge);

  const initContextMiddleware = middleware.initContext(
    storageLayer,
    customAuthStepExt && customAuthStepExt.fn);

  const loadAccessMiddleware = middleware.loadAccess(
    storageLayer);

  const pv = new ProjectVersion();
  const version = pv.version();

  const { expressApp, routesDefined } = require('./expressApp')(
    middleware.commonHeaders(version), 
    require('./middleware/errors')(logging), 
    middleware.requestTrace(null, logging));

  // setup routes
  require('./routes/index')(expressApp);
  require('./routes/event-previews')(expressApp, initContextMiddleware, loadAccessMiddleware, storageLayer.events, storageLayer.eventFiles, logging);

  // Finalize middleware stack: 
  routesDefined();

  // setup HTTP

  const server: ExtendedAttributesServer = http.createServer(expressApp);
  module.exports = server;

  // Go

  utils.messaging.openPubSocket(settings.tcpMessaging, function (err, pubSocket) {
    if (err) {
      logger.error('Error setting up TCP pub socket: ' + err);
      process.exit(1);
    }
    logger.info('TCP pub socket ready on ' + settings.tcpMessaging.host + ':' +
      settings.tcpMessaging.port);

    database.waitForConnection(function () {
      const backlog = 512;
      server.listen(settings.http.port, settings.http.ip, backlog, function () {
        var address = server.address();
        var protocol = server.key ? 'https' : 'http';
        server.url = protocol + '://' + address.address + ':' + address.port;
        logger.info('Browser server v' + require('../package.json').version +
          ' [' + expressApp.settings.env + '] listening on ' + server.url);

        // all right

        logger.info('Server ready');
        pubSocket.emit('server-ready');
      });
    });
  });

  process.on('exit', function () {
    logger.info('Browser server exiting.');
  });
}

type ExtendedAttributesServer = net$Server & {
  key?: string,
  url?: string,
}

// And now:
start()
  .catch(err => {
    console.error(err); // eslint-disable-line no-console
  });

