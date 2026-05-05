/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const helpers = require('../../../test/helpers');
const { DatabasePG } = require('../src/DatabasePG');
const { PGSeriesConnection } = require('../src/pg_connection');

describe('[PGSR] PostgreSQL series', function () {
  let conn;
  const userId = 'test-series-' + Date.now();
  const eventId = 'series-evt-' + Date.now();

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await helpers.dependencies.init();
    const db = new DatabasePG(helpers.config);
    await db.waitForConnection();
    conn = new PGSeriesConnection(db);
  });

  after(async function () {
    if (conn) {
      await conn.dropMeasurement(eventId, userId);
    }
  });

  it('[SR01] should write a small batch of points', async function () {
    const points = [];
    for (let i = 0; i < 10; i++) {
      points.push({ fields: { value: i * 1.5 }, timestamp: 1000000 + i });
    }
    await conn.writeMeasurement(eventId, points, { database: userId });

    const result = await conn.db.query(
      `SELECT * FROM series_data WHERE user_id = '${userId}' AND event_id = '${eventId}'`
    );
    assert.strictEqual(result.rows.length, 10);
  });

  it('[SR02] should write a large batch (1000+ points) in one call', async function () {
    const points = [];
    for (let i = 0; i < 1200; i++) {
      points.push({ fields: { value: i }, timestamp: 2000000 + i });
    }
    await conn.writeMeasurement(eventId, points, { database: userId });

    const result = await conn.db.query(
      `SELECT count(*) FROM series_data WHERE user_id = '${userId}' AND event_id = '${eventId}'`
    );
    // 10 from SR01 + 1200 from this test
    assert.strictEqual(parseInt(result.rows[0].count), 1210);
  });

  it('[SR03] should upsert on conflict', async function () {
    const points = [
      { fields: { value: 999 }, timestamp: 1000000 } // same timestamp as SR01's first point
    ];
    await conn.writeMeasurement(eventId, points, { database: userId });

    const result = await conn.db.query(
      `SELECT fields FROM series_data WHERE user_id = '${userId}' AND event_id = '${eventId}' AND point_time = 1000000`
    );
    assert.strictEqual(result.rows.length, 1);
    const fields = result.rows[0].fields;
    assert.strictEqual(fields.value, 999); // updated, not duplicated
  });

  it('[SR04] should read back via InfluxQL-like query', async function () {
    const result = await conn.db.query(
      `SELECT * FROM series_data WHERE user_id = '${userId}' AND event_id = '${eventId}' ORDER BY point_time LIMIT 5`
    );
    assert.strictEqual(result.rows.length, 5);
    assert(result.rows[0].point_time <= result.rows[1].point_time, 'should be sorted by time');
  });

  it('[SR05] should drop measurement', async function () {
    await conn.dropMeasurement(eventId, userId);
    const result = await conn.db.query(
      `SELECT count(*) FROM series_data WHERE user_id = '${userId}' AND event_id = '${eventId}'`
    );
    assert.strictEqual(parseInt(result.rows[0].count), 0);
  });
});
