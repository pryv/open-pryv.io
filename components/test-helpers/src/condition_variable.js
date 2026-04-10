/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

class Waiter {
  promise;

  resolve;

  reject;

  timeout;

  done;
  constructor (timeout) {
    this.done = false;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      if (timeout != null && timeout > 0) {
        this.timeout = setTimeout(() => this.timeoutFired(), timeout);
      }
    });
  }

  /**
   * @returns {void}
   */
  timeoutFired () {
    this.reject(new Error('timeout'));
  }

  /**
   * @returns {void}
   */
  release () {
    if (this.done) { throw new Error('AF: waiter is not released'); }
    this.done = true;
    this.resolve();
  }
}

class ConditionVariable {
  waiters;
  constructor () {
    this.waiters = [];
  }

  /**
   * @param {number} timeout
   * @returns {Promise<void>}
   */
  wait (timeout) {
    const waiter = new Waiter(timeout);
    this.waiters.push(waiter);
    return waiter.promise;
  }

  /**
   * @returns {void}
   */
  broadcast () {
    const list = this.waiters;
    // release this reference before broadcasting; this avoids somehow
    // broadcasting twice during the first broadcast.
    this.waiters = [];
    for (const waiter of list) {
      waiter.release();
    }
  }
}
// A fuse that can be burnt once. As long as it is not burnt, waiters can
// register to be nofitied when the fuse burns. Once burnt, it always notifies
// immediately. Like a combination of a boolean and a ConditionVariable.
//

class Fuse {
  cv;

  burnt;
  constructor () {
    this.burnt = false;
    this.cv = new ConditionVariable();
  }

  /**
   * @param {number} timeout
   * @returns {Promise<void>}
   */
  async wait (timeout) {
    if (this.burnt) { return; }
    await this.cv.wait(timeout);
  }

  /**
   * @returns {void}
   */
  burn () {
    this.burnt = true;
    this.cv.broadcast();
  }

  /**
   * @returns {boolean}
   */
  isBurnt () {
    return this.burnt;
  }
}
module.exports = {
  ConditionVariable,
  Fuse
};
