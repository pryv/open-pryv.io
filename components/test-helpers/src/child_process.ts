/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const logger = require('@pryv/boiler').getLogger('child_process');
const msgpack = require('msgpack5')();

class ChildProcess {
  launcher;

  constructor (launcher: any) {
    this.launcher = launcher;

    // This bit is useful to trace down promise rejections that aren't caught.
    // unhandledRejection's `reason` is genuinely `unknown` per
    // Node's contract; the cast accepts whatever the rejection carried.
    process.on('unhandledRejection', (reason, promise) => this.unhandledRejection(reason as any, promise));
    // Receives messages from the parent (spawner.js) and dispatches them to the
    // handler functions below.
    //
    process.on('message', (msg) => this.handleParentMessage(msg as Buffer));
  }

  // Handles promise rejections that aren't caught somewhere. This is very
  // useful for debugging.
  unhandledRejection (reason: any, promise: any) {
    logger.warn(

      'Unhandled promise rejection:', promise, 'reason:', reason.stack || reason);
  }

  async handleParentMessage (wireMessage: any) {
    const message = msgpack.decode(wireMessage);

    const [msgId, cmd, ...args] = message;
    logger.debug('handleParentMessage/received ', msgId, cmd, args);

    try {
      let ret = await this.dispatchParentMessage(cmd, ...args);

      // msgpack cannot encode undefined.
      if (ret === undefined) { ret = null; }
      this.respondToParent(['ok', msgId, cmd, ret]);
    } catch (err: any) {
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

  respondToParent (msg: any) {
    logger.debug('respondToParent', msg);

    process.send!(msgpack.encode(msg)); // worker child; send is always defined here
  }

  dispatchParentMessage (cmd: any, ...args: any[]) {
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
  async intStartServer (injectSettings: any) {
    const launcher = this.launcher;

    return launcher.launch(injectSettings);
  }

  // Main method to launch the child process.
  //
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
export default ChildProcess;
export { ChildProcess };

type ApplicationLauncher = Object;