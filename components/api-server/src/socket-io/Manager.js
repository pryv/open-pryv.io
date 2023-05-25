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
const errorHandling = require('errors').errorHandling;
const commonMeta = require('../methods/helpers/setCommonMeta');
const bluebird = require('bluebird');
const { USERNAME_REGEXP_STR } = require('../schema/helpers');
const { pubsub } = require('messages');
(async () => {
  await commonMeta.loadSettings();
})();
const { getAPIVersion } = require('middleware/src/project_version');
const { initRootSpan } = require('tracing');
// Manages contexts for socket-io. NamespaceContext's are created when the first
// client connects to a namespace and are then kept forever.
//

class Manager {
  contexts;

  logger;

  io;

  api;

  storageLayer;

  customAuthStepFn;

  isOpenSource;

  apiVersion;

  hostname;
  constructor (logger, io, api, storageLayer, customAuthStepFn, isOpenSource) {
    this.logger = logger;
    this.io = io;
    this.api = api;
    this.isOpenSource = isOpenSource;
    this.contexts = new Map();
    this.storageLayer = storageLayer;
    this.customAuthStepFn = customAuthStepFn;
    this.hostname = require('os').hostname();
  }

  // Returns true if the `candidate` could be a username on a lexical level.
  //
  /**
   * @param {string} candidate
   * @returns {boolean}
   */
  looksLikeUsername (candidate) {
    const reUsername = new RegExp(USERNAME_REGEXP_STR);
    const lowercasedUsername = candidate.toLowerCase(); // for retro-compatibility
    return reUsername.test(lowercasedUsername);
  }

  // Extracts the username from the given valid namespace name.
  // Returns null if the given `namespaceName` cannot be parsed as a user name.
  //
  //    manager.getUsername('/foobar') // => 'foobar'
  //
  /**
   * @param {string} namespaceName
   * @returns {string}
   */
  extractUsername (namespaceName) {
    const ns = cleanNS(namespaceName);
    if (!ns.startsWith('/')) { return null; }
    // assert: namespaceName[0] === '/'
    const candidate = ns.slice(1);
    if (!this.looksLikeUsername(candidate)) { return null; }
    return candidate;
    /**
     * Takes the last field of the NS path
     *
     * @param {*} namespace
     */
    function cleanNS (namespace) {
      let cleaned = '' + namespace;
      // remove eventual trailing "/"
      if (cleaned.slice(-1) === '/') { cleaned = cleaned.slice(0, -1); }
      // get last element of path
      const s = cleaned.lastIndexOf('/');
      if (s > 0) {
        cleaned = cleaned.slice(s);
      }
      return cleaned;
    }
  }

  /**
   * @param {string} namespaceName
   * @returns {Promise<NamespaceContext>}
   */
  async ensureInitNamespace (namespaceName) {
    await initAsyncProps.call(this);
    const username = this.extractUsername(namespaceName);
    let context = this.contexts.get(username);
    // Value is not missing, return it.
    if (typeof context === 'undefined') {
      context = new NamespaceContext(username, this.io.of(namespaceName), this.api, this.logger, this.isOpenSource, this.apiVersion, this.hostname);
      this.contexts.set(username, context);
    }
    await context.open();
    return context;
    /**
     * putting this here because putting it above requires rendering too much code async. I'm sorry.
     */
    async function initAsyncProps () {
      if (this.apiVersion == null) { this.apiVersion = await getAPIVersion(); }
    }
  }
}

class NamespaceContext {
  namespaceName;

  username;

  socketNs;

  api;

  logger;

  apiVersion;

  hostname;

  connections;

  pubsubRemover;
  constructor (username, socketNs, api, logger, isOpenSource, apiVersion, hostname) {
    this.username = username;
    this.socketNs = socketNs;
    this.api = api;
    this.logger = logger;
    this.isOpenSource = isOpenSource;
    this.connections = new Map();
    this.pubsubRemover = null;
    this.apiVersion = apiVersion;
    this.hostname = hostname;
  }

  // Adds a connection to the namespace. This produces a `Connection` instance
  // and stores it in (our) namespace.
  //
  /**
   * @param {SocketIO$Socket} socket
   * @returns {void}
   */
  addConnection (socket) {
    // This will represent state that we keep for every connection.
    const connection = new Connection(this.logger, socket, this, socket.methodContext, this.api, this.apiVersion, this.hostname);
    // Permanently store the connection in this namespace.
    this.storeConnection(connection);
    socket.once('disconnect', () => this.onDisconnect(connection));
    connection.init();
  }

  /**
   * @param {Connection} conn
   * @returns {void}
   */
  storeConnection (conn) {
    const connMap = this.connections;
    connMap.set(conn.key(), conn);
  }

  /**
   * @param {Connection} conn
   * @returns {void}
   */
  deleteConnection (conn) {
    const connMap = this.connections;
    connMap.delete(conn.key());
  }

  /**
   * @returns {Promise<void>}
   */
  async open () {
    // If we've already got an active subscription, leave it be.
    if (this.pubsubRemover != null) { return; }
    this.pubsubRemover = pubsub.notifications.onAndGetRemovable(this.username, this.messageFromPubSub.bind(this));
  }

  /**
   * @returns {void}
   */
  messageFromPubSub (payload) {
    const message = pubsubMessageToSocket(payload);
    if (message != null) {
      this.socketNs.emit(message);
    } else {
      console.log('XXXXXXX Unknown payload', payload);
    }
  }

  // Closes down resources associated with this namespace context.
  //
  /**
   * @returns {Promise<void>}
   */
  async close () {
    if (this.pubsubRemover == null) { return; }
    this.pubsubRemover();
    this.pubsubRemover = null;
  }

  // ------------------------------------------------------------ event handlers
  // Called when a new socket connects to the namespace `socketNs`.
  //
  /**
   * @param {SocketIO$Socket} socket
   * @returns {void}
   */
  onConnect (socket) {
    const logger = this.logger;
    const namespaceName = socket.nsp.name;
    logger.info(`New client connected on namespace '${namespaceName}' (context ${this.socketNs.name})`);

    // This is attached to the socket by our initUsersNameSpaces.
    const methodContext = socket.methodContext;
    if (methodContext == null) {
      logger.warn('AF: onNsConnect received handshake w/o method context.');
      return;
    }
    this.addConnection(socket, methodContext);
  }

  // Called when the underlying socket-io socket disconnects.
  //
  /**
   * @param {Connection} conn
   * @returns {Promise<void>}
   */
  async onDisconnect (conn) {
    const logger = this.logger;
    const namespace = this.socketNs;
    // Remove the connection from our connection list.
    this.deleteConnection(conn);
    const remaining = this.connections.size;
    logger.info(`Namespace ${namespace.name}: socket disconnect (${remaining} conns remain).`);
    if (remaining > 0) { return; }
    // assert: We're the last connected socket in this namespace.
    logger.info(`Namespace ${namespace.name} closing down, cleaning up resources`);
    // Namespace doesn't have any connections left, stop notifying. We'll reopen
    // this when the next socket connects.
    await this.close();
  }
}

class Connection {
  socket;

  methodContext;

  api;

  logger;

  apiVersion;

  hostname;
  constructor (logger, socket, namespaceContext, methodContext, api, apiVersion, hostname) {
    this.socket = socket;
    this.methodContext = methodContext;
    this.api = api;
    this.logger = logger;
    this.apiVersion = apiVersion;
    this.hostname = hostname;
  }

  // This should be used as a key when storing the connection inside a Map.
  /**
   * @returns {string}
   */
  key () {
    return this.socket.id;
  }

  /**
   * @returns {void}
   */
  init () {
    this.socket.on('*', (callData, callback) => this.onMethodCall(callData, callback));
  }

  // ------------------------------------------------------------ event handlers
  // Called when the socket wants to call a Pryv IO method.
  //
  /**
   * @param {SocketIO$CallData} callData
   * @param {(err: unknown, res: any) => unknown} callback
   * @returns {Promise<unknown>}
   */
  async onMethodCall (callData, callback) {
    const methodContext = this.methodContext;
    methodContext.tracing = initRootSpan('socket.io', {
      apiVersion: this.apiVersion,
      hostname: this.hostname
    });
    const api = this.api;
    const logger = this.logger;
    if (!callData || !callData.data || callData.data.length !== 3) {
      if (callback) {
        callback(new Error('invalid data'));
      }
      return;
    }
    const apiMethod = callData.data[0];
    const params = callData.data[1];
    callback = callback || callData.data[2];
    // if (callback == null) callback = function (err: any, res: any) { }; // eslint-disable-line no-unused-vars
    methodContext.methodId = apiMethod;

    const userName = methodContext.user.username;
    // Accept streamQueries in JSON format for socket.io
    methodContext.acceptStreamsQueryNonStringified = true;
    try {
      const result = await bluebird.fromCallback((cb) => api.call(methodContext, params, cb));
      if (result == null) { throw new Error('AF: either err or result must be non-null'); }
      const obj = await bluebird.fromCallback((cb) => result.toObject(cb));
      // good ending
      methodContext.tracing.finishSpan('socket.io');
      // remove tracing for next call
      methodContext.tracing = null;
      return callback(null, commonMeta.setCommonMeta(obj));
    } catch (err) {
      errorHandling.logError(err, {
        url: `socketIO/${userName}`,
        method: apiMethod,
        body: params
      }, logger);
      // bad ending
      methodContext.tracing.setError('socket.io', err);
      methodContext.tracing.finishSpan('socket.io');
      return callback(commonMeta.setCommonMeta({
        error: errorHandling.getPublicErrorData(err)
      }));
    }
    // NOT REACHED
  }
}
const messageMap = {};
messageMap[pubsub.USERNAME_BASED_EVENTS_CHANGED] = 'eventsChanged';
messageMap[pubsub.USERNAME_BASED_ACCESSES_CHANGED] = 'accessesChanged';
messageMap[pubsub.USERNAME_BASED_STREAMS_CHANGED] = 'streamsChanged';
/**
 * @returns {any}
 */
function pubsubMessageToSocket (payload) {
  const key = typeof payload === 'object' ? JSON.stringify(payload) : payload;
  return messageMap[key];
}
module.exports = Manager;

/** @typedef {string} SocketIO$SocketId */

/**
 * @typedef {{
 *   methodContext: MethodContext;
 *   query: {
 *     resource: string;
 *     auth: string;
 *   };
 * }} SocketIO$Handshake
 */

/**
 * @typedef {{
 *   name: string;
 *   args: Array<unknown>;
 * }} SocketIO$CallData
 */

/**
 * @typedef {{
 *   id: SocketIO$SocketId;
 *   on(a: string, ...a: Array<unknown>): unknown;
 *   once(a: string, ...a: Array<unknown>): unknown;
 *   namespace: SocketIO$Namespace;
 * }} SocketIO$Socket
 */

/**
 * @typedef {{
 *   // Here's a bad interface.
 *   on(a: string, ...a: Array<unknown>): unknown;
 *   emit(a: string, ...a: Array<unknown>): void;
 *   name: string;
 *   sockets: {
 *     [socketId in SocketIO$SocketId]: SocketIO$Socket;
 *   };
 * }} SocketIO$Namespace
 */

/**
 * @typedef {{
 *   of: (a: string) => SocketIO$Namespace;
 *   handshaken: {
 *     [id in SocketIO$SocketId]: SocketIO$Handshake;
 *   };
 * }} SocketIO$Server
 */
