// @flow
const http = require('http');

const dependencies = require('dependable').container({useFnAnnotations: true});
const middleware = require('components/middleware');
const storage = require('components/storage');
const utils = require('components/utils');

const ExtensionLoader = utils.extension.ExtensionLoader;

const { ProjectVersion } = require('components/middleware/src/project_version');

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

  // load config settings
  var config = require('./config');
  config.printSchemaAndExitIfNeeded();
  var settings = config.load();

  const customAuthStepExt = loadCustomAuthStepFn(settings.customExtensions); 

  // register base dependencies
  dependencies.register({
    // settings
    authSettings: settings.auth,
    eventFilesSettings: settings.eventFiles,
    logsSettings: settings.logs,

    // misc utility
    logging: utils.logging
  });

  const logging = dependencies.get('logging');
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
  const version = await pv.version(); 

  dependencies.register({
    // storage
    sessionsStorage: storageLayer.sessions,
    usersStorage: storageLayer.users,
    userAccessesStorage: storageLayer.accesses,
    userEventFilesStorage: storageLayer.eventFiles,
    userEventsStorage: storageLayer.events,
    userStreamsStorage: storageLayer.streams,
    
    // For the code that hasn't quite migrated away from dependencies yet.
    storageLayer: storageLayer,

    // Express middleware
    commonHeadersMiddleware: middleware.commonHeaders(version),
    errorsMiddleware: require('./middleware/errors'),
    initContextMiddleware: initContextMiddleware,
    loadAccessMiddleware: loadAccessMiddleware,
    requestTraceMiddleware: middleware.requestTrace,

    // Express & app
    express: require('express'),
  });

  const {expressApp, routesDefined} = dependencies.resolve(
    require('./expressApp'));
  dependencies.register('expressApp', expressApp);

  // setup routes

  [
    require('./routes/index'),
    require('./routes/event-previews'),
  ].forEach(function (routeDefs) {
    dependencies.resolve(routeDefs);
  });

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
  
