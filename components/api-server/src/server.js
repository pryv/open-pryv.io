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

const http = require('http');
const bluebird = require('bluebird');
const EventEmitter = require('events');

const utils = require('utils');

const Notifications = require('./Notifications');
const Application = require('./application');

const UsersRepository = require('business/src/users/repository');

const { getLogger, getConfig } = require('@pryv/boiler');


// Server class for api-server process. To use this, you 
// would 
// 
//    const server = new Server(); 
//    server.start(); 
// 
class Server {
  application: Application;
  isOpenSource: boolean;
  isDnsLess: Boolean;
  logger; 
  config;
  
  // Axon based internal notification and messaging bus. 
  notificationBus: Notifications;
    
  // Load config and setup base configuration. 
  //
  constructor(application: Application) {
    this.application = application;
  }
    
  // Start the server. 
  //
  async start() {
    this.logger = getLogger('server');
    this.logger.debug('start initiated');
    await this.application.initiate();
    
    const config = await getConfig(); 
    this.config = config;
   
    this.isOpenSource = config.get('openSource:isActive');
    this.isDnsLess = config.get('dnsLess:isActive');
    const defaultParam = this.findDefaultParam();
    if (defaultParam != null) {
      this.logger.error(`Config parameter "${defaultParam}" has a default value, please change it`);
      process.exit(1);
    }
   
    
    // start TCP pub messaging
    await this.setupNotificationBus();
    
    // register API methods
    this.registerApiMethods();

    // Setup HTTP and register server; setup Socket.IO.
    const server: net$Server = http.createServer(this.application.expressApp);
    this.setupSocketIO(server); 
    await this.startListen(server);

    if (! this.isOpenSource) {
      await this.setupReporting();
    }

    this.logger.info('Server ready.');
    this.notificationBus.serverReady();
    this.logger.debug('start completed');
  }

  findDefaultParam(): ?string {
    const DEFAULT_VALUES: Array<string> = ['REPLACE_ME'];
    if (DEFAULT_VALUES.includes(this.config.get('auth:adminAccessKey')))  return 'auth:adminAccessKey';
    return null;
  }
  
  // Requires and registers all API methods. 
  // 
  registerApiMethods() {
    const application = this.application;
    const l = (topic) => getLogger(topic);
    const config = this.config;
    
    require('./methods/system')(application.systemAPI,
      application.storageLayer.accesses, 
      config.get('services'), 
      application.api, 
      application.logging, 
      application.storageLayer);
    
    require('./methods/utility')(application.api, application.logging, application.storageLayer);

    require('./methods/auth/login')(application.api, 
      application.storageLayer.accesses, 
      application.storageLayer.sessions, 
      application.storageLayer.events, 
      config.get('auth'));
    
    require('./methods/auth/register')(application.api, 
      application.logging, 
      application.storageLayer, 
      config.get('services'));

    require('./methods/auth/register-dnsless')(application.api, 
      application.logging, 
      application.storageLayer, 
      config.get('services'));

      require('./methods/auth/delete')(application.api,
        application.logging,
        application.storageLayer,
        config);

    require('./methods/accesses')(
      application.api, 
      this.notificationBus, 
      application.getUpdatesSettings(), 
      application.storageLayer);

    require('./methods/service')(
      application.api, l('methods/service'));

    if (! this.isOpenSource) {
      require('./methods/webhooks')(
        application.api, l('methods/webhooks'),
        application.getWebhooksSettings(),
        application.storageLayer,
      );
    }

    require('./methods/trackingFunctions')(
      application.api,
      l('methods/trackingFunctions'),
      application.storageLayer,
    );

    require('./methods/account')(application.api, 
      application.storageLayer.events, 
      application.storageLayer.passwordResetRequests, 
      config.get('auth'), 
      config.get('services'), 
      this.notificationBus,
      application.logging
    );

    require('./methods/followedSlices')(application.api, application.storageLayer.followedSlices, this.notificationBus);

    require('./methods/profile')(application.api, application.storageLayer.profile);

    require('./methods/streams')(application.api, 
      application.storageLayer.streams, 
      application.storageLayer.events, 
      application.storageLayer.eventFiles, 
      this.notificationBus, 
      application.logging, 
      config.get('versioning'), 
      config.get('updates'));

    require('./methods/events')(application.api, 
      application.storageLayer.events, 
      application.storageLayer.eventFiles, 
      config.get('auth'), 
      config.get('service:eventTypes'), 
      this.notificationBus, 
      application.logging,
      config.get('versioning'),
      config.get('updates'), 
      config.get('openSource'), 
      config.get('services'));

    this.logger.debug('api method registered');
  }
  
  setupSocketIO(server: net$Server) {
    const application = this.application; 
    const notificationBus = this.notificationBus;
    const api = application.api; 
    const storageLayer = application.storageLayer;
    const config = this.config; 
    const customAuthStepFn = application.getCustomAuthFunction('server.js');
    const isOpenSource = this.isOpenSource;
        
    const socketIOsetup = require('./socket-io');
    socketIOsetup(
      server, getLogger('socketIO'), 
      notificationBus, api, 
      storageLayer, customAuthStepFn,
      isOpenSource);
    this.logger.debug('socket io setup done');
  }
  
  // Open http port and listen to incoming connections. 
  //
  async startListen(server: net$Server) {
    const config = this.config; 
    const logger = this.logger; 
    
    const port = config.get('http:port');
    const hostname = config.get('http:ip'); 
    
    
    // All listen() methods can take a backlog parameter to specify the maximum
    // length of the queue of pending connections. The actual length will be
    // determined by the OS through sysctl config such as tcp_max_syn_backlog
    // and somaxconn on Linux. The default value of this parameter is 511 (not
    // 512).
    const backlog = 511;
    
    // Start listening on the HTTP port. 
    await bluebird.fromCallback(
      (cb) => server.listen(port, hostname, backlog, cb));
    
    
      
    const address = server.address();
    const protocol = 'http';
    
    const serverUrl = protocol + '://' + address.address + ':' + address.port;
    logger.debug('listening on ' + serverUrl);
    logger.info(`Core Server (API module) listening on ${serverUrl}`);
    
    // Warning if ignoring forbidden updates
    if (config.get('updates:ignoreProtectedFields')) {
      logger.warn('Server configuration has "ignoreProtectedFieldUpdates" set to true: ' +
        'This means updates to protected fields will be ignored and operations will succeed. ' +
        'We recommend turning this off, but please be aware of the implications for your code.');
    }
    
    // TEST: execute test setup instructions if any
    const instanceTestSetup = config.get('instanceTestSetup') || null; // coerce to null  
    if (process.env.NODE_ENV === 'test' && instanceTestSetup !== null) {
      logger.debug('specific test setup ');
      try {
        const axonSocket = this.notificationBus.axonSocket;
        
        require('test-helpers')
          .instanceTestSetup.execute(instanceTestSetup, axonSocket);
      } catch (err) {
        logger.error(err);
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
    const config = this.config; 

    const enabled = config.get('tcpMessaging:enabled');
    if (! enabled) return new EventEmitter(); 
    
    const tcpMessaging = config.get('tcpMessaging');
    const host = config.get('tcpMessaging:host');
    const port = config.get('tcpMessaging:port');
    
    try {
      const socket = await bluebird.fromCallback(
        (cb) => utils.messaging.openPubSocket(tcpMessaging, cb));
        
      logger.debug(`AXON TCP pub socket ready on ${host}:${port}`);
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
    const notificationEvents = await this.openNotificationBus();
    const bus = this.notificationBus = new Notifications(notificationEvents);
  }


  async setupReporting() {
    const Reporting = require('lib-reporting');
    const serviceInfoUrl = this.config.get('serviceInfoUrl');
    async function collectClientData() {
      return {
        userCount: await this.getUserCount(),
        serviceInfoUrl: serviceInfoUrl
      };
    }

    const reportingSettings = this.config.get('reporting');
    const templateVersion = reportingSettings.templateVersion;
    const reportingUrl = (process.env.NODE_ENV === 'test') ? 'http://localhost:4001' : null ;
    const licenseName = reportingSettings.licenseName;
    const role = 'api-server';
    const mylog = function (str) {
      this.logger.info(str);
    }.bind(this);
    new Reporting(licenseName, role, templateVersion, collectClientData.bind(this), mylog, reportingUrl);
  }

  async getUserCount(): Promise<Number> {
    let numUsers;
    try{
      let usersRepository = new UsersRepository(this.application.storageLayer.events);
      numUsers = await usersRepository.count();
    } catch (error) {
      this.logger.error(error);
      throw error;
    }
    return numUsers;
  }
}
module.exports = Server;
