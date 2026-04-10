/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
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
