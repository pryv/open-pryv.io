/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from "node:fs";


class Waiter {
  promise;

  resolve: any;

  reject: any;

  timeout: any;

  done;
  constructor (timeout: any) {
    this.done = false;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      if (timeout != null && timeout > 0) {
        this.timeout = setTimeout(() => this.timeoutFired(), timeout);
      }
    });
  }

  timeoutFired () {
    this.reject(new Error('timeout'));
  }

  release () {
    if (this.done) { throw new Error('AF: waiter is not released'); }
    this.done = true;
    this.resolve();
  }
}

class ConditionVariable {
  waiters: any;
  constructor () {
    this.waiters = [];
  }

  wait (timeout: any) {
    const waiter = new Waiter(timeout);
    this.waiters.push(waiter);
    return waiter.promise;
  }

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

  async wait (timeout: any) {
    if (this.burnt) { return; }
    await this.cv.wait(timeout);
  }

  burn () {
    this.burnt = true;
    this.cv.broadcast();
  }

  isBurnt () {
    return this.burnt;
  }
}
export { ConditionVariable, Fuse };
