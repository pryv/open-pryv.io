/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


// Always require application first to be sure boiler is initialized
const { getApplication } = require('api-server/src/application');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { testMessaging } = require('messages');
const { pubsub } = require('messages');
const { getUsersRepository } = require('business/src/users');
const { getLogger, getConfig } = require('@pryv/boiler');
const { getAPIVersion } = require('middleware/src/project_version');
const { WebhooksService } = require('webhooks/src/service');
let app;

/**
 * Server class for api-server process. To use this, you would:
 *
 *    const server = new Server();
 *    server.start();
 */
class Server {
  logger: any;
  config: any;
  httpsServer: any;
  isAuditActive: boolean;

  /**
   * @returns {Promise<void>}
   */
  async start () {
    this.logger = getLogger('server');
    this.logger.debug('start initiated');
    const apiVersion = await getAPIVersion();
    app = getApplication();
    await app.initiate();
    const config = await getConfig();
    this.config = config;
    this.isAuditActive = config.get('audit:active');
    const defaultParam = this.findDefaultParam();
    if (defaultParam != null) {
      this.logger.error(`Config parameter "${defaultParam}" has a default value, please change it`);
      process.exit(1);
    }
    // setup test notification bus (IPC-based)
    await this.setupTestsNotificationBus();
    // register API methods
    await this.registerApiMethods();
    // Setup HTTP and register server; setup Socket.IO.
    let server = null;
    const serverInfos: any = {
      hostname: null
    };
    if (config.get('http:ssl:backloop.dev')) { // SSL is used in openSource version
      // Lazy require: backloop.dev is a devDependency, not installed in
      // production images (Dockerfile does `npm install --omit=dev`).
      // Only load when actually wired into config.
      const recLaOptionsAsync = require('backloop.dev').httpsOptionsAsync;
      await new Promise<void>((resolve, reject) => {
        recLaOptionsAsync((err, recLaOptions) => {
          if (err) return reject(err);
          server = https.createServer(recLaOptions, app.expressApp);
          serverInfos.hostname = 'my-computer.backloop.dev';
          resolve();
        });
      });
      this.logger.info('SSL Mode using backloop.dev certificates');
    } else if (config.get('http:ssl:keyFile')) { // https with local files
      server = https.createServer(buildHttpsOptions(config), app.expressApp);
      serverInfos.hostname = 'custom-according-to-your-ssl-cert';
      this.logger.info('SSL Mode using custom certificates');
      // Keep a reference so reloadTls() can hot-swap the SecureContext
      // when the Let's Encrypt orchestrator (Plan 35) rotates the cert.
      this.httpsServer = server;
    } else { // http
      server = http.createServer(app.expressApp);
    }
    await this.setupSocketIO(server);
    await this.startListen(server, serverInfos);
    this.logger.info('Server ready. API Version: ' + apiVersion);
    pubsub.status.emit(pubsub.SERVER_READY);
    // Start webhooks service in-process (unless explicitly disabled)
    if (config.get('webhooks:inProcess') !== false) {
      await this.startWebhooksService();
    }
    this.logger.debug('start completed');
  }

  /**
   * @returns {string}
   */
  findDefaultParam () {
    const DEFAULT_VALUES = ['REPLACE_ME'];
    if (DEFAULT_VALUES.includes(this.config.get('auth:adminAccessKey'))) { return 'auth:adminAccessKey'; }
    return null;
  }

  /**
   * Requires and registers all API methods.
   * @returns {Promise<void>}
   */
  async registerApiMethods () {
    await require('./methods/system')(app.systemAPI, app.api);
    await require('./methods/utility')(app.api);
    await require('./methods/auth/login')(app.api);
    await require('./methods/auth/register')(app.api);
    await require('./methods/auth/delete')(app.api);
    await require('./methods/mfa')(app.api);
    await require('./methods/accesses')(app.api);
    require('./methods/service')(app.api);
    await require('./methods/webhooks')(app.api);
    await require('./methods/trackingFunctions')(app.api);
    await require('./methods/account')(app.api);
    await require('./methods/profile')(app.api);
    await require('./methods/streams')(app.api);
    await require('./methods/events')(app.api);
    if (this.isAuditActive) {
      require('audit/src/methods/audit-logs')(app.api);
    }
    this.logger.debug('api methods registered');
  }

  /**
   * @param {http.Server} server
   * @returns {Promise<void>}
   */
  async setupSocketIO (server) {
    const api = app.api;
    const customAuthStepFn = app.getCustomAuthFunction('server.js');
    const socketIOsetup = require('./socket-io');
    await socketIOsetup(server, api, customAuthStepFn);
    this.logger.debug('socket io setup done');
  }

  /**
   * Open http port and listen to incoming connections.
   * @param {http.Server} server
   * @returns {Promise<void>}
   */
  async startListen (server, info: any = {}) {
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
    let startFinished = false;
    await new Promise<void>((resolve, reject) => {
      server.listen(port, hostname, backlog, () => {
        if (!startFinished) {
          startFinished = true;
          resolve();
        }
      });
      server.once('error', (err) => {
        if (!startFinished) {
          startFinished = true;
          console.log(
            'There was an error starting the server in the error listener:',
            err
          );
          reject(err);
        }
      });
    });
    const address = server.address();
    const protocol = server.key == null ? 'http' : 'https';
    const hostnameStr = info.hostname || address.address;
    const serverUrl = protocol + '://' + hostnameStr + ':' + address.port;
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
        const testNotifier = await testMessaging.getTestNotifier();
        require('test-helpers').instanceTestSetup.execute(instanceTestSetup, testNotifier);
      } catch (err) {
        logger.error(err);
        logger.warn('Error executing instance test setup instructions: ' + err.message);
      }
    }
  }

  /**
   * Sets up `Notifications` bus and registers it for everyone to consume.
   * @returns {Promise<void>}
   */
  async setupTestsNotificationBus () {
    const testNotifier = await testMessaging.getTestNotifier();
    pubsub.setTestNotifier(testNotifier);
  }

  /**
   * Starts the webhooks service in-process, eliminating the need for a
   * separate webhooks container/process.
   * @returns {Promise<void>}
   */
  async startWebhooksService () {
    const config = this.config;
    const storage = require('storage');
    const storageLayer = await storage.getStorageLayer();
    const webhooksService = new WebhooksService({
      storage: storageLayer,
      logger: getLogger('webhooks_service'),
      settings: config
    });
    app.webhooksService = webhooksService;
    await webhooksService.start();
    this.logger.info('Webhooks service started in-process');
  }

  /**
   * @returns {Promise<Number>}
   */
  async getUserCount () {
    let numUsers;
    try {
      const usersRepository = await getUsersRepository();
      numUsers = await usersRepository.count();
    } catch (error) {
      this.logger.error(error, error);
      throw error;
    }
    return numUsers;
  }

  /**
   * Hot-swap the TLS context from the currently-configured cert/key
   * files. Triggered by a `acme:rotate` IPC message from master after
   * the Let's Encrypt orchestrator (Plan 35) writes a freshly-renewed
   * cert to disk. No-op when this worker isn't serving HTTPS.
   *
   * Uses https.Server.setSecureContext which takes effect for new TLS
   * handshakes while leaving in-flight connections alone — validated
   * in Plan 35 Phase 1 Level 3 spike.
   */
  reloadTls () {
    if (this.httpsServer == null) {
      this.logger.debug('reloadTls: no https server in this worker — ignoring');
      return { reloaded: false, reason: 'not-https' };
    }
    try {
      const options = buildHttpsOptions(this.config);
      this.httpsServer.setSecureContext(options);
      this.logger.info('TLS context reloaded from disk');
      return { reloaded: true };
    } catch (err) {
      this.logger.error('reloadTls failed: ' + err.message);
      return { reloaded: false, reason: 'error', error: err.message };
    }
  }
}

/**
 * Read https options off the config's `http.ssl.*` file paths.
 * Reads fresh each call so reloadTls picks up rotated files.
 */
function buildHttpsOptions (config) {
  const options: any = {
    key: fs.readFileSync(config.get('http:ssl:keyFile')),
    cert: fs.readFileSync(config.get('http:ssl:certFile'))
  };
  if (config.get('http:ssl:caFile')) {
    options.ca = [fs.readFileSync(config.get('http:ssl:caFile'))];
  }
  return options;
}

module.exports = Server;
