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

const errorHandling = require('components/errors').errorHandling;
const commonMeta = require('../methods/helpers/setCommonMeta');
const bluebird = require('bluebird');
const NATS_CONNECTION_URI = require('components/utils').messaging.NATS_CONNECTION_URI;

(async () => {
  await commonMeta.loadSettings();
})();

import type { Logger } from 'components/utils';
const MethodContext = require('components/model').MethodContext;
import type API from '../API';

import type { MessageSink } from './message_sink';
import type { StorageLayer } from 'components/storage';

type SocketIO$SocketId = string; 
export type SocketIO$Handshake = {
  methodContext: MethodContext,
  query: {
    resource: string,
    auth: string, 
  }
}; 
type SocketIO$CallData = {
  name: string, 
  args: Array<mixed>,
}; 
type SocketIO$Socket = {
  id: SocketIO$SocketId;
  on(string, ...a: Array<mixed>): mixed; 
  once(string, ...a: Array<mixed>): mixed; 
  namespace: SocketIO$Namespace;
};
type SocketIO$Namespace = {
  // Here's a bad interface.
  on(string, ...a: Array<mixed>): mixed; 
  emit(string, ...a: Array<mixed>): void; 
  name: string; 
  sockets: {[socketId: SocketIO$SocketId]: SocketIO$Socket};
}
type SocketIO$Server = {
  of: (string) => SocketIO$Namespace; 
  handshaken: {[id: SocketIO$SocketId]: SocketIO$Handshake};
}; 

// Manages contexts for socket-io. NamespaceContext's are created when the first
// client connects to a namespace and are then kept forever.  
// 
class Manager implements MessageSink {
  contexts: Map<string, NamespaceContext>; 
  
  logger: Logger; 
  io: SocketIO$Server; 
  api: API; 
  storageLayer: StorageLayer;
  customAuthStepFn: Object;
  isOpenSource: boolean;

  constructor(
    logger: Logger, io: SocketIO$Server, api: API, storageLayer: StorageLayer, customAuthStepFn: Object,
    isOpenSource: boolean,
  ) {
    this.logger = logger; 
    this.io = io; 
    this.api = api; 
    this.isOpenSource = isOpenSource;
    this.contexts = new Map(); 
    this.storageLayer = storageLayer;
    this.customAuthStepFn = customAuthStepFn;
  }
  
  // Returns true if the `candidate` could be a username on a lexical level. 
  // 
  looksLikeUsername(candidate: string): boolean {
    const reUsername = /^([a-zA-Z0-9])(([a-zA-Z0-9-]){3,21})[a-zA-Z0-9]$/; 
    return reUsername.test(candidate);
  }

  // Extracts the username from the given valid namespace name.
  // Returns null if the given `namespaceName` cannot be parsed as a user name. 
  // 
  //    manager.getUsername('/foobar') // => 'foobar'
  //
  extractUsername(namespaceName: string): ?string {
    if (! namespaceName.startsWith('/')) return null; 

    // assert: namespaceName[0] === '/'
    const candidate = namespaceName.slice(1);
      
    if (! this.looksLikeUsername(candidate)) return null; 
    
    return candidate;
  }
  
  async ensureInitNamespace(namespaceName: string): NamespaceContext {  
    let context = this.contexts.get(namespaceName);
    let username = this.extractUsername(namespaceName);

    // Value is not missing, return it. 
    if (typeof context === 'undefined') {
      const socketNs = this.io.of(namespaceName);
      socketNs.use(this.authorizeUserMiddleware.bind(this));

      const sink: MessageSink = this;

      context = new NamespaceContext(
        username,
        this.io, socketNs,
        this.api,
        sink, this.logger, this.isOpenSource);
        
      context.init();

      this.contexts.set(namespaceName, context);
    }  
    await context.open();
    return context;
  }


  // authorize middleware for NS
  async authorizeUserMiddleware(
    socket, callback: (err: any, res: any) => mixed
  ) {
    const handshake = socket.handshake;
    const nsName = handshake.query.resource;
    if (nsName == null) return callback("Missing 'resource' parameter.", false);


    const userName = this.extractUsername(nsName);
    if (userName == null) return callback(`Invalid resource "${nsName}".`, false);

    const accessToken = handshake.query.auth;
    if (accessToken == null)
      return callback("Missing 'auth' parameter with a valid access token.", false);

    const context = new MethodContext(
      userName, accessToken,
      this.customAuthStepFn);

    // HACK Attach our method context to the socket as a means of talking to
    // the code in Manager. 
    socket.methodContext = context;
    try {
      // Load user, init the namespace
      await context.retrieveUser(this.storageLayer);
      if (context.username == null) throw new Error('AF: context.username != null');
    
      // Load access
      await context.retrieveExpandedAccess(this.storageLayer);


      callback(null, true);
    } catch (err) {
      callback(err, false);
    }
  }
    
  // Given a `userName` and a `message`, delivers the `message` as a socket.io
  // event to all clients currently connected to the namespace '/USERNAME'.
  // 
  // Part of the MessageSink implementation.
  //
  deliver(userName: string, message: string | {}): void {
    const context = this.contexts.get(`/${userName}`);
    if (context == null) return; 
    
    const namespace = context.socketNs;
    if (namespace == null) 
      throw new Error('AF: namespace should not be null');
    
    if (typeof message === 'object') {
      message = JSON.stringify(message);
    }

    namespace.emit(message);
  }
}

class NamespaceContext {
  username: string; 
  socketServer: SocketIO$Server;
  socketNs: SocketIO$Namespace;
  api: API; 
  sink: MessageSink;
  logger: Logger; 
  
  connections: Map<SocketIO$SocketId, Connection>; 
  natsSubscriber: ?NatsSubscriber; 
  
  constructor(
    username: string, 
    socketServer: SocketIO$Server, socketNs: SocketIO$Namespace, 
    api: API, 
    sink: MessageSink, 
    logger: Logger,
    isOpenSource: Boolean
  ) {
    this.username = username; 
    this.socketServer = socketServer;
    this.socketNs = socketNs; 
    this.api = api; 
    this.sink = sink; 
    this.logger = logger; 
    this.isOpenSource = isOpenSource;
    this.connections = new Map(); 
    this.natsSubscriber = null;
  }
    
  // Registers callbacks that we need for the context to operate. This happens
  // only once, when the namespace gets its first connection - after that, 
  // namespaces are cached. 
  // 
  init() {
    const logger = this.logger; 
    const socketNs = this.socketNs;
    const namespaceName = this.socketNs.name;
    socketNs.use(require('socketio-wildcard')());
    socketNs.on('connection', 
      (socket: SocketIO$Socket) => this.onConnect(socket));
  }

  // Adds a connection to the namespace. This produces a `Connection` instance 
  // and stores it in (our) namespace. 
  // 
  addConnection(socket: SocketIO$Socket, methodContext: MethodContext) {  
    // This will represent state that we keep for every connection. 
    const connection = new Connection(
      this.logger, socket, this, socket.methodContext, this.api);

    // Permanently store the connection in this namespace.
    this.storeConnection(connection);
    socket.once('disconnect', 
      () => this.onDisconnect(connection));
    
    connection.init();
  }
  storeConnection(conn: Connection) {
    const connMap = this.connections;
    connMap.set(conn.key(), conn);
  }
  deleteConnection(conn: Connection) {
    const connMap = this.connections;
    connMap.delete(conn.key());
  }
  
  async open() {
    // If we've already got an active subscription, leave it be. 
    if (this.natsSubscriber != null || this.isOpenSource) return; 
    this.natsSubscriber = await this.produceNatsSubscriber();
  }
  async produceNatsSubscriber(): Promise<NatsSubscriber> {
    const sink: MessageSink = this.sink; 
    const userName = this.username;
    const NatsSubscriber = require('./nats_subscriber');
    const natsSubscriber = new NatsSubscriber(
      NATS_CONNECTION_URI, 
      sink,
      (username: string): string => {
        return `${username}.sok1`;
      }
    );
          
    // We'll await this, since the user will want a connection that has
    // notifications turned on immediately. 
    await natsSubscriber.subscribe(userName);
    
    return natsSubscriber;
  }
  
  // Closes down resources associated with this namespace context. 
  // 
  async close() {
    const natsSubscriber = this.natsSubscriber;

    if (natsSubscriber == null) return; 
    this.natsSubscriber = null; 
    
    await natsSubscriber.close(); 
  }

  // ------------------------------------------------------------ event handlers
  
  // Called when a new socket connects to the namespace `socketNs`.
  // 
  onConnect(socket: SocketIO$Socket) {
    const logger = this.logger; 
    const io = this.socketServer; 
    
    const namespaceName = socket.nsp.name;
    
    logger.info(`New client connected on namespace '${namespaceName}' (context ${this.socketNs.name})`);
    
    // FLOW This is attached to the socket by our initUsersNameSpaces.
    const methodContext = socket.methodContext; 
    
    if (methodContext == null) {
      logger.warn('AF: onNsConnect received handshake w/o method context.');
      return; 
    }
    
    this.addConnection(socket, methodContext);  
  }

  // Called when the underlying socket-io socket disconnects.
  //
  async onDisconnect(conn: Connection) {
    const logger = this.logger; 
    const namespace = this.socketNs;

    // Remove the connection from our connection list. 
    this.deleteConnection(conn);

    const remaining = this.connections.size;
    logger.info(`Namespace ${namespace.name}: socket disconnect (${remaining} conns remain).`);

    if (remaining > 0) return; 
    // assert: We're the last connected socket in this namespace. 

    logger.info(`Namespace ${namespace.name} closing down, cleaning up resources`); 

    // Namespace doesn't have any connections left, stop notifying. We'll reopen
    // this when the next socket connects.
    await this.close(); 
  }
}


class Connection {
  socket: SocketIO$Socket; 
  methodContext: MethodContext;
  api: API; 
  logger: Logger; 
  
  constructor(
    logger: Logger, 
    socket: SocketIO$Socket, 
    namespaceContext: NamespaceContext,
    methodContext: MethodContext, api: API
  ) {
    this.socket = socket; 
    this.methodContext = methodContext;
    this.api = api; 
    this.logger = logger; 
  }
  
  // This should be used as a key when storing the connection inside a Map. 
  key(): string {
    return this.socket.id;
  }
  
  init() {
    this.socket.on('*', (callData, callback) => this.onMethodCall(callData, callback));
  }
  
  // ------------------------------------------------------------ event handlers
  
  // Called when the socket wants to call a Pryv IO method. 
  // 
  async onMethodCall(callData: SocketIO$CallData, callback: (err: mixed, res: any) => mixed) {
    const api = this.api; 
    const logger = this.logger;
    
    if (! callData || ! callData.data || callData.data.length != 3) {
      if (callback) { 
        callback(new Error("invalid data"));
      }
      return;
    }
    const apiMethod = callData.data[0];
    const params = callData.data[1];
    callback = callback || callData.data[2];
    //if (callback == null) callback = function (err: any, res: any) { }; // eslint-disable-line no-unused-vars

    // Make sure that we have a callback here. 
   
    
    const methodContext = this.methodContext;

    // FLOW MethodContext will need to be rewritten as a class...
    const userName = methodContext.username;   
    
    const answer = bluebird.fromCallback(
      (cb) => api.call(apiMethod, methodContext, params, cb));
      
    try {
      const result = await answer; 
      
      if (result == null) 
        throw new Error('AF: either err or result must be non-null');
      
      const obj = await bluebird.fromCallback(
        (cb) => result.toObject(cb));
        
      return callback(null, commonMeta.setCommonMeta(obj));
    }
    catch (err) {
      errorHandling.logError(err, {
        url: `socketIO/${userName}`,
        method: apiMethod,
        body: params
      }, logger);
      return callback(
        commonMeta.setCommonMeta({ error: errorHandling.getPublicErrorData(err) }));
    }
    // NOT REACHED
  }
}

module.exports = Manager; 