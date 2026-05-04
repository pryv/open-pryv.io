/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from "node:fs";


/**
 * DynamicInstanceManager - Instance manager with dynamic port allocation
 * Enables parallel test execution by allocating unique ports per instance
 */

const EventEmitter = require('events').EventEmitter;
const fs = require('fs');
const spawn = require('child_process').spawn;
const temp = require('temp');
const util = require('util');

const { getLogger } = require('@pryv/boiler');
const portAllocator = require('./portAllocator');

module.exports = DynamicInstanceManager;

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
 * @param {Object} config Must contain `serverFilePath`
 * @param {Object} options Optional: { messagePrefix: string } for message filtering
 * @constructor
 */
function DynamicInstanceManager (config, options: any = {}) {
  (DynamicInstanceManager as any).super_.call(this);

  const messagePrefix = options.messagePrefix || '';
  let serverSettings = null;
  const tempConfigPath = temp.path({ suffix: '.json' });
  let serverProcess = null;
  let serverReady = false;
  let allocatedHttpPort = null;
  const logger = getLogger('dynamic-instance-manager');
  const self = this;

  // Cleanup handler
  const cleanup = () => {
    if (serverProcess) {
      try {
        serverProcess.kill('SIGKILL');
      } catch (e) {
        // Ignore
      }
      serverProcess = null;
    }
  };

  // Register cleanup handlers for graceful shutdown
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  /**
   * Allocate ports and start the server
   * @param {Object} inputSettings - Server configuration settings
   * @param {Function} callback
   */
  this.ensureStarted = function (inputSettings, callback) {
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
        // Stop existing server if running and wait for it
        if (isRunning()) {
          await self.stopAsync();
        }

        // Reuse existing port if already allocated, otherwise allocate a new one
        let httpPort;
        if (allocatedHttpPort) {
          httpPort = allocatedHttpPort;
          logger.debug(`Reusing port: HTTP ${httpPort}`);
        } else {
          httpPort = await portAllocator.allocatePort();
          allocatedHttpPort = httpPort;
          logger.debug(`Allocated new port: HTTP ${httpPort}`);
        }

        // Configure HTTP — set all port keys so any server type gets the right port
        settingsCopy.http = settingsCopy.http || {};
        settingsCopy.http.port = httpPort;
        settingsCopy.http.hfsPort = httpPort;
        settingsCopy.http.previewsPort = httpPort;
        settingsCopy.http.ip = settingsCopy.http.ip || '127.0.0.1';

        // Configure test notifications (IPC-based, no port needed)
        settingsCopy.testNotifications = { enabled: true };

        serverSettings = settingsCopy;
        self.url = `http://${settingsCopy.http.ip}:${httpPort}`;

        logger.debug(`Starting server on port ${httpPort}`);
        self.start(callback);
      } catch (err) {
        callback(err);
      }
    })();
  };

  this.ensureStartedAsync = util.promisify(this.ensureStarted).bind(this);

  /**
   * Restart the server with the same settings
   */
  this.restart = function (callback) {
    const self = this;
    if (!serverSettings) {
      return callback(new Error('Cannot restart: server was never started with ensureStarted'));
    }

    // Use ensureStarted which properly handles stop and restart
    self.ensureStarted(serverSettings, callback);
  };

  this.restartAsync = util.promisify(this.restart).bind(this);

  /**
   * Start the server process
   * @api private
   */
  this.start = function (callback) {
    if (isRunning()) {
      throw new Error('Server is already running; stop it first.');
    }

    // Write config to temp file
    fs.writeFileSync(tempConfigPath, JSON.stringify(serverSettings, null, 2));
    const args = ['--config=' + tempConfigPath];
    args.unshift(config.serverFilePath);

    // Debug support
    if (process.execArgv.indexOf('--debug') !== -1) {
      args.unshift('--debug=5859');
    }
    if (process.execArgv.indexOf('--debug-brk') !== -1) {
      args.unshift('--debug-brk=5859');
    }

    // Profiling support
    if (serverSettings.profile) {
      args.unshift('--prof');
    }

    logger.debug('Starting server instance with config ' + tempConfigPath);
    const options = {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, PRYV_BOILER_SUFFIX: '-dyn' + spawnCounter++ }
    };

    serverProcess = spawn(process.argv[0], args, options);
    let serverExited = false;
    let exitCode = null;

    serverProcess.on('exit', function (code) {
      logger.debug('Server instance exited with code ' + code);
      serverExited = true;
      exitCode = code;
      serverProcess = null;
    });

    serverProcess.on('error', function (err) {
      logger.error('Server process error:', err);
      serverExited = true;
      exitCode = 1;
      serverProcess = null;
    });

    serverProcess.on('message', function (msg) {
      if (msg && msg.type === 'test-notification') {
        // Support message prefix filtering for isolation
        const event = msg.event;
        if (messagePrefix && !event.startsWith(messagePrefix)) return;
        if (event === 'test-server-ready') serverReady = true;
        self.emit(event, msg.data);
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

  /**
   * Check if the server crashed
   */
  this.crashed = function () {
    return serverProcess && serverProcess.exitCode > 0;
  };

  /**
   * Stop the server (async version that waits for process to exit)
   * @param {Function} callback - Called when server has stopped
   */
  this.stop = function (callback) {
    if (!isRunning()) {
      if (callback) callback();
      return;
    }
    logger.debug('Stopping server instance...');

    const proc = serverProcess;
    serverProcess = null;
    serverReady = false;

    // Set up exit handler before killing
    const onExit = () => {
      logger.debug('Server instance stopped');
      if (callback) callback();
    };

    proc.once('exit', onExit);

    // Try graceful shutdown first
    try {
      proc.kill('SIGTERM');
    } catch (e) {
      // If SIGTERM fails, try SIGKILL
      try {
        proc.kill('SIGKILL');
      } catch (e2) {
        logger.warn('Failed to kill the server instance');
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
  };

  this.stopAsync = util.promisify(this.stop).bind(this);

  /**
   * Force kill (for cleanup after errors)
   */
  this.forceKill = function () {
    cleanup();
  };

  /**
   * Get allocated HTTP port
   */
  this.getPort = function () {
    return allocatedHttpPort;
  };

  function isRunning () {
    return !!serverProcess;
  }
}
util.inherits(DynamicInstanceManager, EventEmitter);
