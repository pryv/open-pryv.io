/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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
