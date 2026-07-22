/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { HttpHeaders } from 'business/src/types/public.ts';
import type { Server as HttpServer } from 'node:http';
import type { CustomAuthFunction } from 'business/src/MethodContext.ts';
const require = createRequire(import.meta.url);
/**
 * Note: Debug tests with: DEBUG=engine,socket.io* npm test --grep="Socket"
 */
const cluster = require('node:cluster');
const socketIO = require('socket.io')({
  cors: {
    origin: true,
    methods: 'GET,POST',
    credentials: true
  },
  allowEIO3: true, // for compatibility with v2 clients
  // Force WebSocket transport when running in cluster mode.
  // HTTP long-polling breaks with cluster round-robin scheduling because
  // successive requests land on different workers that don't share session state.
  // WebSocket connections are long-lived and stay on the same worker.
  ...(cluster.isWorker ? { transports: ['websocket'] } : {})
});
const MethodContext = require('business').MethodContext;
const Manager = require('./Manager.ts').default;
const Paths = require('../routes/Paths.ts');
const { getLogger } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');
type SocketLike = {
  nsp: { name: string };
  handshake: {
    query: Record<string, string | undefined>;
    headers: HttpHeaders;
  };
  request: { connection: { remoteAddress?: string } };
  methodContext?: unknown;
};
// Initializes the SocketIO subsystem.
//
async function setupSocketIO (server: HttpServer, api: { call: (...args: unknown[]) => unknown }, customAuthStepFn: CustomAuthFunction) {
  const logger = getLogger('socketIO');
  const storageLayer = await getStorageLayer();
  const io = socketIO.listen(server, {
    path: Paths.SocketIO
  });
    // Manages socket.io connections and delivers method calls to the api.
  const manager = new Manager(logger, io, api, storageLayer, customAuthStepFn);

  // Operator client-revoke reaches ALREADY-OPEN sockets. A socket authenticates
  // once at handshake and then dispatches messages without re-auth, so the
  // per-request revoke check never fires for it. This per-worker timer
  // periodically revalidates every connection (re-runs retrieveExpandedAccess →
  // the revoke check → disconnect on failure), bounding a revoked client's
  // socket lifetime to ~clientRevokeCheckSeconds instead of the connection's
  // full life. revalidateConnections is fire-and-forget per connection.
  const { getConfigSync } = require('@pryv/boiler');
  let revokeSweepSeconds = 30;
  try {
    const configured = Number(getConfigSync().get('oauth:clientRevokeCheckSeconds'));
    if (Number.isFinite(configured) && configured > 0) revokeSweepSeconds = configured;
  } catch { /* keep default */ }
  const revokeSweep = setInterval(() => {
    try { manager.revalidateConnections(); } catch (err: unknown) {
      logger.warn('client-revoke socket sweep failed', err);
    }
  }, Math.max(5, revokeSweepSeconds) * 1000);
  revokeSweep.unref(); // must not keep the worker alive
  // dynamicNamspaces allow to "auto" create namespaces
  // when connected pass the socket to Manager
  const dynamicNamespace = io.of(/^\/.+$/).on('connect', async (socket: SocketLike) => {
    const nameSpaceContext = await manager.ensureInitNamespace(socket.nsp.name);
    nameSpaceContext.onConnect(socket);
  });
    // add a middelware for authentication
    // add middelware for authentication
  dynamicNamespace.use(async (socket: SocketLike, next: (err: unknown, success?: boolean) => void) => {
    try {
      const nsName = socket.nsp.name;
      const query = socket.handshake.query;
      const userName = manager.extractUsername(nsName);
      if (userName == null) { throw new Error(`Invalid resource "${nsName}".`); }
      if (query.auth == null) { throw new Error("Missing 'auth' parameter with a valid access token."); }
      const contextSource = {
        name: 'socket.io',
        ip: socket.handshake.headers['x-forwarded-for'] ||
                    socket.request.connection.remoteAddress
      };
      const context = new MethodContext(contextSource, userName, query.auth, customAuthStepFn);
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
export default setupSocketIO;
export { setupSocketIO };