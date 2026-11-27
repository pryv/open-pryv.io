/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { startPrivateRqlite } from '../../../test/helpers/privateRqlite.js';
const require = createRequire(import.meta.url);
require('test-helpers/src/api-server-tests-config.ts');
const { DBrqlite } = require('../src/DBrqlite.ts');
const conformanceTests = require('platform/test/conformance/PlatformDB.test').default;
const adminStoreConformance = require('business/test/conformance/adminStore.js').default;
const platformConfigConformance = require('business/test/conformance/platformConfig.js').default;

// These suites wipe their store between tests: they run on a private rqlited
// of their own, never on the rqlite the other suites use (a wipe there would
// leave their accounts without platform rows).
describe('[RQPF] rqlite PlatformDB conformance', function () {
  this.timeout(60000);
  let rqlite;

  before(async function () {
    rqlite = await startPrivateRqlite(this, '[RQPF] rqlite PlatformDB conformance');
  });

  after(async function () {
    if (rqlite != null) await rqlite.stop();
  });

  async function newDB () {
    const db = new DBrqlite(rqlite.url);
    await db.init();
    return db;
  }

  conformanceTests(newDB);
  adminStoreConformance(newDB);
  platformConfigConformance(newDB);
});
