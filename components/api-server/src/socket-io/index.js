/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
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
 * 
 */
// @flow

/**
 * Note: Debug tests with: DEBUG=engine,socket.io* yarn test --grep="Socket"
 */

const socketIO = require('socket.io');

const MethodContext = require('model').MethodContext;
const NATS_CONNECTION_URI = require('utils').messaging.NATS_CONNECTION_URI;

const Manager = require('./Manager');
const Paths = require('../routes/Paths');

const ChangeNotifier = require('./change_notifier');

import type { StorageLayer } from 'storage';
import type { CustomAuthFunction } from 'model';

import type API  from '../API';
import type { SocketIO$Handshake }  from './Manager';

// Initializes the SocketIO subsystem. 
//
function setupSocketIO(
  server: net$Server, logger, 
  notifications: EventEmitter, api: API, 
  storageLayer: StorageLayer, 
  customAuthStepFn: ?CustomAuthFunction,
  isOpenSource: boolean,
) {
 
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
      const context = new MethodContext(
        userName,
        query.auth,
        customAuthStepFn,
        storageLayer.events
      );
      // Load user, init the namespace
      await context.retrieveUser();
      if (context.user == null) throw new Error('AF: context.user != null');
    
      // Load user, init the namespace
      await context.retrieveUser();
      if (context.username == null) throw new Error('AF: context.username != null');
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

  // Setup the chain from notifications -> NATS
  if (! isOpenSource) {
    const NatsPublisher = require('./nats_publisher');
    const natsPublisher = new NatsPublisher(NATS_CONNECTION_URI, 
      (userName: string): string => { return `${userName}.sok1`; }
    );
    const changeNotifier = new ChangeNotifier(natsPublisher);
    changeNotifier.listenTo(notifications);

    // Webhooks nats publisher - could be moved if there is a more convenient place.
    const whNatsPublisher = new NatsPublisher(NATS_CONNECTION_URI,
      (userName: string): string => { return `${userName}.wh1`; }
    );
    const webhooksChangeNotifier = new ChangeNotifier(whNatsPublisher);
    webhooksChangeNotifier.listenTo(notifications);
  } else {
    const changeNotifier = new ChangeNotifier(manager);
    changeNotifier.listenTo(notifications);
  }

}
module.exports = setupSocketIO; 




