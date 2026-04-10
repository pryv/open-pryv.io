/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const WAIT_LIST_MS = [1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, 100];
const _internals = require('./_internals');
const logger = _internals.lazyLogger('sqliteConcurentWrites');
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
