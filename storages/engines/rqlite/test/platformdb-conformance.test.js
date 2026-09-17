/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('test-helpers/src/api-server-tests-config.ts');
const { getConfigUnsafe } = require('@pryv/boiler');
const { DBrqlite } = require('../src/DBrqlite.ts');
const conformanceTests = require('platform/test/conformance/PlatformDB.test').default;

// Target the rqlite the test config points at (config/test-config.yml, or its
// `storages__engines__rqlite__url` env mirror). A hardcoded canonical port
// would silently hit another checkout's rqlite when several run side by side.
// Start it with: storages/engines/rqlite/scripts/start
const RQLITE_URL = process.env.RQLITE_URL ||
  getConfigUnsafe(true).get('storages:engines:rqlite:url') ||
  'http://localhost:4001';

describe('[RQPF] rqlite PlatformDB conformance', () => {
  let db;

  before(async function () {
    // Fail, don't skip: a skipped conformance suite reports green while
    // proving nothing about the engine.
    let res;
    try {
      res = await fetch(RQLITE_URL + '/status');
    } catch (e) {
      throw new Error(`rqlite not reachable at ${RQLITE_URL}: ${e.message}`);
    }
    if (!res.ok) throw new Error(`rqlite not ready at ${RQLITE_URL}: HTTP ${res.status}`);
  });

  conformanceTests(async () => {
    db = new DBrqlite(RQLITE_URL);
    await db.init();
    return db;
  });
});
