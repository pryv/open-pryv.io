/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
const async = require('async');
const axon = require('axon');
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
 * @param {Object} settings Must contain `serverFilePath`, `axonMessaging` and `logging`
 * @constructor
 */
function InstanceManager (settings) {
  InstanceManager.super_.call(this);

  let serverSettings = null;
  const tempConfigPath = temp.path({ suffix: '.json' });
  let serverProcess = null;
  let serverReady = false;
  const messagingSocket = axon.socket('sub-emitter');
  const logger = getLogger('instance-manager');

  // setup TCP axonMessaging subscription

  messagingSocket.bind(+settings.axonMessaging.port, settings.axonMessaging.host, function () {
    logger.debug('TCP sub socket ready on ' + settings.axonMessaging.host + ':' +
        settings.axonMessaging.port);
  });

  messagingSocket.on('*', function (message, data) {
    if (message === 'axon-server-ready') {
      serverReady = true;
    }
    // forward messages to our own listeners
    this.emit(message, data);
  }.bind(this));

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
    // adjust config settings for test instance
    serverSettings.axonMessaging.pubConnectInsteadOfBind = true;

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
      // Uncomment here if you want to see server output
      stdio: 'inherit',
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

    async.until(isReadyOrExited, function (next) { setTimeout(next, 100); }, function () {
      if (serverExited && exitCode > 0) {
        return callback(new Error('Server failed (code ' + exitCode + ')'));
      }
      callback();
    });

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
