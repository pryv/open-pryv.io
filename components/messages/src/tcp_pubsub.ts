/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


// TCP-based pub/sub broker + client — zero external deps.
// First process to call init() becomes the broker; others connect as clients.
// Protocol: newline-delimited JSON over TCP.

import type { Socket, Server } from 'node:net';
import net from 'node:net';
import { getConfig, getLogger } from '@pryv/boiler';
const logger = getLogger('messages:pubsub:tcp');

type ClientId = string;
type Scope = string;
type Payload = unknown;
type DeliverHook = (scope: Scope, event: string, payload: Payload) => void;
type LocalPubsub = { _emit (event: string, payload: Payload): void };
type WireMessage =
  | { t: 'welcome'; cid: ClientId }
  | { t: 'sub'; scope: Scope }
  | { t: 'unsub'; scope: Scope }
  | { t: 'pub'; scope: Scope; event: string; payload: Payload }
  | { t: 'msg'; scope: Scope; event: string; payload: Payload };

let testDeliverHook: DeliverHook | null = null;
let client: TcpClient | null = null;
let broker: TcpBroker | null = null;
let initPromise: Promise<void> | null = null;

// ──────────────────────────────────────────────────────────────────────
// TcpBroker — net.createServer, tracks clients + subscriptions
// ──────────────────────────────────────────────────────────────────────

class TcpBroker {
  server: Server | null;
  nextCid: number;
  clients: Map<ClientId, Socket>;
  subscriptions: Map<Scope, Set<ClientId>>;

  constructor () {
    this.server = null;
    this.nextCid = 1;
    this.clients = new Map(); // cid → socket
    this.subscriptions = new Map(); // scope → Set<cid>
  }

  listen (port: number) {
    return new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket: Socket) => this._onConnection(socket));
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => {
        this.server!.removeListener('error', reject);
        this.server!.unref(); // don't keep process alive
        logger.debug('broker listening on port', port);
        resolve();
      });
    });
  }

  _onConnection (socket: Socket) {
    const cid: ClientId = 'c' + (this.nextCid++);
    this.clients.set(cid, socket);
    socket.unref(); // don't keep process alive
    logger.debug('client connected', cid);
    this._send(socket, { t: 'welcome', cid });

    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          this._handleMessage(cid, JSON.parse(line));
        } catch (err: unknown) {
          logger.warn('bad message from', cid, (err as Error).message);
        }
      }
    });

    socket.on('error', () => this._removeClient(cid));
    socket.on('close', () => this._removeClient(cid));
  }

  _handleMessage (senderCid: ClientId, msg: WireMessage) {
    switch (msg.t) {
      case 'sub': {
        const scope = msg.scope;
        if (!this.subscriptions.has(scope)) this.subscriptions.set(scope, new Set());
        this.subscriptions.get(scope)!.add(senderCid);
        break;
      }
      case 'unsub': {
        const scope = msg.scope;
        if (this.subscriptions.has(scope)) {
          this.subscriptions.get(scope)!.delete(senderCid);
        }
        break;
      }
      case 'pub': {
        this._route(senderCid, msg.scope, msg.event, msg.payload);
        break;
      }
    }
  }

  _route (senderCid: ClientId, scope: Scope, event: string, payload: Payload) {
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

  _send (socket: Socket, obj: WireMessage) {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(obj) + '\n');
    }
  }

  _removeClient (cid: ClientId) {
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
  socket: Socket | null;
  cid: ClientId | null;
  localSubs: Map<Scope, LocalPubsub>;
  _buffer: string;
  _welcomeResolve: ((value?: unknown) => void) | null;

  constructor () {
    this.socket = null;
    this.cid = null;
    this.localSubs = new Map(); // scope → pubsub instance
    this._buffer = '';
    this._welcomeResolve = null;
  }

  connect (port: number) {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
        this.socket!.removeListener('error', reject);
        this.socket!.unref(); // don't keep process alive
        // Wait for welcome message to get cid
        this._welcomeResolve = resolve;
      });
      this.socket!.once('error', reject);
      this.socket!.on('data', (chunk: Buffer) => this._onData(chunk));
      this.socket!.on('error', (err: Error) => logger.warn('tcp client error', err.message));
    });
  }

  _onData (chunk: Buffer) {
    this._buffer += chunk.toString();
    let nl;
    while ((nl = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, nl);
      this._buffer = this._buffer.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        this._handleMessage(JSON.parse(line));
      } catch (err: unknown) {
        logger.warn('bad message from broker', (err as Error).message);
      }
    }
  }

  _handleMessage (msg: WireMessage) {
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

  send (obj: WireMessage) {
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

async function getPort (): Promise<number> {
  const config = await getConfig();
  if (config.has('tcpBroker:port')) return config.get('tcpBroker:port') as number;
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
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      broker = null;
      logger.debug('port in use, connecting as client only');
    } else {
      broker = null;
      logger.warn('broker listen failed', (err as Error).message);
    }
  }

  // Connect as client
  try {
    client = new TcpClient();
    await client.connect(port);
    logger.debug('connected as client, cid=', client.cid);
  } catch (err: unknown) {
    client = null;
    logger.warn('tcp connect failed, local-only mode', (err as Error).message);
  }
}

async function deliver (scopeName: Scope, eventName: string, payload: Payload) {
  await init();
  if (testDeliverHook != null) testDeliverHook(scopeName, eventName, payload);
  logger.debug('deliver', scopeName, eventName, payload);
  if (payload == null) payload = '';
  if (client == null) return;
  client.send({ t: 'pub', scope: scopeName, event: eventName, payload });
}

async function subscribe (scopeName: Scope, pubsub: LocalPubsub) {
  await init();
  logger.debug('subscribe', scopeName);
  if (client == null) return { unsubscribe () {} };
  const localClient = client;
  localClient.localSubs.set(scopeName, pubsub);
  if (broker != null) {
    // Same process — register directly on broker (no TCP round-trip)
    if (!broker.subscriptions.has(scopeName)) broker.subscriptions.set(scopeName, new Set());
    broker.subscriptions.get(scopeName)!.add(localClient.cid!);
  } else {
    localClient.send({ t: 'sub', scope: scopeName });
  }
  return {
    unsubscribe () {
      localClient.localSubs.delete(scopeName);
      if (broker != null) {
        if (broker.subscriptions.has(scopeName)) {
          broker.subscriptions.get(scopeName)!.delete(localClient.cid!);
        }
      } else {
        localClient.send({ t: 'unsub', scope: scopeName });
      }
    }
  };
}

function setTestDeliverHook (deliverHook: DeliverHook | null) {
  testDeliverHook = deliverHook;
}

export { init, deliver, subscribe, setTestDeliverHook };
