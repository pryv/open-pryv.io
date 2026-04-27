/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
//

const url = require('url');
const childProcessNodeInternal = require('child_process');
const EventEmitter = require('events');
const path = require('path');
const msgpack = require('msgpack5')();
const supertest = require('supertest');
const _ = require('lodash');
const { ConditionVariable, Fuse } = require('./condition_variable');
const portAllocator = require('./portAllocator');
// Set DEBUG=spawner to see these messages.
const logger = require('@pryv/boiler').getLogger('spawner');

const PRESPAWN_LIMIT = 2;

let debugPortCount = 1;
let spawnCounter = 0;

// Spawns instances of api-server for tests. Listening port is chosen at random;
// settings are either default or what you pass into the #spawn function.
//

class SpawnContext {
  childPath;

  shuttingDown;

  pool;

  allocated;

  // Construct a spawn context. `childPath` should be a module require path to
  // the module that will be launched in the child process. Please see
  // components/api-server/test/helpers/child_process for an example of such
  // a module.
  //

  constructor (childPath) {
    this.childPath = childPath || path.resolve(__dirname, '../../api-server/test/helpers/child_process');

    this.shuttingDown = false;
    this.pool = [];

    // All the processes that we've created and given to someone using
    // getProcess.
    this.allocated = [];

    this.prespawn();
  }

  // Prespawns processes up to PRESPAWN_LIMIT.
  //
  /**
   * @returns {void}
   */
  prespawn () {
    const childPath = this.childPath;

    while (this.pool.length < PRESPAWN_LIMIT) {
      logger.debug('prespawn process');
      const newArgv = process.execArgv.map((arg) => {
        if (arg.startsWith('--inspect-brk=')) {
          return ('--inspect-brk=' + (Number(arg.split('=')[1]) + debugPortCount++));
        }
        return arg;
      });
      const newEnv = {
        ...process.env,
        PRYV_BOILER_SUFFIX: '#' + spawnCounter++
      };
      const childProcess = childProcessNodeInternal.fork(childPath, null, {
        execArgv: newArgv,
        env: newEnv
      });
      const proxy = new ProcessProxy(childProcess, this);
      logger.debug(`prespawned child pid ${childProcess.pid}`);

      this.pool.push(proxy);
    }
  }

  // Spawns a server instance.
  //
  /**
   * @param {any} customSettings
   * @returns {Promise<Server>}
   */
  async spawn (customSettings) {
    // If by any chance we exhausted our processes really quickly, make
    // sure to spawn a few now.
    if (this.pool.length <= 0) { this.prespawn(); }
    // Find a port to use
    // TODO Free ports once done.
    const port = await this.allocatePort();

    // Obtain a process proxy
    const process = this.getProcess();

    // Create settings for this new instance.
    customSettings = customSettings || {};
    const settings = _.merge({
      http: {
        port, // use this port for http/express
        hfsPort: port,
        previewsPort: port
      },
      testNotifications: {
        enabled: true
      }
    }, customSettings);

    // Specialize the server we've started using the settings above.
    await process.startServer(settings);

    logger.debug(`spawned a child on port ${port}`);

    // Return to our caller - server should be up and answering at this point.
    return new Server(port, process);
  }

  // Returns the next free port to use for testing.
  // Uses the shared portAllocator for consistent port management.
  //
  /**
   * @returns {Promise<number>}
   */
  async allocatePort () {
    return portAllocator.allocatePort();
  }

  // Spawns and returns a process to use for testing. This will probably spawn
  // processes ahead of time in the background and return the next process from
  // the internal prespawn pool.
  //
  /**
   * @returns {ProcessProxy}
   */
  getProcess () {
    this.prespawn();
    if (this.pool.length <= 0) { throw new Error('AF: pool is not empty'); }
    const proxy = this.pool.shift();
    this.allocated.push(proxy);
    return proxy;
  }

  // Spawns `n` instances at different listening ports. See #spawn.
  //
  /**
   * @param {number} n
   * @returns {Promise<Server>[]}
   */
  spawn_multi (n) {
    if (n <= 0) { throw new Error('AF: n expected to be > 0'); }
    return Array.from({ length: n }, () => this.spawn());
  }

  // Called by the ProcessProxy when the child it is connected to exits. This
  // exists to allow prespawning to catch up.
  //
  /**
   * @returns {void}
   */
  onChildExit () {
    if (!this.shuttingDown) { this.prespawn(); }
  }

  // Call this when you want to stop all children at the end of the test suite.
  //
  /**
   * @returns {Promise<void>}
   */
  async shutdown () {
    logger.debug('shutting down the context', this.pool.length);
    this.shuttingDown = true;

    for (const child of this.pool) {
      await child.terminate();
    }

    for (const child of this.allocated) {
      await child.terminate();
    }
  }
}
// A proxy to the processes we launch. This class will care for the child
// processes and manage their lifecycle. It also provides a type-safe interface
// to messages that can be sent to the process.
//
class ProcessProxy {
  childProcess;
  pool;

  started;
  exited;

  pendingMessages;

  constructor (childProcess, pool) {
    this.childProcess = childProcess;
    this.pool = pool;

    this.started = new Fuse();
    this.exited = new Fuse();

    this.pendingMessages = new Map();

    this.registerEvents();
  }

  /**
   * @returns {void}
   */
  registerEvents () {
    const child = this.childProcess;
    child.on('error', (err) => this.onChildError(err));
    child.on('exit', () => this.onChildExit());
    child.on('message', (wire) => {
      if (wire && wire.type === 'test-notification') return; // skip IPC test notifications
      this.dispatchChildMessage(wire);
    });
  }

  /**
   * @returns {void}
   */
  dispatchChildMessage (wireMsg) {
    const pendingMessages = this.pendingMessages;
    const [status, msgId, cmd, retOrErr] = msgpack.decode(wireMsg);
    logger.debug('dispatchChildMessage/msg', status, msgId, cmd, retOrErr);
    if (!pendingMessages.has(msgId)) { throw new Error(`Received client process message (${msgId}/${cmd}) without counterpart.`); }
    const resolver = pendingMessages.get(msgId);
    if (resolver == null) { throw new Error('AF: No pending message exists'); }
    switch (status) {
      case 'ok':
        resolver.resolve(retOrErr);
        break;
      case 'err':
        resolver.reject(new Error(`Remote exception: ${retOrErr}`));
        break;
      default:
        throw new Error(`Invalid status value '${status}'`);
    }
  }

  /**
   * @param {unknown} err
   * @returns {void}
   */
  onChildError (err) {
    logger.debug(err);
  }

  /**
   * @returns {void}
   */
  onChildExit () {
    logger.debug('child exited');
    this.exited.burn();

    this.pool.onChildExit();
  }

  // Starts the express/socket.io server with the settings given.
  //
  /**
   * @param {unknown} settings
   * @returns {Promise<void>}
   */
  async startServer (settings) {
    if (this.exited.isBurnt()) { throw new Error('Child exited prematurely; please check your setup code.'); }
    await this.sendToChild('int_startServer', settings);

    logger.debug('child started');
    this.started.burn();
  }

  // Terminates the associated child process; progressing from SIGTERM to SIGKILL.
  //
  /**
   * @returns {Promise<unknown>}
   */
  async terminate () {
    if (this.exited.isBurnt()) { return; }
    const child = this.childProcess;
    logger.debug('sending SIGTERM');
    child.kill('SIGTERM');
    try {
      await this.exited.wait(1000);
    } catch (err) {
      logger.debug('sending SIGKILL');
      child.kill('SIGKILL');

      try {
        await this.exited.wait(1000);
      } catch (err) {
        logger.debug('giving up, unkillable child');
      }
    }
  }

  /**
   * @param {string} msg
   * @param {any} args
   * @returns {Promise<unknown>}
   */
  sendToChild (msg, ...args) {
    return new Promise((resolve, reject) => {
      const child = this.childProcess;
      const msgId = this.createPendingMessage(resolve, reject);
      // This is where things get async - the child will answer whenever it
      // likes.  The answer is handled by dispatchChildMessage.
      child.send(msgpack.encode([msgId, msg, ...args]));
    });
  }

  /**
   * @param {ResolveFun} res
   * @param {RejectFun} rej
   * @returns {number}
   */
  createPendingMessage (res, rej) {
    let remainingTries = 1000;
    const pendingMessages = this.pendingMessages;
    const resolver = {
      resolve: res,
      reject: rej
    };

    while (remainingTries > 0) {
      const candId = Math.floor(Math.random() * 1e9);
      if (!pendingMessages.has(candId)) {
        pendingMessages.set(candId, resolver);

        // Success return.
        return candId;
      }

      remainingTries -= 1;
    }

    // assert: We haven't found a free message id in 1000 tries.. give up.
    throw new Error('AF: Could not find a free message id.');
  }
}

// Public facade to the servers we spawn.
//
/** @extends EventEmitter */
class Server extends EventEmitter {
  port;

  baseUrl;
  process;

  host;

  constructor (port, proxy) {
    super();
    this.port = port;
    this.host = '127.0.0.1';
    this.baseUrl = `http://${this.host}:${port}`;
    this.process = proxy;
    this.listen();
  }

  /**
   * @returns {void}
   */
  listen () {
    const child = this.process.childProcess;
    child.on('message', (msg) => {
      if (msg && msg.type === 'test-notification') {
        this.emit(msg.event, msg.data);
      }
      // other messages (msgpack command responses) handled by ProcessProxy
    });
  }

  // Stops the server as soon as possible. Eventually returns either `true` (for
  // when the process could be stopped) or `false` for when the child could not
  // be terminated.
  //
  /**
   * @returns {Promise<boolean>}
   */
  async stop () {
    logger.debug('stop called');
    try {
      logger.debug('stopping child...');
      await this.process.terminate();
      logger.debug('child stopped.');
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * @param {string} path
   * @returns {string}
   */
  url (path) {
    return new url.URL(path || '', this.baseUrl).toString();
  }

  /**
   * @param {string} newUrl
   * @returns {any}
   */
  request (newUrl) {
    return supertest(newUrl || this.baseUrl);
  }
}
module.exports = {
  SpawnContext,
  Server,
  ConditionVariable
};

/** @typedef {number} MessageId */

/** @typedef {(val: unknown) => void} ResolveFun */

/** @typedef {(err: Error) => void} RejectFun */

/**
 * @typedef {{
 *   resolve: ResolveFun;
 *   reject: RejectFun;
 * }} Resolver
 */
