/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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

// Always require application first to be sure boiler is initialized
const { getApplication } = require('api-server/src/application');
const http = require('http');
const https = require('https');
const fs = require('fs');
const recLaOptionsAsync = require('rec.la').httpsOptionsAsync;
const { axonMessaging } = require('messages');
const { pubsub } = require('messages');
const { getUsersRepository } = require('business/src/users');
const { getLogger, getConfig } = require('@pryv/boiler');
const { getAPIVersion } = require('middleware/src/project_version');
let app;

/**
 * Server class for api-server process. To use this, you would:
 *
 *    const server = new Server();
 *    server.start();
 */
class Server {
  isOpenSource;
  logger;
  config;

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
    this.isOpenSource = config.get('openSource:isActive');
    const defaultParam = this.findDefaultParam();
    if (defaultParam != null) {
      this.logger.error(`Config parameter "${defaultParam}" has a default value, please change it`);
      process.exit(1);
    }
    // start TCP pub axonMessaging
    await this.setupTestsNotificationBus();
    // register API methods
    await this.registerApiMethods();
    // Setup HTTP and register server; setup Socket.IO.
    let server = null;
    const serverInfos = {
      hostname: null
    };
    if (config.get('http:ssl:rec.la')) { // SSL is used in openSource version
      await new Promise((resolve, reject) => {
        recLaOptionsAsync((err, recLaOptions) => {
          if (err) return reject(err);
          server = https.createServer(recLaOptions, app.expressApp);
          serverInfos.hostname = 'my-computer.rec.la';
          resolve();
        });
      });
      this.logger.info('SSL Mode using rec.la certificates');
    } else if (config.get('http:ssl:keyFile')) { // https with local files
      const options = {
        key: fs.readFileSync(config.get('http:ssl:keyFile')),
        cert: fs.readFileSync(config.get('http:ssl:certFile'))
      };
      if (config.get('http:ssl:caFile')) {
        options.ca = [fs.readFileSync(config.get('http:ssl:caFile'))];
      }
      server = https.createServer(options, app.expressApp);
      serverInfos.hostname = 'custom-according-to-your-ssl-cert';
      this.logger.info('SSL Mode using custom certificates');
    } else { // http
      server = http.createServer(app.expressApp);
    }
    await this.setupSocketIO(server);
    await this.startListen(server, serverInfos);
    if (!this.isOpenSource) {
      await this.setupReporting();
    }
    this.logger.info('Server ready. API Version: ' + apiVersion);
    pubsub.status.emit(pubsub.SERVER_READY);
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
    await require('./methods/accesses')(app.api);
    require('./methods/service')(app.api);
    if (!this.isOpenSource) {
      await require('./methods/webhooks')(app.api);
    }
    await require('./methods/trackingFunctions')(app.api);
    await require('./methods/account')(app.api);
    await require('./methods/followedSlices')(app.api);
    await require('./methods/profile')(app.api);
    await require('./methods/streams')(app.api);
    await require('./methods/events')(app.api);
    if (!this.isOpenSource) {
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
  async startListen (server, info = {}) {
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
    await new Promise((resolve, reject) => {
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
        const testNotifier = await axonMessaging.getTestNotifier();
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
    const testNotifier = await axonMessaging.getTestNotifier();
    pubsub.setTestNotifier(testNotifier);
  }

  /**
   * @returns {Promise<void>}
   */
  async setupReporting () {
    const reporting = require('lib-reporting');
    const serviceInfoUrl = this.config.get('serviceInfoUrl');
    async function collectClientData () {
      return {
        userCount: await this.getUserCount(),
        serviceInfoUrl
      };
    }
    const reportingSettings = this.config.get('reporting');
    const templateVersion = reportingSettings.templateVersion;
    const reportingUrl = process.env.NODE_ENV === 'test' ? 'http://127.0.0.1:4001' : null;
    const licenseName = reportingSettings.licenseName;
    const role = 'api-server';
    const mylog = function (str) {
      this.logger.info(str);
    }.bind(this);
    reporting.start(licenseName, role, templateVersion, collectClientData.bind(this), mylog, reportingUrl);
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
}

module.exports = Server;
