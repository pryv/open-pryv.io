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

/**
 * Runs the server. Launch with `node server [options]`.
 */

const app = require('./app');
const logger = require('winston');
    
const http = require('http');
const superagent = require('superagent');
const bluebird = require('bluebird');
const child_process = require('child_process');
const url = require('url');

const ready = require('readyness');

const info = require('./business/service-info');
const config = require('./config');


ready.setLogger(logger.info);

// server: http.Server;
// Produces the server instance for listening to HTTP/HTTPS traffic, depending
// on the configuration. 
//
// NOTE Since we depend on there being an url property in the server, we don't 
//    return vanilla servers from this function but a subtype. Make sure
//    the code knows about the `url`.
//
class ServerWithUrl {
  server: http.Server;
  url: string;
  config: Object;

  constructor(customConfig: Object) {
    this.config = customConfig || config;
    this.server = http.createServer(app);
  }

  async start() {
    logger.info('Register  server :' + info.register);

    if (this.config.get('server:port') <= 0) {
      logger.info('** HTTP server is off !');
      return;
    }

    const appListening = ready.waitFor('register:listening:' + this.config.get('server:ip') + ':' + this.config.get('server:port'));
    
    const opts = {
      port: this.config.get('server:port'),
      host: this.config.get('server:ip'),
    };

    try {
      await bluebird.fromCallback(
        (cb) => this.server.listen(opts, cb));
    }
    catch(e) {
      if (e.code === 'EACCES') {
        logger.error('Cannot ' + e.syscall);
        throw (e);
      }
    }

    const address = this.server.address();
    const protocol = 'http';

    const server_url = protocol + '://' + address.address + ':' + address.port;
    
    // Tests access 'server.url' for now. Deprecated. 
    this.url = this.server.url = server_url;
    
    // Use this instead.
    this.config.set('server:url', this.server.url);

    const readyMessage = 'Registration server v' + require('../package.json').version +
        ' listening on ' + server_url +
      '\n Serving main domain: ' + this.config.get('dns:domain') +
      ' extras: ' + this.config.get('dns:domains');
    logger.info(readyMessage);
    appListening(readyMessage);

    this.collectUsageAndSendReport();

    //start dns
    require('./app-dns');
  }

  async collectUsageAndSendReport() {

    // Check if the PRYV_REPORTING_OFF environment variable is set to true.
    // If it is, don't collect data and don't send report
    const optOutReporting = this.config.get('reporting:optOut');

    if (optOutReporting === 'true') {
      logger.info('Reporting opt-out is set to true, not reporting');
      return;
    }

    // Collect data
    let reportingSettings = this.config.get('reporting');
    const hostname = await this.collectHostname();
    const clientData = await this.collectClientData();
    const body = {
      licenseName: reportingSettings.licenseName,
      role: reportingSettings.role,
      hostname: hostname,
      templateVersion: reportingSettings.templateVersion,
      clientData: clientData
    };

    // Send report
    const reportingUrl = 'https://reporting.pryv.com';
    try {
      const res = await superagent.post(url.resolve(reportingUrl, 'reports')).send(body);
      logger.info('Report sent to ' + reportingUrl, res.body);
    } catch(error) {
      logger.error('Unable to send report to ' + reportingUrl + ' Reason : ' + error.message);
    }

    // Schedule another report in 24 hours
    const hours = 24;
    const timeout = hours * 60 * 60 * 1000;
    logger.info('Scheduling another report in ' + hours + ' hours');
    setTimeout(() => {
      this.collectUsageAndSendReport();
    }, timeout);
  }

  async collectClientData(): Object {
    const usersStorage = require('./storage/users');

    let numUsers = await bluebird.fromCallback(cb => {
      usersStorage.getAllUsersInfos(cb);
    });
    numUsers = numUsers.length;

    return {numUsers: numUsers};
  }

  async collectHostname(): Object {
    const hostname = await bluebird.fromCallback(
      cb => child_process.exec('hostname', cb));
    return hostname.replace(/\s/g,''); // Remove all white spaces
  }

  async stop() {
    await this.server.close();
  }
}

module.exports = ServerWithUrl;
