/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from "node:fs";

const EventEmitter = require('events').EventEmitter;
const fs = require('fs');
const spawn = require('child_process').spawn;
const temp = require('temp');
const util = require('util');

const { getLogger } = require('@pryv/boiler');

module.exports = InstanceManager;

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
 * @param {Object} settings Must contain `serverFilePath` and `logging`
 * @constructor
 */
function InstanceManager (settings) {
  (InstanceManager as any).super_.call(this);

  let serverSettings = null;
  const tempConfigPath = temp.path({ suffix: '.json' });
  let serverProcess = null;
  let serverReady = false;
  const logger = getLogger('instance-manager');
  const self = this;

  /**
   * Makes sure the instance is started with the given config settings, restarting it if needed;
   * does nothing if the instance is already running with the same settings.
   *
   * @param {Object} settings
   * @param {Function} callback
   */
  this.ensureStarted = function (settings, callback) {
    // force console settings to off is needed
    if (typeof settings.logs === 'undefined') settings.logs = {};
    if (typeof settings.logs.console === 'undefined') settings.logs.console = {};

    if (process.env.LOGS) {
      settings.logs.console.active = true;
      settings.logs.console.level = process.env.LOGS;
    } else {
      settings.logs.console.active = false;
    }

    logger.debug('ensure started', settings.http);
    if (util.isDeepStrictEqual(settings, serverSettings)) {
      if (isRunning()) {
        // nothing to do
        return callback();
      }
    } else {
      if (isRunning()) {
        try {
          this.stop();
        } catch (err) {
          return callback(err);
        }
      }
      serverSettings = settings;
      this.setup();
    }
    this.start(callback);
  };

  this.ensureStartedAsync = util.promisify(this.ensureStarted).bind(this);

  /**
   * Just restarts the instance, leaving settings as they are.
   *
   * @param {Function} callback
   */
  this.restart = function (callback) {
    if (isRunning()) {
      try {
        this.stop();
      } catch (err) {
        return callback(err);
      }
    }
    this.start(callback);
  };

  this.restartAsync = util.promisify(this.restart).bind(this);

  /**
   * @api private
   */
  this.setup = function () {
    this.url = 'http://' + serverSettings.http.ip + ':' + serverSettings.http.port;
  };

  /**
   * @api private
   */
  this.start = function (callback) {
    if (isRunning()) {
      throw new Error('Server is already running; stop it first.');
    }

    // write config to temp path
    fs.writeFileSync(tempConfigPath, JSON.stringify(serverSettings, null, 2));
    const args = ['--config=' + tempConfigPath];
    args.unshift(settings.serverFilePath);

    // setup debug if needed (assumes current process debug port is 5858 i.e. default)

    if (process.execArgv.indexOf('--debug') !== -1) {
      args.unshift('--debug=5859');
    }
    if (process.execArgv.indexOf('--debug-brk') !== -1) {
      args.unshift('--debug-brk=5859');
    }

    // set profiling if needed

    if (serverSettings.profile) {
      args.unshift('--prof');
    }

    // start proc
    logger.debug('Starting server instance... with config ' + tempConfigPath);
    const options = {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, PRYV_BOILER_SUFFIX: '-' + spawnCounter++ }
    };
    serverProcess = spawn(process.argv[0], args, options);
    let serverExited = false;
    let exitCode = null;
    serverProcess.on('exit', function (code/*, signal */) {
      logger.debug('Server instance exited with code ' + code);
      serverExited = true;
      exitCode = code;
    });
    serverProcess.on('message', function (msg) {
      if (msg && msg.type === 'test-notification') {
        if (msg.event === 'test-server-ready') serverReady = true;
        self.emit(msg.event, msg.data);
      }
    });

    (async () => {
      while (!isReadyOrExited()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (serverExited && exitCode > 0) {
        return callback(new Error('Server failed (code ' + exitCode + ')'));
      }
      callback();
    })();

    function isReadyOrExited () {
      return serverReady || serverExited;
    }
  };

  this.crashed = function () {
    return serverProcess && serverProcess.exitCode > 0;
  };

  /**
   * @api private
   */
  this.stop = function () {
    if (!isRunning()) { return; }
    logger.debug('Killing server instance... ');
    if (!serverProcess.kill()) {
      logger.warn('Failed to kill the server instance (it may have exited already).');
    }
    serverProcess = null;
    serverReady = false;
  };

  function isRunning () {
    return !!serverProcess;
  }

  process.on('exit', this.stop);
}
util.inherits(InstanceManager, EventEmitter);
