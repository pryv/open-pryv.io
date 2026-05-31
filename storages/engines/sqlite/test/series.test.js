/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert');
const cuid = require('cuid');

const helpers = require('../../../test/helpers');
const { SeriesConnectionSQLite } = require('../src/seriesStorage/SeriesConnectionSQLite.ts');
const { validateSeriesConnection } = require('storages/interfaces/seriesStorage/SeriesConnection.ts');

describe('[SQSR] SQLite series', function () {
  let conn;
  let userId;
  const eventId = 'series-evt-' + Date.now();

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'sqlite') return this.skip();
    await helpers.dependencies.init();
    conn = new SeriesConnectionSQLite();
    validateSeriesConnection(conn);
    // Use a fresh cuid as the userId so each run gets its own file (and so
    // we can dropDatabase at teardown to clean up).
    userId = 'sqsrtest-' + cuid.slug();
  });

  after(async function () {
    if (conn) {
      await conn.dropDatabase(userId);
    }
  });

  it('[SQ01] should write a small batch of points', async function () {
    const points = [];
    for (let i = 0; i < 10; i++) {
      points.push({ fields: { value: i * 1.5 }, timestamp: 1000000 + i });
    }
    await conn.writeMeasurement(eventId, points, { database: userId });

    const rows = await conn.query(`SELECT * FROM "${eventId}"`, { database: userId });
    assert.strictEqual(rows.length, 10);
  });

  it('[SQ02] should write a large batch (1200 points) in one call', async function () {
    const eventId2 = 'series-evt-large-' + Date.now();
    const points = [];
    for (let i = 0; i < 1200; i++) {
      points.push({ fields: { value: i }, timestamp: 2000000 + i });
    }
    await conn.writeMeasurement(eventId2, points, { database: userId });

    const rows = await conn.query(`SELECT * FROM "${eventId2}"`, { database: userId });
    assert.strictEqual(rows.length, 1200);
  });

  it('[SQ03] should filter via WHERE time >= / <', async function () {
    const eventId3 = 'series-evt-filter-' + Date.now();
    const points = [];
    for (let i = 0; i < 20; i++) {
      // timestamp in nanoseconds; mimics InfluxDB convention
      points.push({ fields: { value: i }, timestamp: i * 1e9 });
    }
    await conn.writeMeasurement(eventId3, points, { database: userId });

    // SELECT with WHERE time clause — uses InfluxQL-style literal
    // 'YYYY-MM-DD HH:mm:ss.sss' that parseInfluxSelect parses to nanos.
    const rows = await conn.query(
      `SELECT * FROM "${eventId3}" WHERE time >= '1970-01-01 00:00:05.000' AND time < '1970-01-01 00:00:10.000'`,
      { database: userId }
    );
    assert.strictEqual(rows.length, 5); // i=5..9
  });

  it('[SQ04] SHOW MEASUREMENTS lists all event_ids', async function () {
    const measurements = await conn.query('SHOW MEASUREMENTS', { database: userId });
    const names = measurements.map((m) => m.name).sort();
    assert.ok(names.includes(eventId), 'event_id from SQ01 should be present');
    assert.ok(names.length >= 1);
  });

  it('[SQ05] dropMeasurement removes only the named event', async function () {
    const before = await conn.query('SHOW MEASUREMENTS', { database: userId });
    const eventToDrop = before[0]?.name;
    if (!eventToDrop) return; // nothing to drop

    await conn.dropMeasurement(eventToDrop, userId);

    const after = await conn.query('SHOW MEASUREMENTS', { database: userId });
    const afterNames = after.map((m) => m.name);
    assert.ok(!afterNames.includes(eventToDrop), 'dropped event should be gone');
  });

  it('[SQ06] exportDatabase + importDatabase round-trip', async function () {
    const eventId4 = 'series-evt-export-' + Date.now();
    const points = [];
    for (let i = 0; i < 5; i++) {
      points.push({ fields: { value: i, label: 'v' + i }, timestamp: 3000000 + i });
    }
    await conn.writeMeasurement(eventId4, points, { database: userId });

    const exported = await conn.exportDatabase(userId);
    assert.ok(exported.measurements.length >= 1);

    const targetUser = 'sqsrimport-' + cuid.slug();
    await conn.importDatabase(targetUser, exported);

    const importedRows = await conn.query(`SELECT * FROM "${eventId4}"`, { database: targetUser });
    assert.strictEqual(importedRows.length, 5);

    await conn.dropDatabase(targetUser);
  });
});
