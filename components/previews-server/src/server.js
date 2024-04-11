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
const path = require('path');
const { getConfig, getLogger } = require('@pryv/boiler').init({
  appName: 'previews-server',
  baseFilesDir: path.resolve(__dirname, '../../../'),
  baseConfigDir: path.resolve(__dirname, '../../api-server/config'),
  extraConfigs: [
    {
      scope: 'defaults-previews',
      file: path.resolve(__dirname, '../config/defaults-config.yml')
    },
    {
      scope: 'serviceInfo',
      key: 'service',
      urlFromKey: 'serviceInfoUrl'
    },
    {
      scope: 'defaults-paths',
      file: path.resolve(__dirname, '../../api-server/config/paths-config.js')
    },
    {
      plugin: require('api-server/config/components/systemStreams')
    }
  ]
});
// @flow
const http = require('http');
const middleware = require('middleware');
const storage = require('storage');
const utils = require('utils');
const { axonMessaging } = require('messages');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const ExtensionLoader = utils.extension.ExtensionLoader;
/**
 * @returns {any}
 */
function loadCustomAuthStepFn (customExtensions) {
  const defaultFolder = customExtensions.defaultFolder;
  const customAuthStepFnPath = customExtensions.customAuthStepFn;
  const loader = new ExtensionLoader(defaultFolder);
  if (customAuthStepFnPath != null && customAuthStepFnPath !== '') { return loader.loadFrom(customAuthStepFnPath); }
  return loader.load('customAuthStepFn');
}
/**
 * @returns {Promise<void>}
 */
async function start () {
  /**
   * Runs the server.
   * Launch with `node server [options]`.
   */
  // load config settings
  const config = await getConfig();
  await SystemStreamsSerializer.init();
  const customAuthStepExt = loadCustomAuthStepFn(config.get('customExtensions'));
  const logger = getLogger('server');
  const database = await storage.getDatabase();
  const storageLayer = await storage.getStorageLayer();
  const initContextMiddleware = middleware.initContext(storageLayer, customAuthStepExt && customAuthStepExt.fn);
  const loadAccessMiddleware = middleware.loadAccess(storageLayer);
  const { expressApp, routesDefined } = require('./expressApp')(await middleware.commonHeaders(), require('./middleware/errors')(logger), middleware.requestTrace(null, logger));
  // setup routes
  require('./routes/index')(expressApp);
  await require('./routes/event-previews')(expressApp, initContextMiddleware, loadAccessMiddleware, logger);
  // Finalize middleware stack:
  routesDefined();
  // setup HTTP
  const server = http.createServer(expressApp);
  module.exports = server;
  // Go
  const testNotifier = await axonMessaging.getTestNotifier();
  await database.waitForConnection();
  const backlog = 512;
  server.listen(config.get('http:port'), config.get('http:ip'), backlog, function () {
    const address = server.address();
    const protocol = server.key ? 'https' : 'http';
    server.url = protocol + '://' + address.address + ':' + address.port;
    const infostr = 'Preview server v' +
            require('../package.json').version +
            ' [' +
            expressApp.settings.env +
            '] listening on ' +
            server.url;
    logger.info(infostr);
    // all right
    logger.debug(infostr);
    logger.info('Server ready');
    testNotifier.emit('axon-server-ready');
  });
  process.on('exit', function () {
    logger.info('Browser server exiting.');
  });
}
const loggerLaunch = getLogger('launch');
// And now:
start().catch((err) => {
  loggerLaunch.error(err, err); // eslint-disable-line no-console
});

/**
 * @typedef {Server & {
 *   key?: string;
 *   url?: string;
 * }} ExtendedAttributesServer
 */
