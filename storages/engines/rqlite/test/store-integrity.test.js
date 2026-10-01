/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import assert from 'node:assert';
const require = createRequire(import.meta.url);
const { DBrqlite } = require('../src/DBrqlite.ts');

// checkStoreIntegrity() reads THIS node's file (`level=none`) and must not
// report a healthy store as corrupted when rqlite answers without running the
// PRAGMA (empty `results`, e.g. during an election): that is "not checked".
describe('[RQSI] rqlite checkStoreIntegrity', () => {
  let originalFetch;
  let urls;

  function stubFetch (results) {
    urls = [];
    originalFetch = global.fetch;
    global.fetch = async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ results }) };
    };
  }

  afterEach(() => { global.fetch = originalFetch; });

  it('[RQSI1] an empty answer to the PRAGMA rejects instead of reporting a corruption', async () => {
    stubFetch([]);
    const db = new DBrqlite('http://rqlite.invalid:4001');
    await assert.rejects(db.checkStoreIntegrity(), /no row/);
  });

  it('[RQSI2] both queries are node-local reads (level=none)', async () => {
    stubFetch([{ columns: ['integrity_check'], values: [['ok']] }]);
    const db = new DBrqlite('http://rqlite.invalid:4001');
    await db.checkStoreIntegrity();
    assert.strictEqual(urls.length, 2);
    for (const url of urls) assert.match(url, /\/db\/query\?.*level=none/);
  });
});
