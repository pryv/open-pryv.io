/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Skip Mongo engine tests when running in non-Mongo mode.
// Mirrors the skip guard in storages/engines/postgresql/test/global.test.js.
// Since Plan 49 (PG is the default baseStorage), under `just test all`
// STORAGE_ENGINE=postgresql is set and we must opt out here; under
// `just test-mongo all` STORAGE_ENGINE=mongodb so these tests run.
const engine = process.env.STORAGE_ENGINE || '';
if (engine !== 'mongodb') {
  before(function () { this.skip(); });
} else {
  const helpers = require('../../../test/helpers');
  helpers.config = helpers.getEngineConfig('mongodb', require('../manifest.json'));

  before(async function () {
    // Force baseStorage back to mongodb for this engine's tests — the live
    // default-config.yml value is `postgresql` since Plan 49, and `storages.init()`
    // reads it from the boiler config. Without this override, `dependencies.init()`
    // would register `databasePG` instead of `database`, and `getInternals(manifest)`
    // would fail to resolve the `database` internal the mongodb engine requires.
    const { getConfigUnsafe } = require('@pryv/boiler');
    const cfg = getConfigUnsafe(true);
    cfg.set('storages:base:engine', 'mongodb');

    await helpers.dependencies.init();
  });
}
