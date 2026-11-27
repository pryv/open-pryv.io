/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('../../../test/helpers');
const conformanceTests = require('platform/test/conformance/PlatformDB.test').default;
const adminStoreConformance = require('business/test/conformance/adminStore.js').default;
const platformConfigConformance = require('business/test/conformance/platformConfig.js').default;

// Exercises the PostgreSQL PlatformDB implementation directly (platform_kv
// table), independently of which platform engine the running config selects
// — the barrel's `storages.platformDB` stays rqlite-backed in the default
// test matrix.
//
// These suites wipe the table between tests: they run only when it holds no
// row of anyone else (else skipped, and the skip says why), so a wipe never
// takes another suite's or a running core's rows.
describe('[PGPF] PostgreSQL PlatformDB conformance', function () {
  async function newDB () {
    await helpers.dependencies.init();
    const { DBpostgresql } = require('../src/DBpostgresql.ts');
    const db = new DBpostgresql();
    await db.init();
    return db;
  }

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    const rows = (await (await newDB()).listAllPlatformKvEntries()).length;
    if (rows > 0) {
      console.warn(`  SKIPPED [PGPF]: the PostgreSQL platform_kv table holds ${rows} row(s) of other suites; ` +
        'these suites wipe it between tests, so they run on an empty table only');
      return this.skip();
    }
  });
  conformanceTests(newDB);
  adminStoreConformance(newDB);
  platformConfigConformance(newDB);
});
