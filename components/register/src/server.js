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
/**
 * Runs the server. Launch with `node server [options]`.
 */

const app = require('./app');
const logger = require('winston');

const http = require('http');
const bluebird = require('bluebird');

const ready = require('readyness');

const info = require('./business/service-info');
const config = require('./config');

ready.setLogger(logger.info);

/**
 * server: http.Server;
 * Produces the server instance for listening to HTTP/HTTPS traffic, depending
 * on the configuration.
 *
 * NOTE Since we depend on there being an url property in the server, we don't
 *    return vanilla servers from this function but a subtype. Make sure
 *    the code knows about the `url`.
 */
class ServerWithUrl {
  /**
   * @type {http.Server}
   */
  server;
  /**
   * @type {string}
   */
  url;
  /**
   * @type {object}
   */
  config;

  constructor (customConfig) {
    this.config = customConfig || config;
    this.server = http.createServer(app);
  }

  /**
   * @returns {Promise<void>}
   */
  async start () {
    logger.info('Register  server :' + info.register);
    if (this.config.get('server:port') <= 0) {
      logger.info('** HTTP server is off !');
      return;
    }
    const appListening = ready.waitFor(
      'register:listening:' +
        this.config.get('server:ip') +
        ':' +
        this.config.get('server:port')
    );
    const opts = {
      port: this.config.get('server:port'),
      host: this.config.get('server:ip')
    };
    try {
      await bluebird.fromCallback((cb) => this.server.listen(opts, cb));
    } catch (e) {
      if (e.code === 'EACCES') {
        logger.error('Cannot ' + e.syscall);
        throw e;
      }
    }
    const address = this.server.address();
    const protocol = 'http';
    const serverURL = protocol + '://' + address.address + ':' + address.port;
    // Tests access 'server.url' for now. Deprecated.
    this.url = this.server.url = serverURL;
    // Use this instead.
    this.config.set('server:url', this.server.url);
    const readyMessage =
      'Registration server v' +
      require('../package.json').version +
      ' listening on ' +
      serverURL +
      '\n Serving main domain: ' +
      this.config.get('dns:domain') +
      ' extras: ' +
      this.config.get('dns:domains');
    logger.info(readyMessage);
    appListening(readyMessage);
    // start dns
    require('./app-dns');
  }

  /**
   * @returns {any}
   */
  async collectClientData () {
    const usersStorage = require('./storage/users');
    const users = await bluebird.fromCallback((cb) => {
      usersStorage.getAllUsersInfos(cb);
    });
    const numUsers = users.length;
    return { numUsers, domain: this.config.get('dns:domain') };
  }

  /**
   * @returns {Promise<void>}
   */
  async stop () {
    await this.server.close();
  }
}
module.exports = ServerWithUrl;
