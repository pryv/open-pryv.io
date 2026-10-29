/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('../../../test/helpers');
const { DatabasePG } = require('../src/DatabasePG.ts');
const { PGSeriesConnection } = require('../src/pg_connection.ts');

describe('[PGSR] PostgreSQL series', function () {
  let conn;
  const userId = 'test-series-' + Date.now();
  const eventId = 'series-evt-' + Date.now();

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await helpers.dependencies.init();
    const db = new DatabasePG(helpers.state.config);
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

  it('[SRMV1] renameDatabase moves every point to the target, keeping the target\'s on a clash', async function () {
    const from = 'user.srmvfrom' + Date.now();
    const to = 'user.srmvto' + Date.now();
    const point = (value, timestamp) => ({ fields: { value }, timestamp });
    await conn.writeMeasurement('event.a', [point(1, 1000), point(2, 2000)], { database: from });
    await conn.writeMeasurement('event.b', [point(3, 1000)], { database: from });
    await conn.writeMeasurement('event.a', [point(20, 2000), point(30, 3000)], { database: to });
    await conn.renameDatabase(from, to);
    const left = await conn.db.query('SELECT count(*) FROM series_data WHERE user_id = $1', [from]);
    assert.strictEqual(parseInt(left.rows[0].count), 0, 'nothing left under the former namespace');
    const rows = await conn.db.query('SELECT event_id, point_time, fields FROM series_data WHERE user_id = $1 ORDER BY event_id, point_time', [to]);
    assert.deepStrictEqual(rows.rows.map((r) => [r.event_id, Number(r.point_time), r.fields.value]),
      [['event.a', 1000, 1], ['event.a', 2000, 20], ['event.a', 3000, 30], ['event.b', 1000, 3]]);
    await conn.renameDatabase('user.srmvnone' + Date.now(), to); // nothing to move
    await conn.dropDatabase(to);
  });
});
