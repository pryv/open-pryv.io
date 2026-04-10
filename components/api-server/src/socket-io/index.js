/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
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
const Manager = require('./Manager');
const Paths = require('../routes/Paths');
const { getLogger } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');
// Initializes the SocketIO subsystem.
//
/**
 * @param {Server} server
 * @param {API} api
 * @param {CustomAuthFunction | null} customAuthStepFn
 * @returns {Promise<void>}
 */
async function setupSocketIO (server, api, customAuthStepFn) {
  const logger = getLogger('socketIO');
  const storageLayer = await getStorageLayer();
  const io = socketIO.listen(server, {
    path: Paths.SocketIO
  });
    // Manages socket.io connections and delivers method calls to the api.
  const manager = new Manager(logger, io, api, storageLayer, customAuthStepFn);
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
module.exports = setupSocketIO;
