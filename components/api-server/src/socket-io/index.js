// @flow

/**
 * Note: Debug tests with: DEBUG=engine,socket.io* yarn test --grep="Socket"
 */

const socketIO = require('socket.io');

const MethodContext = require('components/model').MethodContext;
const NATS_CONNECTION_URI = require('components/utils').messaging.NATS_CONNECTION_URI;

const Manager = require('./Manager');
const Paths = require('../routes/Paths');

const ChangeNotifier = require('./change_notifier');

import type { Logger } from 'components/utils';
import type { StorageLayer } from 'components/storage';
import type { CustomAuthFunction } from 'components/model';

import type API from '../API';
import type { SocketIO$Handshake } from './Manager';

// Initializes the SocketIO subsystem. 
//
function setupSocketIO(
  server: net$Server, logger: Logger, 
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
      const context = new MethodContext(userName, query.auth, customAuthStepFn);
      // Load user, init the namespace
      await context.retrieveUser(storageLayer);
      if (context.user == null) throw new Error('AF: context.user != null');
    
      // Load user, init the namespace
      await context.retrieveUser(storageLayer);
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




