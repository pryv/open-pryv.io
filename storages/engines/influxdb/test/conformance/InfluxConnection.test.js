/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * InfluxConnection conformance test suite.
 * Tests: validate, createDatabase, writeMeasurement, query, dropMeasurement,
 * dropDatabase, exportDatabase, importDatabase.
 *
 * Requires InfluxDB running locally.
 *
 * @param {Function} getConnection - function returning an InfluxConnection instance
 */
module.exports = function conformanceTests (getConnection) {
  const assert = require('node:assert');
  const { validateSeriesConnection: validateInfluxConnection } = require('storages/interfaces/seriesStorage/SeriesConnection');

  const testDbName = 'pryv_test_conformance_influx';

  describe('InfluxConnection conformance', () => {
    let conn;

    before(() => {
      conn = getConnection();
    });

    after(async () => {
      try {
        await conn.dropDatabase(testDbName);
      } catch (e) {
        // ignore cleanup errors
      }
      try {
        await conn.dropDatabase(testDbName + '_import');
      } catch (e) {
        // ignore cleanup errors
      }
    });

    it('[IC01] must pass validateInfluxConnection', () => {
      validateInfluxConnection(conn);
    });

    it('[IC02] createDatabase() must create a database', async () => {
      await conn.createDatabase(testDbName);
      const dbs = await conn.getDatabases();
      assert.ok(dbs.includes(testDbName), 'database must exist after creation');
    });

    it('[IC03] writeMeasurement() must write points', async () => {
      await conn.writeMeasurement('cpu', [
        { fields: { value: 42 }, timestamp: '1000000000000000000' }
      ], { database: testDbName });
    });

    it('[IC04] query() must return written data', async () => {
      const results = await conn.query('SELECT * FROM cpu', { database: testDbName });
      assert.ok(Array.isArray(results));
      assert.ok(results.length >= 1);
      assert.strictEqual(results[0].value, 42);
    });

    it('[IC05] writePoints() must write multiple points', async () => {
      await conn.writePoints([
        { measurement: 'memory', fields: { used: 1024 }, timestamp: '1000000000000000000' },
        { measurement: 'memory', fields: { used: 2048 }, timestamp: '2000000000000000000' }
      ], { database: testDbName });
      const results = await conn.query('SELECT * FROM memory', { database: testDbName });
      assert.ok(results.length >= 2);
    });

    it('[IC06] dropMeasurement() must remove a measurement', async () => {
      await conn.dropMeasurement('memory', testDbName);
      const results = await conn.query('SHOW MEASUREMENTS', { database: testDbName });
      const names = results.map((r) => r.name);
      assert.ok(!names.includes('memory'), 'measurement must be removed');
    });

    it('[IC07] exportDatabase() must return measurements and points', async () => {
      const data = await conn.exportDatabase(testDbName);
      assert.ok(data.measurements);
      assert.ok(Array.isArray(data.measurements));
      assert.ok(data.measurements.length >= 1);
      const cpuMeasurement = data.measurements.find((m) => m.measurement === 'cpu');
      assert.ok(cpuMeasurement, 'must include cpu measurement');
      assert.ok(cpuMeasurement.points.length >= 1);
    });

    it('[IC08] importDatabase() must import data into a new database', async () => {
      const data = await conn.exportDatabase(testDbName);
      const importDbName = testDbName + '_import';
      await conn.importDatabase(importDbName, data);
      const results = await conn.query('SELECT * FROM cpu', { database: importDbName });
      assert.ok(results.length >= 1);
      assert.strictEqual(results[0].value, 42);
    });

    it('[IC09] dropDatabase() must remove a database', async () => {
      await conn.dropDatabase(testDbName);
      const dbs = await conn.getDatabases();
      assert.ok(!dbs.includes(testDbName), 'database must be removed');
    });
  });
};
