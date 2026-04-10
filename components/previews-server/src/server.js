/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const path = require('path');
const { getConfig, getLogger } = require('@pryv/boiler').init({
  appName: 'previews-server',
  baseFilesDir: path.resolve(__dirname, '../../../'),
  baseConfigDir: path.resolve(__dirname, '../../../config/'),
  extraConfigs: [
    {
      scope: 'serviceInfo',
      key: 'service',
      urlFromKey: 'serviceInfoUrl'
    },
    {
      scope: 'defaults-paths',
      file: path.resolve(__dirname, '../../../config/plugins/paths-config.js')
    },
    {
      plugin: require('../../../config/plugins/systemStreams')
    }
  ]
});
// @flow
const http = require('http');
const middleware = require('middleware');
const storage = require('storage');
const utils = require('utils');
const { testMessaging } = require('messages');
const accountStreams = require('business/src/system-streams');
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
  await accountStreams.init();
  const customAuthStepExt = loadCustomAuthStepFn(config.get('customExtensions'));
  const logger = getLogger('server');
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
  const testNotifier = await testMessaging.getTestNotifier();
  await storageLayer.waitForConnection();
  const backlog = 512;
  server.listen(config.get('http:previewsPort'), config.get('http:ip'), backlog, function () {
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
    testNotifier.emit('test-server-ready');
  });
  process.on('exit', function () {
    logger.info('Browser server exiting.');
  });
}
const loggerLaunch = getLogger('launch');
// And now:
start().catch((err) => {
  loggerLaunch.error(err, err);
});

/**
 * @typedef {Server & {
 *   key?: string;
 *   url?: string;
 * }} ExtendedAttributesServer
 */
