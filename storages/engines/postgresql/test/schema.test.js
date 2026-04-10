/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const helpers = require('../../../test/helpers');
const DatabasePG = require('../src/DatabasePG');

describe('[PGSC] PostgreSQL schema', function () {
  let db;

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await helpers.dependencies.init();
    db = new DatabasePG(helpers.config);
    await db.waitForConnection();
  });

  it('[PG01] should have all required tables', async function () {
    const res = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    const tables = res.rows.map(r => r.table_name);
    assert(tables.includes('events'), 'missing events table');
    assert(tables.includes('streams'), 'missing streams table');
    assert(tables.includes('event_streams'), 'missing event_streams table');
    assert(tables.includes('accesses'), 'missing accesses table');
    assert(tables.includes('series_data'), 'missing series_data table');
    assert(tables.includes('audit_events'), 'missing audit_events table');
  });

  it('[PG02] should have required indexes on events', async function () {
    const res = await db.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'events' ORDER BY indexname"
    );
    const indexes = res.rows.map(r => r.indexname);
    assert(indexes.includes('idx_event_time'), 'missing idx_event_time');
    assert(indexes.includes('idx_event_trashed'), 'missing idx_event_trashed');
    assert(indexes.includes('idx_event_modified'), 'missing idx_event_modified');
    assert(indexes.includes('idx_event_head_id'), 'missing idx_event_head_id');
    assert(indexes.includes('idx_event_endtime'), 'missing idx_event_endtime');
  });

  it('[PG03] should have composite index on event_streams', async function () {
    const res = await db.query(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'event_streams' AND indexname = 'idx_es_stream'"
    );
    assert.strictEqual(res.rows.length, 1, 'idx_es_stream must exist');
    // Composite index should include event_id for index-only scans
    assert(res.rows[0].indexdef.includes('event_id'), 'idx_es_stream should include event_id');
  });

  it('[PG04] should execute basic CRUD on events table', async function () {
    const userId = 'test-schema-' + Date.now();
    const eventId = 'evt-' + Date.now();

    // INSERT
    await db.query(
      `INSERT INTO events (user_id, id, stream_ids, type, content, time, created, created_by, modified, modified_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [userId, eventId, '["test-stream"]', 'note/txt', '{"text":"hello"}', 1000, 1000, 'test', 1000, 'test']
    );

    // SELECT
    const res = await db.query('SELECT * FROM events WHERE user_id = $1 AND id = $2', [userId, eventId]);
    assert.strictEqual(res.rows.length, 1);
    assert.strictEqual(res.rows[0].type, 'note/txt');

    // DELETE
    await db.query('DELETE FROM events WHERE user_id = $1', [userId]);
    const check = await db.query('SELECT count(*) FROM events WHERE user_id = $1', [userId]);
    assert.strictEqual(parseInt(check.rows[0].count), 0);
  });
});
