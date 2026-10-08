/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { produceStorageConnection } = require('./test-helpers');

// The class each series engine connects through.
const SERIES_CONNECTION_CLASS = {
  postgresql: 'PGSeriesConnection',
  sqlite: 'SeriesConnectionSQLite',
  influxdb: 'InfluxConnection'
};

/**
 * [HFSE] These tests boot without helpers-base, so they once ignored the
 * engine `just test-sqlite` selects and ran on PostgreSQL: check that the
 * engines actually loaded are the ones the run asked for.
 */
describe('[HFSE] storage engine of the run', function () {
  it('[HFSE1] base and series storage use the engines STORAGE_ENGINE selects', async function () {
    await produceStorageConnection(); // initialises the storages
    const storages = require('storages');
    const base = process.env.STORAGE_ENGINE || 'postgresql';
    const series = process.env.storages__series__engine || base;
    assert.strictEqual(storages.pluginLoader.getEngineFor('baseStorage'), base);
    assert.strictEqual(storages.pluginLoader.getEngineFor('seriesStorage'), series);
    assert.strictEqual(storages.seriesConnection?.constructor.name, SERIES_CONNECTION_CLASS[series]);
  });
});
