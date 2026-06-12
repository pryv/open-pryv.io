/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * DynamicInstanceManager - Instance manager with dynamic port allocation
 * Enables parallel test execution by allocating unique ports per instance
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('util');

const { getLogger } = require('@pryv/boiler');
const portAllocator = require('./portAllocator.ts');
const { getPerWorkerOverrides, isParallelMode } = require('./parallelWorkerSetup.ts');

let spawnCounter = 0;

/**
 * Manages test server instances with dynamic port allocation.
 * Unlike InstanceManager, this allocates ports dynamically enabling parallel testing.
 *
 * Usage:
 *   const manager = new DynamicInstanceManager({ serverFilePath: '...' });
 *   await manager.ensureStartedAsync(settings);
 *   // use manager.url for HTTP requests
 *   // use manager.on('test-*', callback) for notifications
 *
 * @param config Must contain `serverFilePath`
 * @param options Optional: { messagePrefix: string } for message filtering
 */
class DynamicInstanceManager extends EventEmitter {
  url?: string;
  private config: any;
  private messagePrefix: string;
  private serverSettings: any = null;
  private tempConfigPath: string;
  private serverProcess: any = null;
  private serverReady: boolean = false;
  private allocatedHttpPort: number | null = null;
  private logger: any;

  ensureStartedAsync: (settings: any) => Promise<void>;
  restartAsync: () => Promise<void>;
  stopAsync: () => Promise<void>;

  constructor (config: any, options: any = {}) {
    super();
    this.config = config;
    this.messagePrefix = options.messagePrefix || '';
    this.tempConfigPath = path.join(os.tmpdir(), `dim-${crypto.randomBytes(8).toString('hex')}.json`);
    this.logger = getLogger('dynamic-instance-manager');

    this.ensureStartedAsync = util.promisify(this.ensureStarted).bind(this);
    this.restartAsync = util.promisify(this.restart).bind(this);
    this.stopAsync = util.promisify(this.stop).bind(this);

    // Cleanup handlers for graceful shutdown
    process.on('exit', () => this.cleanup());
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
  }

  private cleanup () {
    if (this.serverProcess) {
      try {
        this.serverProcess.kill('SIGKILL');
      } catch (e) {
        // Ignore
      }
      this.serverProcess = null;
    }
  }

  private isRunning () {
    return !!this.serverProcess;
  }

  /** Allocate ports and start the server. */
  ensureStarted (inputSettings: any, callback: any) {
    const settingsCopy = structuredClone(inputSettings);

    // Force console settings
    if (typeof settingsCopy.logs === 'undefined') settingsCopy.logs = {};
    if (typeof settingsCopy.logs.console === 'undefined') settingsCopy.logs.console = {};

    if (process.env.LOGS) {
      settingsCopy.logs.console.active = true;
      settingsCopy.logs.console.level = process.env.LOGS;
    } else {
      settingsCopy.logs.console.active = false;
    }

    // Allocate ports asynchronously
    (async () => {
      try {
        if (this.isRunning()) {
          await this.stopAsync();
        }

        // Reuse existing port if already allocated, otherwise allocate a new one
        let httpPort: number;
        if (this.allocatedHttpPort) {
          httpPort = this.allocatedHttpPort;
          this.logger.debug(`Reusing port: HTTP ${httpPort}`);
        } else {
          httpPort = await portAllocator.allocatePort();
          this.allocatedHttpPort = httpPort;
          this.logger.debug(`Allocated new port: HTTP ${httpPort}`);
        }

        // Configure HTTP — set all port keys so any server type gets the right port
        settingsCopy.http = settingsCopy.http || {};
        settingsCopy.http.port = httpPort;
        settingsCopy.http.hfsPort = httpPort;
        settingsCopy.http.previewsPort = httpPort;
        settingsCopy.http.ip = settingsCopy.http.ip || '127.0.0.1';

        // Configure test notifications (IPC-based, no port needed)
        settingsCopy.testNotifications = { enabled: true };

        this.serverSettings = settingsCopy;
        this.url = `http://${settingsCopy.http.ip}:${httpPort}`;

        this.logger.debug(`Starting server on port ${httpPort}`);
        this.start(callback);
      } catch (err) {
        callback(err);
      }
    })();
  }

  /** Restart the server with the same settings. */
  restart (callback: any) {
    if (!this.serverSettings) {
      return callback(new Error('Cannot restart: server was never started with ensureStarted'));
    }
    this.ensureStarted(this.serverSettings, callback);
  }

  /** Start the server process. @api private */
  start (callback: any) {
    if (this.isRunning()) {
      throw new Error('Server is already running; stop it first.');
    }

    // In parallel mode, re-apply per-worker DB + path overrides to the
    // settings the child api-server will read. The
    // `helpers.dependencies.settings` lazy getter reads live boiler config,
    // but tests that mutate the boiler config (e.g. `injectTestConfig`
    // family, `_.merge`-and-pass settings overrides) can revert per-worker
    // values back to the default `pryv-node-test` between spawns. When
    // that happens the child api-server connects to the WRONG DB and any
    // login → 404 (user not found) → boiler's unhandled-rejection logger
    // throws → worker process exits 7. Forcing these per-worker keys here
    // is idempotent and decoupled from whatever the test happened to do
    // to the in-memory boiler store between spawns.
    if (isParallelMode()) {
      const o = getPerWorkerOverrides();
      this.serverSettings.storages = this.serverSettings.storages || {};
      this.serverSettings.storages.engines = this.serverSettings.storages.engines || {};
      const eng = this.serverSettings.storages.engines;
      eng.postgresql = { ...(eng.postgresql || {}), database: o.postgresqlDatabase };
      eng.sqlite = { ...(eng.sqlite || {}), path: o.sqlitePath };
      eng.rqlite = { ...(eng.rqlite || {}), url: o.rqliteUrl, raftPort: o.rqliteRaftPort, dataDir: o.rqliteDataDir };
      eng.filesystem = { ...(eng.filesystem || {}), previewsDirPath: o.previewsDirPath };
    }
    fs.writeFileSync(this.tempConfigPath, JSON.stringify(this.serverSettings, null, 2));
    const args = ['--config=' + this.tempConfigPath];
    args.unshift(this.config.serverFilePath);

    if (process.execArgv.indexOf('--debug') !== -1) {
      args.unshift('--debug=5859');
    }
    if (process.execArgv.indexOf('--debug-brk') !== -1) {
      args.unshift('--debug-brk=5859');
    }
    if (this.serverSettings.profile) {
      args.unshift('--prof');
    }

    this.logger.debug('Starting server instance with config ' + this.tempConfigPath);
    const options = {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, PRYV_BOILER_SUFFIX: '-dyn' + spawnCounter++ }
    };

    this.serverProcess = spawn(process.argv[0], args, options);
    let serverExited = false;
    let exitCode: number | null = null;

    this.serverProcess.on('exit', (code: any) => {
      this.logger.debug('Server instance exited with code ' + code);
      serverExited = true;
      exitCode = code;
      this.serverProcess = null;
    });

    this.serverProcess.on('error', (err: any) => {
      this.logger.error('Server process error:', err);
      serverExited = true;
      exitCode = 1;
      this.serverProcess = null;
    });

    this.serverProcess.on('message', (msg: any) => {
      if (msg && msg.type === 'test-notification') {
        const event = msg.event;
        if (this.messagePrefix && !event.startsWith(this.messagePrefix)) return;
        if (event === 'test-server-ready') this.serverReady = true;
        this.emit(event, msg.data);
      }
    });

    const isReadyOrExited = () => this.serverReady || serverExited;
    (async () => {
      while (!isReadyOrExited()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (serverExited && exitCode != null && exitCode > 0) {
        return callback(new Error('Server failed (code ' + exitCode + ')'));
      }
      callback();
    })();
  }

  /** Check if the server crashed. */
  crashed () {
    return this.serverProcess && this.serverProcess.exitCode > 0;
  }

  /**
   * Stop the server (async version that waits for process to exit).
   * @param callback - Called when server has stopped
   */
  stop (callback?: any) {
    if (!this.isRunning()) {
      if (callback) callback();
      return;
    }
    this.logger.debug('Stopping server instance...');

    const proc = this.serverProcess;
    this.serverProcess = null;
    this.serverReady = false;

    const onExit = () => {
      this.logger.debug('Server instance stopped');
      if (callback) callback();
    };

    proc.once('exit', onExit);

    try {
      proc.kill('SIGTERM');
    } catch (e) {
      try {
        proc.kill('SIGKILL');
      } catch (e2) {
        this.logger.warn('Failed to kill the server instance');
        proc.removeListener('exit', onExit);
        if (callback) callback();
      }
    }

    // Timeout fallback - force kill after 5 seconds
    setTimeout(() => {
      if (proc && !proc.killed) {
        try {
          proc.kill('SIGKILL');
        } catch (e) {
          // Ignore
        }
      }
    }, 5000);
  }

  /** Force kill (for cleanup after errors). */
  forceKill () {
    this.cleanup();
  }

  /** Get allocated HTTP port. */
  getPort () {
    return this.allocatedHttpPort;
  }
}

export default DynamicInstanceManager;
export { DynamicInstanceManager };
