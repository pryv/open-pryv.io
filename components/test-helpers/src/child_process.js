/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
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
const logger = require('@pryv/boiler').getLogger('child_process');
const msgpack = require('msgpack5')();

class ChildProcess {
  launcher;

  constructor (launcher) {
    this.launcher = launcher;

    // This bit is useful to trace down promise rejections that aren't caught.
    //
    process.on('unhandledRejection', (...a) => this.unhandledRejection(...a));
    // Receives messages from the parent (spawner.js) and dispatches them to the
    // handler functions below.
    //
    process.on('message', (...a) => this.handleParentMessage(...a));
  }

  // Handles promise rejections that aren't caught somewhere. This is very
  // useful for debugging.
  /**
   * @param {Error} reason
   * @param {Promise<unknown>} promise
   * @returns {void}
   */
  unhandledRejection (reason, promise) {
    logger.warn(
      // eslint-disable-line no-console
      'Unhandled promise rejection:', promise, 'reason:', reason.stack || reason);
  }

  /**
   * @param {Buffer} wireMessage
   * @returns {Promise<void>}
   */
  async handleParentMessage (wireMessage) {
    const message = msgpack.decode(wireMessage);

    const [msgId, cmd, ...args] = message;
    logger.debug('handleParentMessage/received ', msgId, cmd, args);

    try {
      let ret = await this.dispatchParentMessage(cmd, ...args);

      // msgpack cannot encode undefined.
      if (ret === undefined) { ret = null; }
      this.respondToParent(['ok', msgId, cmd, ret]);
    } catch (err) {
      logger.debug('handleParentMessage/catch', err.message);
      // Using JSON.stringify as message que does nos support Object (just strings)
      this.respondToParent([
        'err',
        msgId,
        cmd,
        JSON.stringify({ message: err.message, stack: err.stack })
      ]);
    }

    logger.debug('handleParentMessage/done', cmd);
  }

  /**
   * @param {Array<unknown>} msg
   * @returns {void}
   */
  respondToParent (msg) {
    logger.debug('respondToParent', msg);

    process.send(msgpack.encode(msg));
  }

  /**
   * @param {string} cmd
   * @param {Array<unknown>} args
   * @returns {unknown}
   */
  dispatchParentMessage (cmd, ...args) {
    if (!cmd.startsWith('int_')) {
      const launcher = this.launcher;
      if (typeof launcher[cmd] !== 'function') { throw new Error(`Unknown/unhandled launcher message ${cmd}`); }
      return launcher[cmd](...args);
    }
    // assert: cmd.startsWith('int_')
    switch (cmd) {
      case 'int_startServer':
        // Assume this is happening...
        return this.intStartServer(args[0]);
      default:
        throw new Error(`Unknown/unhandled internal message ${cmd}`);
    }
  }

  // ----------------------------------------------------------- parent messages

  // Tells the launcher to launch the application, injecting the given
  // `injectSettings`.
  //
  /**
   * @param {{}} injectSettings
   * @returns {Promise<any>}
   */
  async intStartServer (injectSettings) {
    const launcher = this.launcher;

    return launcher.launch(injectSettings);
  }

  // Main method to launch the child process.
  //
  /**
   * @returns {void}
   */
  run () {
    // // Keeps the event loop busy. This is what the child does as long as it is not
    // // serving requests.
    // //
    // function work() {
    //   setTimeout(work, 10000);
    // }
    // work();
  }
}
module.exports = ChildProcess;

/** @typedef {Object} ApplicationLauncher */
