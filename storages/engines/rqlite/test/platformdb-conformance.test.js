/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { DBrqlite } = require('../src/DBrqlite');
const conformanceTests = require('platform/test/conformance/PlatformDB.test');

// rqlite must be running on localhost:4001 for these tests.
// Start with: rqlited -node-id 1 /tmp/rqlite-test-node
const RQLITE_URL = process.env.RQLITE_URL || 'http://localhost:4001';

describe('[RQPF] rqlite PlatformDB conformance', () => {
  let db;

  before(async function () {
    // Check if rqlite is reachable
    try {
      const res = await fetch(RQLITE_URL + '/status');
      if (!res.ok) throw new Error('rqlite not ready');
    } catch (e) {
      this.skip(); // Skip tests if rqlite is not running
    }
  });

  conformanceTests(async () => {
    db = new DBrqlite(RQLITE_URL);
    await db.init();
    return db;
  });
});
