/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { EventEmitter } = require('events');
const fs = require('fs');
const { spawn } = require('child_process');
const temp = require('temp');
const util = require('util');

const { getLogger } = require('@pryv/boiler');

let spawnCounter = 0;

/**
 * Manages the test server instance (use as singleton).
 *
 * - Server runs in a spawned child process (note: the server must send a "server-ready" message on
 *   its TCP pub socket when appropriate)
 * - Settings are passed via a temp JSON file; server only restarts if settings change
 * - Forwards TCP messages published by the server as regular events for interested tests to check
 *
 * Usage: just call `server.ensureStarted(settings, callback)` before running tests.
 *
 * @param settings Must contain `serverFilePath` and `logging`
 */
class InstanceManager extends EventEmitter {
  url?: string;
  private settings: any;
  private serverSettings: any = null;
  private tempConfigPath: string;
  private serverProcess: any = null;
  private serverReady: boolean = false;
  private logger: any;
  ensureStartedAsync: (settings: any) => Promise<void>;
  restartAsync: () => Promise<void>;

  constructor (settings: any) {
    super();
    this.settings = settings;
    this.tempConfigPath = temp.path({ suffix: '.json' });
    this.logger = getLogger('instance-manager');
    this.ensureStartedAsync = util.promisify(this.ensureStarted).bind(this);
    this.restartAsync = util.promisify(this.restart).bind(this);
    process.on('exit', () => this.stop());
  }

  /**
   * Makes sure the instance is started with the given config settings, restarting it if needed;
   * does nothing if the instance is already running with the same settings.
   */
  ensureStarted (settings: any, callback: any) {
    // force console settings to off is needed
    if (typeof settings.logs === 'undefined') settings.logs = {};
    if (typeof settings.logs.console === 'undefined') settings.logs.console = {};

    if (process.env.LOGS) {
      settings.logs.console.active = true;
      settings.logs.console.level = process.env.LOGS;
    } else {
      settings.logs.console.active = false;
    }

    this.logger.debug('ensure started', settings.http);
    if (util.isDeepStrictEqual(settings, this.serverSettings)) {
      if (this.isRunning()) {
        return callback();
      }
    } else {
      if (this.isRunning()) {
        try {
          this.stop();
        } catch (err) {
          return callback(err);
        }
      }
      this.serverSettings = settings;
      this.setup();
    }
    this.start(callback);
  }

  /** Just restarts the instance, leaving settings as they are. */
  restart (callback: any) {
    if (this.isRunning()) {
      try {
        this.stop();
      } catch (err) {
        return callback(err);
      }
    }
    this.start(callback);
  }

  /** @api private */
  setup () {
    this.url = 'http://' + this.serverSettings.http.ip + ':' + this.serverSettings.http.port;
  }

  /** @api private */
  start (callback: any) {
    if (this.isRunning()) {
      throw new Error('Server is already running; stop it first.');
    }

    fs.writeFileSync(this.tempConfigPath, JSON.stringify(this.serverSettings, null, 2));
    const args = ['--config=' + this.tempConfigPath];
    args.unshift(this.settings.serverFilePath);

    // setup debug if needed (assumes current process debug port is 5858 i.e. default)
    if (process.execArgv.indexOf('--debug') !== -1) {
      args.unshift('--debug=5859');
    }
    if (process.execArgv.indexOf('--debug-brk') !== -1) {
      args.unshift('--debug-brk=5859');
    }

    if (this.serverSettings.profile) {
      args.unshift('--prof');
    }

    this.logger.debug('Starting server instance... with config ' + this.tempConfigPath);
    const options = {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, PRYV_BOILER_SUFFIX: '-' + spawnCounter++ }
    };
    this.serverProcess = spawn(process.argv[0], args, options);
    let serverExited = false;
    let exitCode: number | null = null;
    this.serverProcess.on('exit', (code: any) => {
      this.logger.debug('Server instance exited with code ' + code);
      serverExited = true;
      exitCode = code;
    });
    this.serverProcess.on('message', (msg: any) => {
      if (msg && msg.type === 'test-notification') {
        if (msg.event === 'test-server-ready') this.serverReady = true;
        this.emit(msg.event, msg.data);
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

  crashed () {
    return this.serverProcess && this.serverProcess.exitCode > 0;
  }

  /** @api private */
  stop () {
    if (!this.isRunning()) return;
    this.logger.debug('Killing server instance... ');
    if (!this.serverProcess.kill()) {
      this.logger.warn('Failed to kill the server instance (it may have exited already).');
    }
    this.serverProcess = null;
    this.serverReady = false;
  }

  private isRunning () {
    return !!this.serverProcess;
  }
}

export default InstanceManager;
export { InstanceManager };
