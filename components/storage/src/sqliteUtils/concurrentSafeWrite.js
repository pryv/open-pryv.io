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

const WAIT_LIST_MS = [1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, 100];
const logger = require('@pryv/boiler').getLogger('sqliteConcurentWrites');
const { setTimeout } = require('timers/promises');

module.exports = {
  execute,
  initWALAndConcurrentSafeWriteCapabilities
};

/**
 * Init the given DB in WAL and unsafe mode, as we will take care of managing concurrent writes errors.
 */
async function initWALAndConcurrentSafeWriteCapabilities (db) {
  await execute(() => {
    db.pragma('journal_mode = WAL');
  });
  await execute(() => {
    db.pragma('busy_timeout = 0'); // We take care of busy timeout ourselves as long as current driver does not go below the second
  });
  await execute(() => {
    db.unsafeMode(true);
  });
}

/**
 * Executes the given statement function, retrying `retries` times in case of `SQLITE_BUSY`.
 * This is CPU intensive, but tests have shown this solution to be efficient.
 */
async function execute (statement, retries = 100) {
  for (let i = 0; i < retries; i++) {
    try {
      statement();
      return;
    } catch (err) {
      if (err.code !== 'SQLITE_BUSY') {
        throw err;
      }
      const waitTime = i > (WAIT_LIST_MS.length - 1) ? 100 : WAIT_LIST_MS[i];
      await setTimeout(waitTime);
      logger.debug(`SQLITE_BUSY, retrying in ${waitTime} ms`);
    }
  }
  throw new Error(`Failed write action on SQLite after ${retries} retries`);
}
