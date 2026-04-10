/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// TCP-based pub/sub broker + client — zero external deps.
// First process to call init() becomes the broker; others connect as clients.
// Protocol: newline-delimited JSON over TCP.

const net = require('node:net');
const { getConfig, getLogger } = require('@pryv/boiler');
const logger = getLogger('messages:pubsub:tcp');

let testDeliverHook = null;
let client = null;
let broker = null;
let initPromise = null;

// ──────────────────────────────────────────────────────────────────────
// TcpBroker — net.createServer, tracks clients + subscriptions
// ──────────────────────────────────────────────────────────────────────

class TcpBroker {
  constructor () {
    this.server = null;
    this.nextCid = 1;
    this.clients = new Map(); // cid → socket
    this.subscriptions = new Map(); // scope → Set<cid>
  }

  listen (port) {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._onConnection(socket));
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        this.server.unref(); // don't keep process alive
        logger.debug('broker listening on port', port);
        resolve();
      });
    });
  }

  _onConnection (socket) {
    const cid = 'c' + (this.nextCid++);
    this.clients.set(cid, socket);
    socket.unref(); // don't keep process alive
    logger.debug('client connected', cid);
    this._send(socket, { t: 'welcome', cid });

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          this._handleMessage(cid, JSON.parse(line));
        } catch (err) {
          logger.warn('bad message from', cid, err.message);
        }
      }
    });

    socket.on('error', () => this._removeClient(cid));
    socket.on('close', () => this._removeClient(cid));
  }

  _handleMessage (senderCid, msg) {
    switch (msg.t) {
      case 'sub': {
        const scope = msg.scope;
        if (!this.subscriptions.has(scope)) this.subscriptions.set(scope, new Set());
        this.subscriptions.get(scope).add(senderCid);
        break;
      }
      case 'unsub': {
        const scope = msg.scope;
        if (this.subscriptions.has(scope)) {
          this.subscriptions.get(scope).delete(senderCid);
        }
        break;
      }
      case 'pub': {
        this._route(senderCid, msg.scope, msg.event, msg.payload);
        break;
      }
    }
  }

  _route (senderCid, scope, event, payload) {
    const out = JSON.stringify({ t: 'msg', scope, event, payload }) + '\n';
    const subs = this.subscriptions.get(scope);
    if (subs) {
      for (const cid of subs) {
        if (cid === senderCid) continue; // noEcho
        const sock = this.clients.get(cid);
        if (sock && !sock.destroyed) sock.write(out);
      }
    }
  }

  _send (socket, obj) {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(obj) + '\n');
    }
  }

  _removeClient (cid) {
    this.clients.delete(cid);
    for (const subs of this.subscriptions.values()) {
      subs.delete(cid);
    }
  }

  close () {
    for (const socket of this.clients.values()) {
      socket.destroy();
    }
    this.clients.clear();
    this.subscriptions.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// TcpClient — net.createConnection, newline-delimited JSON
// ──────────────────────────────────────────────────────────────────────

class TcpClient {
  constructor () {
    this.socket = null;
    this.cid = null;
    this.localSubs = new Map(); // scope → pubsub instance
    this._buffer = '';
    this._welcomeResolve = null;
  }

  connect (port) {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
        this.socket.removeListener('error', reject);
        this.socket.unref(); // don't keep process alive
        // Wait for welcome message to get cid
        this._welcomeResolve = resolve;
      });
      this.socket.once('error', reject);
      this.socket.on('data', (chunk) => this._onData(chunk));
      this.socket.on('error', (err) => logger.warn('tcp client error', err.message));
    });
  }

  _onData (chunk) {
    this._buffer += chunk.toString();
    let nl;
    while ((nl = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, nl);
      this._buffer = this._buffer.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        this._handleMessage(JSON.parse(line));
      } catch (err) {
        logger.warn('bad message from broker', err.message);
      }
    }
  }

  _handleMessage (msg) {
    switch (msg.t) {
      case 'welcome':
        this.cid = msg.cid;
        if (this._welcomeResolve) {
          this._welcomeResolve();
          this._welcomeResolve = null;
        }
        break;
      case 'msg': {
        const pubsub = this.localSubs.get(msg.scope);
        if (pubsub) {
          logger.debug('received', msg.scope, msg.event);
          pubsub._emit(msg.event, msg.payload);
        }
        break;
      }
    }
  }

  send (obj) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify(obj) + '\n');
    }
  }

  close () {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Exported API
// ──────────────────────────────────────────────────────────────────────

async function getPort () {
  const config = await getConfig();
  if (config.has('tcpBroker:port')) return config.get('tcpBroker:port');
  return 4222; // default
}

async function init () {
  if (client != null) return;
  if (initPromise != null) return initPromise;
  initPromise = _doInit();
  return initPromise;
}

async function _doInit () {
  const port = await getPort();
  // Try to become the broker first
  try {
    broker = new TcpBroker();
    await broker.listen(port);
    logger.debug('acting as broker on port', port);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      broker = null;
      logger.debug('port in use, connecting as client only');
    } else {
      broker = null;
      logger.warn('broker listen failed', err.message);
    }
  }

  // Connect as client
  try {
    client = new TcpClient();
    await client.connect(port);
    logger.debug('connected as client, cid=', client.cid);
  } catch (err) {
    client = null;
    logger.warn('tcp connect failed, local-only mode', err.message);
  }
}

async function deliver (scopeName, eventName, payload) {
  await init();
  if (testDeliverHook != null) testDeliverHook(scopeName, eventName, payload);
  logger.debug('deliver', scopeName, eventName, payload);
  if (payload == null) payload = '';
  if (client == null) return;
  client.send({ t: 'pub', scope: scopeName, event: eventName, payload });
}

async function subscribe (scopeName, pubsub) {
  await init();
  logger.debug('subscribe', scopeName);
  if (client == null) return { unsubscribe () {} };
  client.localSubs.set(scopeName, pubsub);
  if (broker != null) {
    // Same process — register directly on broker (no TCP round-trip)
    if (!broker.subscriptions.has(scopeName)) broker.subscriptions.set(scopeName, new Set());
    broker.subscriptions.get(scopeName).add(client.cid);
  } else {
    client.send({ t: 'sub', scope: scopeName });
  }
  return {
    unsubscribe () {
      client.localSubs.delete(scopeName);
      if (broker != null) {
        if (broker.subscriptions.has(scopeName)) {
          broker.subscriptions.get(scopeName).delete(client.cid);
        }
      } else {
        client.send({ t: 'unsub', scope: scopeName });
      }
    }
  };
}

function setTestDeliverHook (deliverHook) {
  testDeliverHook = deliverHook;
}

module.exports = {
  init,
  deliver,
  subscribe,
  setTestDeliverHook
};
