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
  | { t: 'sub'; scope: Scope; n?: number }
  | { t: 'subok'; scope: Scope; n?: number }
  | { t: 'unsub'; scope: Scope }
  | { t: 'pub'; scope: Scope; event: string; payload: Payload }
  | { t: 'msg'; scope: Scope; event: string; payload: Payload }
  | { t: 'ping' }
  | { t: 'pong' };
// A subscription is confirmed once the broker acknowledged it: from then on
// every message published to its scope is routed to this process. A message
// routed before that is not, so state built on the subscription (a cache fill)
// must wait for the confirmation.
type TransportSubscription = { unsubscribe (): void; isConfirmed (): boolean };

let testDeliverHook: DeliverHook | null = null;
// Told when the broker connection drops and when it is back (subscriptions
// re-sent): messages published in between are lost, so local state built on
// them (e.g. caches) must not be trusted across the gap.
type ConnectionState = 'disconnected' | 'reconnected';
const connectionStateListeners = new Set<(state: ConnectionState) => void>();
let client: TcpClient | null = null;
let broker: TcpBroker | null = null;
let initPromise: Promise<void> | null = null;

// Reconnection state. The broker is just whichever process won the listen race;
// when it exits (crash / redeploy / worker recycle) every client socket closes.
// Without a reconnect path a surviving worker goes permanently deaf and keeps
// serving stale cache (e.g. a revoked access), so we retry with capped backoff
// and re-run broker election on each attempt (the freed port lets a survivor
// take over as the new broker).
const MAX_OUTBOX = 10000;
const INITIAL_RECONNECT_DELAY_MS = 200;
const MAX_RECONNECT_DELAY_MS = 5000;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
let shuttingDown = false;

// Heartbeat. A broker whose event loop is stuck keeps its sockets open, so no
// `close` tells the clients that invalidations are no longer routed. Each client
// pings; a ping left unanswered past the deadline is reported as a disconnection
// (caches stop serving), the next answer as a reconnection (caches are flushed).
let heartbeatIntervalMs = 1000;
let heartbeatDeadlineMs = 5000;
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatLastTick = 0;
let pingSentAt: number | null = null;
let brokerStalled = false;

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
        const socket = this.clients.get(senderCid);
        if (socket != null) this._send(socket, { t: 'subok', scope, n: msg.n });
        break;
      }
      case 'ping': {
        const socket = this.clients.get(senderCid);
        if (socket != null) this._send(socket, { t: 'pong' });
        break;
      }
      case 'unsub':
        this._unsubscribe(msg.scope, senderCid);
        break;
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

  // An empty scope is removed: one is created per user ever followed.
  _unsubscribe (scope: Scope, cid: ClientId) {
    const subs = this.subscriptions.get(scope);
    if (subs == null) return;
    subs.delete(cid);
    if (subs.size === 0) this.subscriptions.delete(scope);
  }

  _removeClient (cid: ClientId) {
    this.clients.delete(cid);
    for (const [scope, subs] of this.subscriptions) {
      subs.delete(cid);
      if (subs.size === 0) this.subscriptions.delete(scope);
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
  // Scopes the current broker acknowledged (cleared when the connection drops).
  confirmedScopes: Set<Scope>;
  // scope -> number of its current subscription (client-wide, increasing): the
  // broker echoes it in `subok`, so an answer to an earlier one confirms nothing.
  subGenerations: Map<Scope, number>;
  nextSubSeq: number;
  // Publications made while disconnected, sent once the connection is back: a
  // bust published then must still reach the processes that cached its data.
  outbox: WireMessage[];
  _buffer: string;
  _welcomeResolve: ((value?: unknown) => void) | null;
  _onDisconnect: (() => void) | null;
  _intentionalClose: boolean;
  _outboxOverflowWarned = false;

  constructor (onDisconnect: (() => void) | null = null) {
    this.socket = null;
    this.cid = null;
    this.localSubs = new Map(); // scope → pubsub instance (survives reconnects → source of truth for re-subscribe)
    this.confirmedScopes = new Set();
    this.subGenerations = new Map();
    this.nextSubSeq = 1;
    this.outbox = [];
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
        this.confirmedScopes.clear();
        if (this._intentionalClose) return;
        if (this._onDisconnect != null) this._onDisconnect();
      });
    });
  }

  // Re-send a 'sub' for every scope we still hold — called after a reconnect so a
  // fresh broker learns our subscriptions again (localSubs persisted across the drop).
  resubscribe () {
    for (const scope of this.localSubs.keys()) {
      this.send({ t: 'sub', scope, n: this.subGenerations.get(scope) });
    }
  }

  // After resubscribe(): what was published during the gap goes out now.
  flushOutbox () {
    const pending = this.outbox;
    this.outbox = [];
    for (const msg of pending) this.send(msg);
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
      case 'subok':
        if (msg.n != null && this.subGenerations.get(msg.scope) === msg.n) this.confirmedScopes.add(msg.scope);
        break;
      case 'pong':
        onPong();
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
      return;
    }
    if (obj.t !== 'pub') return; // subscriptions are re-sent by resubscribe()
    if (this.outbox.length >= MAX_OUTBOX) {
      this.outbox.shift();
      if (!this._outboxOverflowWarned) {
        this._outboxOverflowWarned = true;
        logger.warn('pubsub: more than ' + MAX_OUTBOX + ' messages published while disconnected, the oldest are dropped (caches are flushed on reconnect; other processes keep theirs up to their max age)');
      }
    }
    this.outbox.push(obj);
  }

  close () {
    this._intentionalClose = true;
    this.cid = null;
    this.confirmedScopes.clear();
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
  _startHeartbeat();
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
  // A stall in progress ends with the connection: the reconnect reports the recovery.
  brokerStalled = false;
  pingSentAt = null;
  logger.error('pubsub broker connection lost — reconnecting (cache invalidations paused until restored)');
  _notifyConnectionState('disconnected');
  _scheduleReconnect();
}

function _startHeartbeat () {
  if (heartbeatTimer != null) return;
  heartbeatLastTick = Date.now();
  heartbeatTimer = setInterval(_heartbeatTick, heartbeatIntervalMs);
  heartbeatTimer.unref(); // must never keep the process alive
}

function _stopHeartbeat () {
  if (heartbeatTimer != null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  pingSentAt = null;
  brokerStalled = false;
}

function _heartbeatTick () {
  const now = Date.now();
  const lateMs = now - heartbeatLastTick - heartbeatIntervalMs;
  heartbeatLastTick = now;
  if (client == null || client.cid == null) { pingSentAt = null; return; }
  // This tick ran late: this process's own event loop was blocked, and the
  // broker's answer may be waiting unread. Measure again from now.
  if (lateMs > heartbeatDeadlineMs / 2) pingSentAt = null;
  if (pingSentAt == null) {
    pingSentAt = now;
    client.send({ t: 'ping' });
    return;
  }
  // Stalled: keep asking, so the first answer after recovery ends the stall.
  if (brokerStalled) { client.send({ t: 'ping' }); return; }
  if (now - pingSentAt > heartbeatDeadlineMs) {
    brokerStalled = true;
    logger.error('pubsub broker not answering for ' + (now - pingSentAt) + ' ms: cache invalidations treated as paused until it answers');
    _notifyConnectionState('disconnected');
  }
}

function onPong () {
  pingSentAt = null;
  if (!brokerStalled) return;
  brokerStalled = false;
  logger.info('pubsub broker answering again');
  _notifyConnectionState('reconnected');
}

function _notifyConnectionState (state: ConnectionState) {
  for (const listener of connectionStateListeners) {
    try {
      listener(state);
    } catch (err: unknown) {
      logger.warn('connection state listener failed', (err as Error).message);
    }
  }
}

function onConnectionStateChange (listener: (state: ConnectionState) => void): () => void {
  connectionStateListeners.add(listener);
  return () => { connectionStateListeners.delete(listener); };
}

function _scheduleReconnect () {
  if (shuttingDown || reconnectTimer != null) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    _reconnect();
  }, delay);
  reconnectTimer.unref(); // a pending reconnect must never keep the process alive
}

async function _reconnect () {
  if (shuttingDown || client == null) return;
  const port = await getPort();
  try {
    await _electBrokerAndConnect(port);
    client.resubscribe();
    client.flushOutbox();
    logger.info('pubsub reconnected, subscriptions restored');
    _notifyConnectionState('reconnected');
  } catch (err: unknown) {
    logger.warn('pubsub reconnect attempt failed', (err as Error).message);
    _scheduleReconnect(); // failed attempt's close handler usually re-schedules; belt-and-braces
  }
}

async function deliver (scopeName: Scope, eventName: string, payload: Payload) {
  await init();
  if (testDeliverHook != null) testDeliverHook(scopeName, eventName, payload);
  // Not the payload: a cache bust carries the token of an access that is still valid.
  logger.debug('deliver', scopeName, eventName);
  if (payload == null) payload = '';
  if (client == null) return;
  client.send({ t: 'pub', scope: scopeName, event: eventName, payload });
}

// This process is the broker and its client is connected to it.
function isOwnBroker (localClient: TcpClient): boolean {
  return broker != null && broker.server != null && localClient.cid != null && broker.clients.has(localClient.cid);
}

async function subscribe (scopeName: Scope, pubsub: LocalPubsub): Promise<TransportSubscription> {
  await init();
  logger.debug('subscribe', scopeName);
  if (client == null) return { unsubscribe () {}, isConfirmed: () => false };
  const localClient = client;
  // Only the latest subscription to a scope may confirm or end it: an earlier
  // one released late must not cancel its successor.
  const generation = localClient.nextSubSeq++;
  localClient.subGenerations.set(scopeName, generation);
  localClient.confirmedScopes.delete(scopeName); // confirmed again by this subscription's answer
  const isCurrent = () => localClient.subGenerations.get(scopeName) === generation;
  localClient.localSubs.set(scopeName, pubsub);
  if (isOwnBroker(localClient)) {
    // Same process, connected to it: register directly on the broker (no TCP
    // round-trip), which confirms the subscription at once.
    if (!broker!.subscriptions.has(scopeName)) broker!.subscriptions.set(scopeName, new Set());
    broker!.subscriptions.get(scopeName)!.add(localClient.cid!);
    localClient.confirmedScopes.add(scopeName);
  } else {
    localClient.send({ t: 'sub', scope: scopeName, n: generation });
  }
  return {
    isConfirmed: () => isCurrent() && localClient.confirmedScopes.has(scopeName),
    unsubscribe () {
      if (!isCurrent()) return;
      localClient.subGenerations.delete(scopeName);
      localClient.localSubs.delete(scopeName);
      localClient.confirmedScopes.delete(scopeName);
      if (isOwnBroker(localClient)) {
        broker!._unsubscribe(scopeName, localClient.cid!);
      } else {
        localClient.send({ t: 'unsub', scope: scopeName });
      }
    }
  };
}

type FlushOutcome = 'routed' | 'alone' | 'unreachable';
const FLUSH_POLL_MS = 10;

/**
 * Waits until the broker has routed everything this process published before
 * the call, for a short-lived process (a CLI) about to exit. The broker handles
 * one connection's messages in order, so its answer to a subscription sent after
 * them means they were routed. 'alone': this process is the broker and no other
 * process is connected (nobody to tell). 'unreachable': not connected to a
 * broker now (the connection is made when the process starts publishing or
 * subscribing, so it is not waited for), or no answer in time.
 */
async function flushPublished (timeoutMs: number): Promise<FlushOutcome> {
  const deadline = Date.now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([init(), expired]);
  clearTimeout(timer);
  // Publications whose own init() await is still pending go out first.
  await new Promise((resolve) => setImmediate(resolve));
  const localClient = client;
  if (localClient == null || localClient.cid == null) return 'unreachable';
  if (isOwnBroker(localClient) && broker!.clients.size <= 1) return 'alone';
  const generation = localClient.nextSubSeq++;
  const scope = 'flush.' + localClient.cid + '.' + generation;
  localClient.subGenerations.set(scope, generation);
  localClient.send({ t: 'sub', scope, n: generation });
  while (!localClient.confirmedScopes.has(scope) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, FLUSH_POLL_MS));
  }
  const routed = localClient.confirmedScopes.has(scope);
  localClient.subGenerations.delete(scope);
  localClient.confirmedScopes.delete(scope);
  localClient.send({ t: 'unsub', scope });
  return routed ? 'routed' : 'unreachable';
}

function setTestDeliverHook (deliverHook: DeliverHook | null) {
  testDeliverHook = deliverHook;
}

// Test-only: tear everything down (pending reconnect timer, client, broker) so a
// test can drive a fresh init against a controlled broker. Not used in production.
function _closeForTests () {
  shuttingDown = true;
  _stopHeartbeat();
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

// Test-only: replay a connection state change to the registered listeners.
function _emitConnectionStateForTests (state: ConnectionState): void {
  _notifyConnectionState(state);
}

// Test-only: shorter heartbeat timings (restarts the timer when it runs).
function _setHeartbeatForTests (intervalMs: number, deadlineMs: number): void {
  heartbeatIntervalMs = intervalMs;
  heartbeatDeadlineMs = deadlineMs;
  if (heartbeatTimer != null) { _stopHeartbeat(); _startHeartbeat(); }
}

export { init, deliver, subscribe, flushPublished, setTestDeliverHook, onConnectionStateChange, _closeForTests, _isConnectedForTests, _emitConnectionStateForTests, _setHeartbeatForTests };
export type { TransportSubscription, FlushOutcome };
