/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = require('path').dirname(__filename);

const url = require('url');
const childProcessNodeInternal = require('child_process');
const EventEmitter = require('events');
const path = require('path');
const msgpack = require('msgpack5')();
const supertest = require('supertest');
const { deepMerge } = require('utils');
const { Fuse } = require('./condition_variable.ts');
const portAllocator = require('./portAllocator.ts');

const logger = require('@pryv/boiler').getLogger('test-server-context');

let debugPortCount = 1;
let spawnCounter = 0;

/**
 * Spawns child processes that boot a server, one per `spawn()` call.
 *
 * Lazy-fork replacement for the legacy `SpawnContext`: no prespawn pool, no
 * eager env capture at constructor time. Each `spawn()` forks a fresh child
 * with the parent's *current* `process.env`, so per-worker overrides
 * (PG DB name, rqlite URL, etc.) injected by
 * `parallelWorkerSetup.ts` after module load reach the child.
 *
 * IPC protocol with the child is unchanged: msgpack-encoded
 * `[msgId, cmd, ...args]` → child handler → msgpack
 * `['ok'|'err', msgId, cmd, retOrErrJson]`. See `child_process.ts`.
 */
class TestServerContext {
  childPath: string;
  shuttingDown: boolean;
  allocated: ProcessProxy[];

  constructor (childPath?: string) {
    this.childPath = childPath || path.resolve(__dirname, '../../api-server/test/helpers/child_process');
    this.shuttingDown = false;
    this.allocated = [];
  }

  async spawn (customSettings?: any) {
    const port = await portAllocator.allocatePort();

    const proxy = this.forkChild();
    proxy.port = port;
    this.allocated.push(proxy);

    // Inherit the parent's effective storage-engine choice when running
    // under SQLite. helpers-c.ts (api-server) overrides
    // `storages:base:engine` to SQLite at module load when
    // STORAGE_ENGINE=sqlite; helpers-base.ts callers (audit, cache,
    // webhooks, …) leave the default in place. By copying the parent's
    // resolved value into `injectSettings`, the forked child talks to
    // the same engine — without forcing audit/cache/webhooks parents
    // (which DON'T override) to switch to SQLite themselves and hit
    // per-engine bugs.
    //
    // Gated to `STORAGE_ENGINE === 'sqlite'`: under PG matrix the
    // child's own default-config.yml resolution already picks PG (it
    // IS the default) AND passing engine settings through here
    // surfaces the pre-existing `[ASTE]`/`[AINT]`/`[ALGR]` audit
    // flake fanout we observed under matrix mode.
    const engineSettings: any = {};
    if (process.env.STORAGE_ENGINE === 'sqlite') {
      try {
        const { getConfigUnsafe } = require('@pryv/boiler');
        const cfg = getConfigUnsafe(true);
        const baseEng = cfg.get('storages:base:engine');
        const seriesEng = cfg.get('storages:series:engine');
        const fileEng = cfg.get('storages:file:engine');
        if (baseEng || seriesEng || fileEng) {
          engineSettings.storages = {};
          if (baseEng) engineSettings.storages.base = { engine: baseEng };
          if (seriesEng) engineSettings.storages.series = { engine: seriesEng };
          if (fileEng) engineSettings.storages.file = { engine: fileEng };
        }
      } catch (_e) {
        // boiler not initialised in this process — fall through with no
        // engine override; child uses its own default.
      }
    }

    const settings = deepMerge({
      http: { port, hfsPort: port, previewsPort: port },
      testNotifications: { enabled: true }
    }, engineSettings, customSettings || {});

    await proxy.startServer(settings);
    logger.debug(`spawned child on port ${port}`);
    return new TestServer(port, proxy);
  }

  private forkChild (): ProcessProxy {
    const newArgv = process.execArgv.map((arg: string) => {
      if (arg.startsWith('--inspect-brk=')) {
        return '--inspect-brk=' + (Number(arg.split('=')[1]) + debugPortCount++);
      }
      return arg;
    });
    // env captured here (per fork), not at constructor time. This is the
    // material change vs SpawnContext: per-worker env vars applied by
    // `setupParallelWorker` after module load now propagate to the child.
    const newEnv = {
      ...process.env,
      PRYV_BOILER_SUFFIX: '#' + spawnCounter++
    };
    const childProcess = childProcessNodeInternal.fork(this.childPath, null, {
      execArgv: newArgv,
      env: newEnv
    });
    logger.debug(`forked child pid ${childProcess.pid}`);
    return new ProcessProxy(childProcess);
  }

  async shutdown () {
    logger.debug('shutting down test-server context', this.allocated.length);
    this.shuttingDown = true;
    for (const child of this.allocated) {
      await child.terminate();
    }
  }
}

class ProcessProxy {
  childProcess: any;
  started: any;
  exited: any;
  pendingMessages: Map<number, Resolver>;
  port: number | null;

  constructor (childProcess: any) {
    this.childProcess = childProcess;
    this.started = new Fuse();
    this.exited = new Fuse();
    this.pendingMessages = new Map();
    this.port = null;
    this.registerEvents();
  }

  registerEvents () {
    const child = this.childProcess;
    child.on('error', (err: any) => logger.debug('child error', err));
    child.on('exit', () => {
      logger.debug('child exited');
      this.exited.burn();
      if (this.port != null) {
        portAllocator.releasePort(this.port);
        this.port = null;
      }
    });
    child.on('message', (wire: any) => {
      if (wire && wire.type === 'test-notification') return;
      this.dispatchChildMessage(wire);
    });
  }

  dispatchChildMessage (wireMsg: any) {
    const [status, msgId, cmd, retOrErr] = msgpack.decode(wireMsg);
    logger.debug('dispatchChildMessage', status, msgId, cmd);
    const resolver = this.pendingMessages.get(msgId);
    if (!resolver) {
      throw new Error(`Received child message (${msgId}/${cmd}) without counterpart.`);
    }
    this.pendingMessages.delete(msgId);
    if (status === 'ok') resolver.resolve(retOrErr);
    else if (status === 'err') resolver.reject(new Error(`Remote exception: ${retOrErr}`));
    else throw new Error(`Invalid status value '${status}'`);
  }

  async startServer (settings: any) {
    if (this.exited.isBurnt()) { throw new Error('Child exited prematurely; please check your setup code.'); }
    await this.sendToChild('int_startServer', settings);
    this.started.burn();
  }

  async terminate () {
    if (this.exited.isBurnt()) return;
    const child = this.childProcess;
    child.kill('SIGTERM');
    try {
      await this.exited.wait(1000);
    } catch (_e) {
      child.kill('SIGKILL');
      try {
        await this.exited.wait(1000);
      } catch (_e2) {
        logger.debug('giving up, unkillable child');
      }
    }
  }

  sendToChild (msg: any, ...args: any[]) {
    return new Promise((resolve, reject) => {
      const msgId = this.createPendingMessage(resolve, reject);
      this.childProcess.send(msgpack.encode([msgId, msg, ...args]));
    });
  }

  createPendingMessage (resolve: ResolveFun, reject: RejectFun): number {
    let remainingTries = 1000;
    while (remainingTries-- > 0) {
      const candId = Math.floor(Math.random() * 1e9);
      if (!this.pendingMessages.has(candId)) {
        this.pendingMessages.set(candId, { resolve, reject });
        return candId;
      }
    }
    throw new Error('AF: Could not find a free message id.');
  }
}

class TestServer extends EventEmitter {
  port: number;
  host: string;
  baseUrl: string;
  process: ProcessProxy;

  constructor (port: number, proxy: ProcessProxy) {
    super();
    this.port = port;
    this.host = '127.0.0.1';
    this.baseUrl = `http://${this.host}:${port}`;
    this.process = proxy;
    this.listen();
  }

  private listen () {
    this.process.childProcess.on('message', (msg: any) => {
      if (msg && msg.type === 'test-notification') {
        this.emit(msg.event, msg.data);
      }
    });
  }

  async stop () {
    try {
      await this.process.terminate();
      return true;
    } catch (_err) {
      return false;
    }
  }

  url (path?: string) {
    return new url.URL(path || '', this.baseUrl).toString();
  }

  request (newUrl?: string) {
    return supertest(newUrl || this.baseUrl);
  }
}

export { TestServerContext, TestServer };

type ResolveFun = (val: unknown) => void;
type RejectFun = (err: Error) => void;
type Resolver = { resolve: ResolveFun; reject: RejectFun };
