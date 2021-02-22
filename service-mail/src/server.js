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
const http = require('http');
const express = require('express');
const bluebird = require('bluebird');
const bodyParser = require('body-parser');

const logging = require('./logging');
const controllerFactory = require('./web/controller');

const KEY_IP = 'http.ip';
const KEY_PORT = 'http.port';  

/**
 * HTTP server responsible for the REST api that the mailing server exposes. 
 */
class Server {
  
  constructor(settings, context) {
    const logSettings = settings.get('logs');
    const logFactory = logging(logSettings);
    
    this.logger = logFactory.getLogger('mailing-server');
    this.errorLogger = logFactory.getLogger('errors');
    this.settings = settings; 
    
    this.context = context;
    this.expressApp = this.setupExpress();
    
    const ip = settings.get(KEY_IP); 
    const port = settings.get(KEY_PORT); 
    this.baseUrl = `http://${ip}:${port}/`;
    
    this.logger.info('constructed.');
  }
  
  /**
   * Starts the HTTP server. 
   * 
   */
  async start() {
    this.logger.info('starting...');
    
    const settings = this.settings;
    const app = this.expressApp;
    
    const ip = settings.get(KEY_IP); 
    const port = settings.get(KEY_PORT); 
    
    const server = this.server = http.createServer(app);
    const serverListen = bluebird.promisify(server.listen, {context: server});
    
    await serverListen(port, ip);
    
    const addr = this.server.address(); 
    this.logger.info(`started. (http://${addr.address}:${addr.port})`);
  }
  
  /** 
   * Stops a running server instance. 
   * 
   */
  async stop() {
    const server = this.server;
      
    this.logger.info('stopping...');
    
    const serverClose = bluebird.promisify(server.close, {context: server}); 
    await serverClose();
    
    this.logger.info(`stopped.`);
  }
  
  /** 
   * Sets up the express application, injecting middleware and configuring the 
   * instance. 
   * 
   * @return express application.
   */
  setupExpress() {        
    var app = express(); 
    
    // Preprocessing middlewares
    app.use(bodyParser.json());
    
    this.defineApplication(app); 
    
    // Postprocessing middlewares
    app.use((err, req, res, next) => {
      this.errorLogger.error(err);
      res
        .status(err.httpStatus || 500)
        .json({
          error: err.message,
          data: err.data,
          request: req.body
        });
    });

    return app; 
  }
  
  /** Defines all the routes that we serve from this server. 
   */   
  defineApplication(app) {
    
    const ctx = this.context
    const c = controllerFactory(ctx); 
    
    app.get('/system/status', systemStatus);
    
    app.post('/sendmail/:template/:lang', c.sendMail);

  }
}

/** GET /system/status - Answers the caller with a status of the application. 
 */ 
function systemStatus(req, res) {
  res
    .status(200)
    .json({
      status: 'ok',
    });
}

module.exports = Server;