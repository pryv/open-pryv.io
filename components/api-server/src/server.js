// @flow

const express = require('express');

const http = require('http');
const bluebird = require('bluebird');
const EventEmitter = require('events');

const utils = require('components/utils');

const Notifications = require('./Notifications');
const Application = require('./application');

const expressAppInit = require('./expressApp');

const child_process = require('child_process');
const url = require('url');

import type { Logger } from 'components/utils';
import type { ConfigAccess } from './settings';
import type { ExpressAppLifecycle } from './expressApp';


// Server class for api-server process. To use this, you 
// would 
// 
//    const server = new Server(); 
//    server.start(); 
// 
class Server {
  application: Application;
  settings: ConfigAccess;
  isOpenSource: boolean;
  isDNSLess: Boolean;
  logger: Logger; 
  
  // Axon based internal notification and messaging bus. 
  notificationBus: Notifications;
    
  // Load settings and setup base configuration. 
  //
  constructor(application: Application) {
    this.application = application;
    
    const settings = application.settings; 
    this.settings = settings;
    this.isOpenSource = settings.get('openSource.isActive').bool();
    this.isDNSLess = settings.get('dnsLess.isActive').bool();
    this.logger = application.logFactory('api-server');
  }
    
  // Start the server. 
  //
  async start() {
    const logger = this.logger;
    
    this.publishExpressMiddleware();
    
    const [expressApp, lifecycle] = await this.createExpressApp(this.isDNSLess); 

    // start TCP pub messaging
    await this.setupNotificationBus();

    // register API methods
    this.registerApiMethods();

    // Setup HTTP and register server; setup Socket.IO.
    const server: net$Server = http.createServer(expressApp);
    this.setupSocketIO(server); 
    await this.startListen(server);

    // Finish booting the server, start accepting connections.
    this.addRoutes(expressApp);
    
    // Let actual requests pass.
    lifecycle.appStartupComplete(); 
    
    if (! this.isOpenSource) {
      await this.setupReporting();
    }

    logger.info('Server ready.');
    this.notificationBus.serverReady();
  }
  
  async createExpressApp(isDNSLess: boolean): Promise<[express$Application, ExpressAppLifecycle]> {
    const app = this.application;
    const dependencies = app.dependencies;

    const {expressApp, lifecycle} = await expressAppInit(dependencies, isDNSLess);
    dependencies.register({expressApp: expressApp});
    
    // Make sure that when we receive requests at this point, they get notified 
    // of startup API unavailability. 
    lifecycle.appStartupBegin(); 
    
    return [expressApp, lifecycle];
  }
  
  // Requires and registers all API methods. 
  // 
  registerApiMethods() {
    const application = this.application;
    const dependencies = this.application.dependencies;
    const l = (topic) => application.getLogger(topic);
    
    // Open Heart Surgery ahead: Trying to get rid of DI here, file by file. 
    // This means that what we want is in the middle there; all the 
    // dependencies.resolves must go. 

    [
      require('./methods/system'),
      require('./methods/utility'),
      require('./methods/auth'),
    ].forEach(function (moduleDef) {
      dependencies.resolve(moduleDef);
    });

    require('./methods/accesses')(
      application.api, l('methods/accesses'), 
      this.notificationBus, 
      application.getUpdatesSettings(), 
      application.storageLayer);

    require('./methods/service')(
      application.api, l('methods/service'), 
      application.getServiceInfoSettings());

    if (! this.isOpenSource)
    require('./methods/webhooks')(
      application.api, l('methods/webhooks'),
      application.getWebhooksSettings(),
      application.storageLayer,
    );

    require('./methods/trackingFunctions')(
      application.api,
      l('methods/trackingFunctions'),
      application.storageLayer,
    );

    [
      require('./methods/account'),
      require('./methods/followedSlices'),
      require('./methods/profile'),
      require('./methods/streams'),
      require('./methods/events'),
    ].forEach(function (moduleDef) {
      dependencies.resolve(moduleDef);
    });
  }
  
  // Publishes dependencies for express middleware setup. 
  // 
  publishExpressMiddleware() {
    const dependencies = this.application.dependencies;

    dependencies.register({
      // TODO Do we still need this? Where? Try to eliminate it. 
      express: express, 
    });
  }
  
  setupSocketIO(server: net$Server) {
    const application = this.application; 
    const notificationBus = this.notificationBus;
    const api = application.api; 
    const storageLayer = application.storageLayer;
    const settings = this.settings; 
    const customAuthStepFn = settings.getCustomAuthFunction();
    const isOpenSource = this.isOpenSource;
        
    const socketIOsetup = require('./socket-io');
    socketIOsetup(
      server, application.logFactory('socketIO'), 
      notificationBus, api, 
      storageLayer, customAuthStepFn,
      isOpenSource);
  }
  
  // Open http port and listen to incoming connections. 
  //
  async startListen(server: net$Server) {
    const settings = this.settings; 
    const logger = this.logger; 
    
    const port = settings.get('http.port').num();
    const hostname = settings.get('http.ip').str(); 
    
    // All listen() methods can take a backlog parameter to specify the maximum
    // length of the queue of pending connections. The actual length will be
    // determined by the OS through sysctl settings such as tcp_max_syn_backlog
    // and somaxconn on Linux. The default value of this parameter is 511 (not
    // 512).
    const backlog = 511;
    
    // Start listening on the HTTP port. 
    await bluebird.fromCallback(
      (cb) => server.listen(port, hostname, backlog, cb));
      
    const address = server.address();
    const protocol = 'http';
    
    const serverUrl = protocol + '://' + address.address + ':' + address.port;
    logger.info(`Core Server (API module) listening on ${serverUrl}`);
    
    // Warning if ignoring forbidden updates
    if (settings.get('updates.ignoreProtectedFields').bool()) {
      logger.warn('Server configuration has "ignoreProtectedFieldUpdates" set to true: ' +
        'This means updates to protected fields will be ignored and operations will succeed. ' +
        'We recommend turning this off, but please be aware of the implications for your code.');
    }


    if (settings.get('deprecated.auth.ssoIsWhoamiActivated').bool()) {
      logger.warn('Server configuration has "ssoIsWhoamiActivated" set to true: ' + 
        'This means that the API method "GET /auth/who-am-i" is activated. ' + 
        'We recommend turning this off as this method might be removed in the next major release.');
    }
    
    // TEST: execute test setup instructions if any
    const instanceTestSetup = settings.get('instanceTestSetup'); 
    if (process.env.NODE_ENV === 'test' && instanceTestSetup.exists()) {
      try {
        const axonSocket = this.notificationBus.axonSocket;
        require('components/test-helpers')
          .instanceTestSetup.execute(instanceTestSetup.str(), axonSocket);
      } catch (err) {
        logger.warn('Error executing instance test setup instructions: ' + err.message);
      }
    }
  }
  
  // Opens an axon PUB socket. The socket will be used for three purposes: 
  //
  //  a) Internal communication via events, called directly on the notifications 
  //    instance. 
  //  b) Communication with the tests. When ran via InstanceManager, this is 
  //    used to synchronize with the tests. 
  //  c) For communication with other api-server processes on the same core. 
  // 
  // You can turn this off! If you set 'tcpMessaging.enabled' to false, nstno axon
  // messaging will be performed. This method returns a plain EventEmitter 
  // instead; allowing a) and c) to work. The power of interfaces. 
  // 
  async openNotificationBus(): EventEmitter {
    const logger = this.logger; 
    const settings = this.settings; 

    const enabled = settings.get('tcpMessaging.enabled').bool();
    if (! enabled) return new EventEmitter(); 
    
    const tcpMessaging = settings.get('tcpMessaging').obj();
    const host = settings.get('tcpMessaging.host').str();
    const port = settings.get('tcpMessaging.port').num();
    
    try {
      const socket = await bluebird.fromCallback(
        (cb) => utils.messaging.openPubSocket(tcpMessaging, cb));
        
      logger.info(`TCP pub socket ready on ${host}:${port}`);
      return socket; 
    }
    catch (err) {
      logger.error('Error setting up TCP pub socket: ' + err);
      process.exit(1);
    }
  }
  
  // Sets up `Notifications` bus and registers it for everyone to consume. 
  // 
  async setupNotificationBus() {
    const dependencies = this.application.dependencies;
    const notificationEvents = await this.openNotificationBus();
    const bus = this.notificationBus = new Notifications(notificationEvents);
    
    dependencies.register({
      notifications: bus,
    });
  }
  
  // Installs actual routes in express and prints 'Server ready'.
  //
  addRoutes(expressApp: express$Application) {
    const application = this.application;

    // For DNS LESS load register
    if (this.isOpenSource) {
      require('../../register')(expressApp, this.application);
      require('../../www')(expressApp, this.application);
    }
  
    // system and root MUST come first
    require('./routes/system')(expressApp, application);
    require('./routes/root')(expressApp, application);

    require('./routes/accesses')(expressApp, application);
    require('./routes/account')(expressApp, application);
    require('./routes/auth')(expressApp, application);
    require('./routes/events')(expressApp, application);
    require('./routes/followed-slices')(expressApp, application);
    require('./routes/profile')(expressApp, application);
    require('./routes/service')(expressApp, application);
    require('./routes/streams')(expressApp, application);
    if(! this.isOpenSource) require('./routes/webhooks')(expressApp, application);
  }


  async setupReporting() {
    const Reporting = require('lib-reporting');
    async function collectClientData() {
      return {
        userCount: await this.getUserCount()
      }
    };

    const reportingSettings = this.settings.get('reporting').value;
    const templateVersion = reportingSettings.templateVersion;
    const licenseName = reportingSettings.licenseName;
    const role = 'api-server';
    const mylog = function (str) {
      this.logger.info(str);
    }.bind(this);
    new Reporting(licenseName, role, templateVersion, collectClientData.bind(this), mylog);
  }

  async getUserCount(): Promise<Number> {
    const usersStorage = this.application.storageLayer.users;
    let numUsers = await bluebird.fromCallback(cb => {
      usersStorage.count({}, cb);
    });
    return numUsers;
  }

}
module.exports = Server;
