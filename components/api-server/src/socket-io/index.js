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
 * Note: Debug tests with: DEBUG=engine,socket.io* yarn test --grep="Socket"
 */

const socketIO = require('socket.io')({
  allowEIO3: true // for compatibility with v2 clients
});

const MethodContext = require('business').MethodContext;
import type {ContextSource} from 'business';

const Manager = require('./Manager');
const Paths = require('../routes/Paths');
const { getConfig, getLogger } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');

import type { StorageLayer } from 'storage';
import type { CustomAuthFunction } from 'business';

import type API  from '../API';
import type { SocketIO$Handshake }  from './Manager';

// Initializes the SocketIO subsystem. 
//
async function setupSocketIO(
  server: net$Server, 
  api: API, 
  customAuthStepFn: ?CustomAuthFunction,
) {
  const config = await getConfig();
  const logger = getLogger('socketIO');
  const storageLayer = await getStorageLayer();
  const isOpenSource = config.get('openSource:isActive');


  const io = socketIO.listen(server, {
    path: Paths.SocketIO
  });

  // Manages socket.io connections and delivers method calls to the api. 
  const manager: Manager = new Manager(logger, io, api, storageLayer, customAuthStepFn, isOpenSource);
  
  // dynamicNamspaces allow to "auto" create namespaces
  // when connected pass the socket to Manager
  const dynamicNamespace = io.of(/^\/.+$/).on('connect', async (socket) => {
    const nameSpaceContext = await manager.ensureInitNamespace(socket.nsp.name);
    nameSpaceContext.onConnect(socket);
  });
  
  // add a middelware for authentication 
  // add middelware for authentication 
  dynamicNamespace.use(async (socket, next) => {
    try {
      const nsName = socket.nsp.name;
      const query = socket.handshake.query;
      const userName = manager.extractUsername(nsName);
      if (userName == null) throw new Error(`Invalid resource "${nsName}".`);
      if (query.auth == null) throw new Error("Missing 'auth' parameter with a valid access token.");
      const contextSource: ContextSource = {
        name: 'socket.io',
        ip:  socket.handshake.headers['x-forwarded-for'] || socket.request.connection.remoteAddress
      }
      
      const context = new MethodContext(
        contextSource,
        userName,
        query.auth,
        customAuthStepFn,
        storageLayer.events,
      );

      // Initailizing Context
      await context.init();

      // Load access
      await context.retrieveExpandedAccess(storageLayer);

      // attach context to socket for further usage.
      socket.methodContext = context;
      next(null, true);
    } catch (err) {
      next(err, false);
    }
  });

  // register wildcard to all namespaces
  dynamicNamespace.use(require('socketio-wildcard')());

}
module.exports = setupSocketIO; 
