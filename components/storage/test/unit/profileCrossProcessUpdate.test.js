/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Read-modify-write updates from several OS processes on one item lose no
 * update. Each child increments the same value through findOneAndUpdate; on
 * SQLite the update reads the row then writes it, so without a transaction
 * spanning both, processes overwrite each other's increments.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cuid = require('cuid');
const { fromCallback } = require('utils');
const storage = require('storage');

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../support/incWorker.js');

describe('[PXPU] read-modify-write across processes (profile)', function () {
  this.timeout(120000);

  it('[PXP1] concurrent increments from 4 processes all land', async function () {
    await storage.userLocalDirectory.init();
    const profile = (await storage.getStorageLayer()).profile;
    const userId = cuid();
    await fromCallback((cb) => profile.insertOne(userId, { id: 'counter', data: { count: 0 } }, cb));
    const PROCS = 4;
    const TIMES = 60;
    const runs = Array.from({ length: PROCS }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [WORKER, userId, 'counter', String(TIMES)], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exit ${code}: ${stderr.slice(-2000)}`)));
    }));
    await Promise.all(runs);
    const item = await fromCallback((cb) => profile.findOne(userId, { id: 'counter' }, null, cb));
    await fromCallback((cb) => profile.removeAll(userId, cb));
    assert.strictEqual(item.data.count, PROCS * TIMES, 'every increment from every process must land');
  });
});
