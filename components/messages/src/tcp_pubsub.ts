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

// Reconnection state. The broker is just whichever process won the listen race;
// when it exits (crash / redeploy / worker recycle) every client socket closes.
// Without a reconnect path a surviving worker goes permanently deaf and keeps
// serving stale cache (e.g. a revoked access), so we retry with capped backoff
// and re-run broker election on each attempt (the freed port lets a survivor
// take over as the new broker).
const INITIAL_RECONNECT_DELAY_MS = 200;
const MAX_RECONNECT_DELAY_MS = 5000;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
let shuttingDown = false;

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
  _onDisconnect: (() => void) | null;
  _intentionalClose: boolean;

  constructor (onDisconnect: (() => void) | null = null) {
    this.socket = null;
    this.cid = null;
    this.localSubs = new Map(); // scope → pubsub instance (survives reconnects → source of truth for re-subscribe)
    this._buffer = '';
    this._welcomeResolve = null;
    this._onDisconnect = onDisconnect;
    this._intentionalClose = false;
  }

  connect (port: number) {
    return new Promise((resolve, reject) => {
      this._buffer = '';
      this._intentionalClose = false;
      const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
        socket.removeListener('error', reject);
        socket.unref(); // don't keep process alive
        // Wait for welcome message to get cid
        this._welcomeResolve = resolve;
      });
      this.socket = socket;
      socket.once('error', reject);
      socket.on('data', (chunk: Buffer) => this._onData(chunk));
      socket.on('error', (err: Error) => logger.warn('tcp client error', err.message));
      // Unexpected socket close (broker gone, or a failed (re)connect attempt) →
      // let the module schedule a reconnect. Skipped on close() (intentional teardown).
      socket.on('close', () => {
        this.cid = null;
        if (this._intentionalClose) return;
        if (this._onDisconnect != null) this._onDisconnect();
      });
    });
  }

  // Re-send a 'sub' for every scope we still hold — called after a reconnect so a
  // fresh broker learns our subscriptions again (localSubs persisted across the drop).
  resubscribe () {
    for (const scope of this.localSubs.keys()) {
      this.send({ t: 'sub', scope });
    }
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
    this._intentionalClose = true;
    this.cid = null;
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
  // `client` is set for the process lifetime after the first _doInit (even while a
  // reconnect is in flight), so this short-circuit no longer strands a resolved
  // initPromise on a failed startup connect — the client self-heals in background.
  if (client != null) return;
  if (initPromise != null) return initPromise;
  initPromise = _doInit();
  return initPromise;
}

// Elect a broker (idempotent — only listens if we aren't already a live broker),
// then (re)connect the client. Shared by first init and every reconnect attempt,
// so a survivor can take over the freed port when the elected broker dies.
async function _electBrokerAndConnect (port: number): Promise<void> {
  if (broker == null || broker.server == null) {
    try {
      broker = new TcpBroker();
      await broker.listen(port);
      logger.debug('acting as broker on port', port);
    } catch (err: unknown) {
      broker = null;
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        logger.debug('port in use, connecting as client only');
      } else {
        logger.warn('broker listen failed', (err as Error).message);
      }
    }
  }
  await client!.connect(port);
  reconnectDelay = INITIAL_RECONNECT_DELAY_MS; // reset backoff on a successful connect
}

async function _doInit () {
  const port = await getPort();
  // Keep the same client instance for the process lifetime so localSubs (and thus
  // re-subscription state) survive broker loss and reconnects.
  client = new TcpClient(onClientDisconnected);
  try {
    await _electBrokerAndConnect(port);
    logger.debug('connected as client, cid=', client.cid);
  } catch (err: unknown) {
    // Lost the startup race (broker not yet listening). The socket's close handler
    // has already scheduled a reconnect; stay non-null so we keep retrying.
    logger.warn('tcp connect failed, retrying in background', (err as Error).message);
  }
}

function onClientDisconnected () {
  if (shuttingDown) return;
  logger.error('pubsub broker connection lost — reconnecting (cache invalidations paused until restored)');
  _scheduleReconnect();
}

function _scheduleReconnect () {
  if (shuttingDown || reconnectTimer != null) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void _reconnect();
  }, delay);
  reconnectTimer.unref(); // a pending reconnect must never keep the process alive
}

async function _reconnect () {
  if (shuttingDown || client == null) return;
  const port = await getPort();
  try {
    await _electBrokerAndConnect(port);
    client.resubscribe();
    logger.info('pubsub reconnected, subscriptions restored');
  } catch (err: unknown) {
    logger.warn('pubsub reconnect attempt failed', (err as Error).message);
    _scheduleReconnect(); // failed attempt's close handler usually re-schedules; belt-and-braces
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

// Test-only: tear everything down (pending reconnect timer, client, broker) so a
// test can drive a fresh init against a controlled broker. Not used in production.
function _closeForTests () {
  shuttingDown = true;
  if (reconnectTimer != null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (client != null) { client.close(); client = null; }
  if (broker != null) { broker.close(); broker = null; }
  initPromise = null;
  reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  shuttingDown = false;
}

// Test-only: true once the client holds a live broker connection (welcome received).
function _isConnectedForTests (): boolean {
  return client != null && client.cid != null;
}

export { init, deliver, subscribe, setTestDeliverHook, _closeForTests, _isConnectedForTests };
