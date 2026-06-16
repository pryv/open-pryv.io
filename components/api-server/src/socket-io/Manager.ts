/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
import type { MethodContext, CustomAuthFunction } from 'business/src/MethodContext.ts';
import type { EventMatchQuery } from 'utils';
import type { RawScopeQuery } from '../methods/helpers/scopeQueryUtils.ts';
import type { Subscriber } from 'business/src/notifications/NotificationEngine.ts';
const require = createRequire(import.meta.url);
const errorHandling = require('errors').errorHandling;
const errors = require('errors').factory;
const commonMeta = require('../methods/helpers/setCommonMeta.ts');
const { fromCallback } = require('utils');
const { USERNAME_REGEXP_STR } = require('../schema/helpers.ts');
const { pubsub } = require('messages');
const notificationEngine = require('business').notificationEngine;
const { prepareScopeQuery } = require('../methods/helpers/scopeQueryUtils.ts');
// socket messages reserved for the scoped-subscription protocol — handled
// inline instead of being dispatched to the API as method calls (the wildcard
// '*' handler would otherwise treat them as unknown methods).
const SUBSCRIPTION_OPS = new Set(['subscribe', 'unsubscribe', 'getSubscriptions']);
(async () => {
  await commonMeta.loadSettings();
})();
const { getAPIVersion } = require('middleware/src/project_version.ts');
const { initRootSpan } = require('tracing');
// Manages contexts for socket-io. NamespaceContext's are created when the first
// client connects to a namespace and are then kept forever.
//

class Manager {
  contexts: Map<string | null, NamespaceContext>;

  logger: Logger;

  io: SocketServer;

  api: Api;

  storageLayer: unknown;

  customAuthStepFn: CustomAuthFunction | null;

  apiVersion: string | null;

  hostname: string;
  constructor (logger: Logger, io: SocketServer, api: Api, storageLayer: unknown, customAuthStepFn: CustomAuthFunction | null) {
    this.logger = logger;
    this.io = io;
    this.api = api;
    this.contexts = new Map();
    this.storageLayer = storageLayer;
    this.customAuthStepFn = customAuthStepFn;
    this.apiVersion = null;
    this.hostname = require('os').hostname();
  }

  // Returns true if the `candidate` could be a username on a lexical level.
  //
  looksLikeUsername (candidate: string): boolean {
    const reUsername = new RegExp(USERNAME_REGEXP_STR);
    const lowercasedUsername = candidate.toLowerCase(); // for retro-compatibility
    return reUsername.test(lowercasedUsername);
  }

  // Extracts the username from the given valid namespace name.
  // Returns null if the given `namespaceName` cannot be parsed as a user name.
  //
  //    manager.getUsername('/foobar') // => 'foobar'
  //
  extractUsername (namespaceName: string): string | null {
    const ns = cleanNS(namespaceName);
    if (!ns.startsWith('/')) { return null; }
    // assert: namespaceName[0] === '/'
    const candidate = ns.slice(1);
    if (!this.looksLikeUsername(candidate)) { return null; }
    return candidate;
    /**
     * Takes the last field of the NS path
     *
     */
    function cleanNS (namespace: string): string {
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

  async ensureInitNamespace (namespaceName: string): Promise<NamespaceContext> {
    await initAsyncProps.call(this);
    const username = this.extractUsername(namespaceName);
    let context = this.contexts.get(username);
    // Value is not missing, return it.
    if (typeof context === 'undefined') {
      context = new NamespaceContext(username, this.io.of(namespaceName), this.api, this.logger, this.apiVersion, this.hostname, this.storageLayer);
      this.contexts.set(username, context);
    }
    await context.open();
    return context;
    /**
     * putting this here because putting it above requires rendering too much code async. I'm sorry.
     */
    async function initAsyncProps (this: Manager) {
      if (this.apiVersion == null) { this.apiVersion = await getAPIVersion(); }
    }
  }
}

class NamespaceContext {
  username: string | null;

  socketNs: SocketNamespace;

  api: Api;

  logger: Logger;

  apiVersion: string | null;

  hostname: string;

  connections: Map<string, Connection>;

  pubsubRemover: PubsubRemover | null;

  storageLayer: unknown;
  constructor (username: string | null, socketNs: SocketNamespace, api: Api, logger: Logger, apiVersion: string | null, hostname: string, storageLayer: unknown) {
    this.username = username;
    this.socketNs = socketNs;
    this.api = api;
    this.logger = logger;
    this.connections = new Map();
    this.pubsubRemover = null;
    this.apiVersion = apiVersion;
    this.hostname = hostname;
    this.storageLayer = storageLayer;
  }

  // D10: an access change (narrow / revoke / delete) may invalidate live
  // connections. Re-validate each: a revoked/deleted token drops the socket; a
  // narrowed token has its now-forbidden scopes pruned.
  revalidateConnections (): void {
    for (const conn of this.connections.values()) {
      conn.revalidate(this.storageLayer).catch((err: unknown) => this.logger.warn('scoped-notification revalidate failed', err));
    }
  }

  // Adds a connection to the namespace. This produces a `Connection` instance
  // and stores it in (our) namespace.
  //
  addConnection (socket: SocketLike, _methodContext?: MethodContext) {
    // This will represent state that we keep for every connection.
    const connection = new Connection(this.logger, socket, this, socket.methodContext, this.api, this.apiVersion, this.hostname, this.storageLayer);
    // Permanently store the connection in this namespace.
    this.storeConnection(connection);
    socket.once('disconnect', () => this.onDisconnect(connection));
    connection.init();
  }

  storeConnection (conn: Connection) {
    const connMap = this.connections;
    connMap.set(conn.key(), conn);
  }

  deleteConnection (conn: Connection) {
    const connMap = this.connections;
    connMap.delete(conn.key());
  }

  async open () {
    // If we've already got an active subscription, leave it be.
    if (this.pubsubRemover != null) { return; }
    this.pubsubRemover = pubsub.notifications.onAndGetRemovable(this.username, this.messageFromPubSub.bind(this));
  }

  messageFromPubSub (payload: PubsubPayload) {
    // Structured payloads carry both an event type and data fields —
    // forward the entire payload alongside the socket event name.
    // Legacy string payloads stay arg-less for back-compat with
    // existing SDK consumers (eventsChanged / accessesChanged /
    // streamsChanged listeners called without args today).
    if (payload != null && typeof payload === 'object' && typeof payload.type === 'string') {
      const message = messageMap[payload.type];
      if (message != null) {
        this.socketNs.emit(message, payload);
        if (message === 'accessUpdated') this.revalidateConnections(); // D10
      } else {
        console.log('XXXXXXX Unknown structured payload', payload);
      }
      return;
    }
    const message = pubsubMessageToSocket(payload);
    if (message != null) {
      this.emitCoarse(message);
      if (message === 'accessesChanged') this.revalidateConnections(); // D10
    } else {
      console.log('XXXXXXX Unknown payload', payload);
    }
  }

  // Emit a legacy coarse signal (eventsChanged / streamsChanged / accessesChanged).
  // Connections that registered at least one scope opt out of the broadcast —
  // they receive the unified `notificationsChanged` from the engine instead, so
  // they never double-fire. When no connection is scoped, the fast namespace
  // broadcast is used unchanged.
  emitCoarse (message: string) {
    let hasScoped = false;
    for (const conn of this.connections.values()) {
      if (conn.hasScopes()) { hasScoped = true; break; }
    }
    if (!hasScoped) {
      this.socketNs.emit(message);
      return;
    }
    for (const conn of this.connections.values()) {
      if (!conn.hasScopes()) conn.socket.emit(message);
    }
  }

  // Closes down resources associated with this namespace context.
  //
  async close () {
    if (this.pubsubRemover == null) { return; }
    this.pubsubRemover();
    this.pubsubRemover = null;
  }

  // ------------------------------------------------------------ event handlers
  // Called when a new socket connects to the namespace `socketNs`.
  //
  onConnect (socket: SocketLike) {
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
  async onDisconnect (conn: Connection) {
    const logger = this.logger;
    const namespace = this.socketNs;
    // Tear down any scoped-notification subscriptions this connection held.
    conn.teardownScopes();
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
  socket: SocketLike;

  methodContext: MethodContext;

  api: Api;

  logger: Logger;

  apiVersion: string | null;

  hostname: string;

  // Scoped-notification subscriptions held by this connection (key -> scope).
  scopes: Map<string, { kind: string; rawQuery: RawScopeQuery; prepared: EventMatchQuery }>;

  subscriber: Subscriber | null;

  storageLayer: unknown;
  constructor (logger: Logger, socket: SocketLike, namespaceContext: NamespaceContext, methodContext: MethodContext, api: Api, apiVersion: string | null, hostname: string, storageLayer: unknown) {
    this.socket = socket;
    this.methodContext = methodContext;
    this.api = api;
    this.logger = logger;
    this.apiVersion = apiVersion;
    this.hostname = hostname;
    this.scopes = new Map();
    this.subscriber = null;
    this.storageLayer = storageLayer;
  }

  hasScopes (): boolean {
    return this.scopes.size > 0;
  }

  // D10: re-resolve this connection's access after an access change. A
  // revoked/deleted token can no longer be resolved -> drop the connection
  // (also closing the general "revoked token keeps working on an open socket"
  // hole). A surviving-but-narrowed token has its now-forbidden scopes pruned.
  async revalidate (storageLayer: unknown): Promise<void> {
    this.methodContext.access = null; // force a fresh read (the getter caches)
    try {
      await this.methodContext.retrieveExpandedAccess(storageLayer as Parameters<MethodContext['retrieveExpandedAccess']>[0]);
    } catch (err) {
      this.teardownScopes();
      this.socket.disconnect();
      return;
    }
    if (this.scopes.size === 0) return;
    for (const [key, s] of [...this.scopes]) {
      try {
        s.prepared = await prepareScopeQuery(this.methodContext, s.rawQuery);
      } catch (err) {
        this.scopes.delete(key); // scope now out of permission -> drop it
      }
    }
    this.syncSubscriber();
  }

  // Unregister from the engine and drop all scopes (on disconnect or last unsubscribe).
  teardownScopes (): void {
    if (this.subscriber != null) {
      notificationEngine.unregister(this.methodContext.user.username, this.subscriber);
      this.subscriber = null;
    }
    this.scopes.clear();
  }

  // Register with the engine (once) and keep its scope array in sync.
  private syncSubscriber (): void {
    if (this.scopes.size === 0) {
      this.teardownScopes();
      return;
    }
    if (this.subscriber == null) {
      this.subscriber = {
        id: this.socket.id,
        scopes: [],
        deliver: (keys: string[]) => this.socket.emit('notificationsChanged', { keys })
      };
      notificationEngine.register(this.methodContext.user.username, this.subscriber);
    }
    this.subscriber.scopes = [...this.scopes.entries()].map(([key, s]) => ({ key, kind: s.kind as 'events' | 'streams' | 'accesses', query: s.prepared }));
  }

  // Dispatch a scoped-subscription protocol message.
  async onSubscriptionOp (op: string, payload: unknown, callback: SocketCallback): Promise<void> {
    try {
      if (op === 'getSubscriptions') {
        return callback(null, { scopes: this.scopesForDisplay() });
      }
      if (op === 'unsubscribe') {
        this.removeScopes(payload);
        return callback(null, { ok: true, keys: [...this.scopes.keys()] });
      }
      await this.addScopes(payload); // op === 'subscribe'
      return callback(null, { ok: true, keys: [...this.scopes.keys()] });
    } catch (err) {
      return callback(commonMeta.setCommonMeta({ error: errorHandling.getPublicErrorData(err) }));
    }
  }

  private scopesForDisplay (): Record<string, { kind: string; query: RawScopeQuery }> {
    const out: Record<string, { kind: string; query: RawScopeQuery }> = {};
    for (const [key, s] of this.scopes) out[key] = { kind: s.kind, query: s.rawQuery };
    return out;
  }

  private removeScopes (payload: unknown): void {
    const p = (payload ?? {}) as { key?: string; keys?: string[]; all?: boolean };
    if (p.all === true) this.scopes.clear();
    else if (Array.isArray(p.keys)) for (const k of p.keys) this.scopes.delete(k);
    else if (p.key != null) this.scopes.delete(p.key);
    this.syncSubscriber();
  }

  private async addScopes (payload: unknown): Promise<void> {
    for (const { key, kind, query } of normalizeScopePayload(payload)) {
      if (kind !== 'events' && kind !== 'streams') {
        throw errors.invalidRequestStructure(`scope kind '${kind}' is not yet supported`);
      }
      const prepared = await prepareScopeQuery(this.methodContext, query);
      this.scopes.set(key, { kind, rawQuery: query, prepared });
    }
    this.syncSubscriber();
  }

  // This should be used as a key when storing the connection inside a Map.
  key (): string {
    return this.socket.id;
  }

  init () {
    this.socket.on('*', (callData: unknown, callback: unknown) => this.onMethodCall(callData as CallData, callback as SocketCallback));
  }

  // ------------------------------------------------------------ event handlers
  // Called when the socket wants to call a Pryv IO method.
  //
  async onMethodCall (callData: CallData, callback: SocketCallback) {
    if (!callData || !callData.data || callData.data.length !== 3) {
      if (callback) {
        callback(new Error('invalid data'));
      }
      return;
    }
    const apiMethod = callData.data[0];
    const params = callData.data[1];
    callback = callback || callData.data[2];
    // Scoped-subscription protocol messages are handled inline, not dispatched
    // to the API (the wildcard '*' handler catches every emitted event).
    if (SUBSCRIPTION_OPS.has(apiMethod)) {
      return this.onSubscriptionOp(apiMethod, params, callback);
    }
    const methodContext = this.methodContext;
    const tracing = initRootSpan('socket.io', {
      apiVersion: this.apiVersion,
      hostname: this.hostname
    }) as { finishSpan: (n: string) => void; setError: (n: string, err: unknown) => void };
    methodContext.tracing = tracing;
    const api = this.api;
    const logger = this.logger;
    methodContext.methodId = apiMethod;

    const userName = methodContext.user.username;
    // Accept streamQueries in JSON format for socket.io
    methodContext.acceptStreamsQueryNonStringified = true;
    try {
      const result = await fromCallback((cb: NodeCallback) => api.call(methodContext, params, cb));
      if (result == null) { throw new Error('AF: either err or result must be non-null'); }
      const obj = await fromCallback((cb: NodeCallback) => result.toObject(cb));
      // good ending
      tracing.finishSpan('socket.io');
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
      tracing.setError('socket.io', err);
      tracing.finishSpan('socket.io');
      return callback(commonMeta.setCommonMeta({
        error: errorHandling.getPublicErrorData(err)
      }));
    }
    // NOT REACHED
  }
}
const messageMap: Record<string, string> = {};
messageMap[pubsub.USERNAME_BASED_EVENTS_CHANGED] = 'eventsChanged';
messageMap[pubsub.USERNAME_BASED_ACCESSES_CHANGED] = 'accessesChanged';
messageMap[pubsub.USERNAME_BASED_STREAMS_CHANGED] = 'streamsChanged';
messageMap[pubsub.ACCESS_UPDATED] = 'accessUpdated';
function pubsubMessageToSocket (payload: unknown): string | undefined {
  const key = typeof payload === 'object' ? JSON.stringify(payload) : (payload as string);
  return messageMap[key];
}

// Normalize the client `subscribe` payload into a flat list of scope specs.
// Accepts a single `{ key, kind?, query }` or a bulk `{ scopes: { key -> { kind?, query } } }`.
function normalizeScopePayload (payload: unknown): Array<{ key: string; kind: string; query: RawScopeQuery }> {
  const p = (payload ?? {}) as { key?: string; kind?: string; query?: RawScopeQuery; scopes?: Record<string, { kind?: string; query?: RawScopeQuery }> };
  if (p.scopes != null && typeof p.scopes === 'object') {
    return Object.entries(p.scopes).map(([key, v]) => ({ key, kind: v.kind ?? 'events', query: v.query ?? {} }));
  }
  if (p.key != null) {
    return [{ key: p.key, kind: p.kind ?? 'events', query: p.query ?? {} }];
  }
  throw errors.invalidRequestStructure('subscribe requires { key, query } or { scopes: { key: { query } } }');
}
export default Manager;
export { Manager };

// Local types for the socket-io plumbing this module wraps. Kept minimal —
// only the surface area Manager / NamespaceContext / Connection actually use.
type SocketNamespace = {
  name: string;
  emit (event: string, ...args: unknown[]): void;
};
type SocketServer = {
  of (namespacePattern: string): SocketNamespace;
};
type SocketLike = {
  id: string;
  nsp: { name: string };
  methodContext: MethodContext;
  on (event: string, listener: (...args: unknown[]) => unknown): unknown;
  once (event: string, listener: (...args: unknown[]) => unknown): unknown;
  emit (event: string, ...args: unknown[]): unknown;
  disconnect (): unknown;
};
type Api = {
  call (context: MethodContext, params: unknown, cb: (err: Error | null, result?: unknown) => void): void;
};
type NodeCallback<T = unknown> = (err: Error | null | undefined, value?: T) => void;
type SocketCallback = (err: Error | null | undefined, result?: unknown) => void;
type CallData = { data: [string, unknown, SocketCallback?] };
type PubsubPayload = { type?: string; [key: string]: unknown } | string | null;
type PubsubRemover = () => void;
