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
describe('[PGPF] PostgreSQL PlatformDB conformance', function () {
  before(function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
  });
  conformanceTests(async () => {
    await helpers.dependencies.init();
    const { DBpostgresql } = require('../src/DBpostgresql.ts');
    const db = new DBpostgresql();
    await db.init();
    return db;
  });
  adminStoreConformance(async () => {
    await helpers.dependencies.init();
    const { DBpostgresql } = require('../src/DBpostgresql.ts');
    const db = new DBpostgresql();
    await db.init();
    return db;
  });
  platformConfigConformance(async () => {
    await helpers.dependencies.init();
    const { DBpostgresql } = require('../src/DBpostgresql.ts');
    const db = new DBpostgresql();
    await db.init();
    return db;
  });
});
