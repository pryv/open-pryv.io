/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [PSEL] — barrel-level platform-engine selection.
 *
 * `storages.platform.engine: postgresql` must make the barrel build the
 * PostgreSQL PlatformDB (platform_kv table) instead of rqlite — the
 * single-core diskless deployment shape. Exercises the full path:
 * pluginLoader.resolveConfig → getEngineFor('platformStorage') →
 * engine createPlatformDB() → init() → validatePlatformDB.
 */

require('test-helpers/src/api-server-tests-config.ts');

const assert = require('node:assert');
const { getConfig } = require('@pryv/boiler');

describe('[PSEL] storages barrel — platform engine selection', () => {
  let storages;

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    storages = require('storages');
  });

  after(async () => {
    if (!storages) return;
    // Restore the default-config barrel state for subsequent tests.
    storages.reset();
    await storages.init();
  });

  it('[PSL1] platform engine postgresql → barrel platformDB is the PG implementation', async () => {
    const realConfig = await getConfig();
    const overrides = { 'storages:platform:engine': 'postgresql' };
    const config = {
      get: (key) => key in overrides ? overrides[key] : realConfig.get(key),
      has: (key) => key in overrides ? true : realConfig.has(key)
    };

    storages.reset();
    await storages.init(config);

    const { DBpostgresql } = require('../engines/postgresql/src/DBpostgresql.ts');
    assert.ok(storages.platformDB instanceof DBpostgresql,
      `expected DBpostgresql, got ${storages.platformDB?.constructor?.name}`);

    // Round-trip through the selected implementation.
    await storages.platformDB.setUserUniqueField('psel-user', 'email', 'psel@example.com');
    assert.strictEqual(await storages.platformDB.getUsersUniqueField('email', 'psel@example.com'), 'psel-user');
    await storages.platformDB.deleteUserUniqueField('email', 'psel@example.com');
    assert.strictEqual(await storages.platformDB.getUsersUniqueField('email', 'psel@example.com'), null);
  });
});
