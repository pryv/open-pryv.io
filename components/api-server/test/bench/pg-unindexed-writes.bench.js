/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Bench (not part of the test matrix): cost of the PostgreSQL refusal of rows
 * for an unindexed user id (the `refuse_unindexed_user` insert trigger).
 *
 * Measures, with the trigger enabled and disabled in alternating rounds on
 * the same database and the same account:
 *   1. API batch calls of `events.create` (the user-facing throughput);
 *   2. `mall.events.create` one by one (storage level, no HTTP);
 *   3. a set-based `INSERT ... SELECT` of rows into `events` (the trigger's
 *      own per-row cost, nothing else around it).
 * Reports medians and the slowdown of each. Single writer: concurrent writers
 * are measured by pg-unindexed-writes-concurrent.bench.js. The trigger is
 * enabled again at the end, also when the run is killed
 * (guard-trigger-toggle.js).
 *
 * Run from components/api-server, PostgreSQL engine, test database:
 *   STORAGE_ENGINE=postgresql NODE_ENV=test npx mocha --no-config --exit \
 *     --require test-helpers/src/helpers-c.ts --timeout 0 test/bench/pg-unindexed-writes.bench.js
 * Knobs: BENCH_BATCH (events per batch call, 500), BENCH_ROUNDS (rounds per
 * side, 8), BENCH_SQL_ROWS (rows per set-based insert, 10000).
 */

/* global initTests, initCore, coreRequest, getNewFixture */

import assert from 'node:assert';
import cuid from 'cuid';
import * as storages from 'storages';
import { getMall } from 'mall';
import { guardTriggerToggle } from './guard-trigger-toggle.js';

const BATCH = Number(process.env.BENCH_BATCH || 500);
const ROUNDS = Number(process.env.BENCH_ROUNDS || 8);
const SQL_ROWS = Number(process.env.BENCH_SQL_ROWS || 10000);

function median (values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

describe('[PGUB] bench: PostgreSQL refusal of unindexed user rows', function () {
  let db, toggle, fixtures, username, userId, token, streamId;

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await initTests();
    await initCore();
    db = storages.databasePG;
    toggle = guardTriggerToggle(db);
    // Installed by the boot; also enables a trigger an interrupted run left disabled.
    await db.ensureUnindexedWritesGuard();
    username = 'pgub' + cuid.slug().toLowerCase();
    token = cuid();
    fixtures = getNewFixture();
    const user = await fixtures.user(username);
    userId = user.attrs.id;
    await user.access({ token, type: 'personal' });
    await user.session(token);
    streamId = 'pgub-' + cuid.slug();
    const res = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id: streamId, name: 'PGUB' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  });

  after(async function () {
    if (db == null) return;
    const state = await toggle.restore();
    console.log(`PGUB events guard trigger at the end: tgenabled ${state}`);
    assert.strictEqual(state, 'O');
    // Rows written without the API carry no integrity: removed before the
    // suite's integrity check.
    await db.query("DELETE FROM events WHERE user_id = $1 AND id LIKE 'pgub-%'", [userId]);
    await fixtures?.clean();
  });

  async function setTrigger (on) {
    await toggle.set(on);
  }

  async function apiBatch () {
    const calls = Array.from({ length: BATCH }, (_, i) => ({ method: 'events.create', params: { streamIds: [streamId], type: 'note/txt', content: 'pgub ' + i } }));
    const t0 = process.hrtime.bigint();
    const res = await coreRequest.post('/' + username).set('Authorization', token).send(calls);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.strictEqual(res.status, 200, JSON.stringify(res.body).slice(0, 500));
    const failed = res.body.results.filter((r) => r.error != null);
    assert.deepStrictEqual(failed.slice(0, 1), [], 'batch errors');
    return BATCH / (ms / 1000);
  }

  async function mallLoop () {
    const mall = await getMall();
    const n = Math.max(100, Math.floor(BATCH / 2));
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) {
      await mall.events.create(userId, { id: cuid(), streamIds: [streamId], type: 'note/txt', content: 'pgub mall ' + i, time: Date.now() / 1000, created: Date.now() / 1000, createdBy: 'bench', modified: Date.now() / 1000, modifiedBy: 'bench' });
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return n / (ms / 1000);
  }

  // Rolled back: the table does not grow from one round to the next. The
  // plan's own figures give the trigger's share of the statement.
  async function sqlInsert () {
    const prefix = 'pgub-sql-' + cuid.slug() + '-';
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) INSERT INTO events (user_id, id, stream_ids, time, type, content, created, created_by, modified, modified_by)
         SELECT $1, $2 || g, '["${streamId}"]'::jsonb, g, 'note/txt', '"x"'::jsonb, g, 'bench', g, 'bench'
         FROM generate_series(1, $3::int) AS g`, [userId, prefix, SQL_ROWS]);
      await client.query('ROLLBACK');
      const plan = res.rows[0]['QUERY PLAN'][0];
      const trig = (plan.Triggers || []).find((t) => t['Trigger Name'] === 'refuse_unindexed_user');
      return { rowsPerS: SQL_ROWS / (plan['Execution Time'] / 1000), triggerUsPerRow: trig ? (trig.Time * 1000) / trig.Calls : 0, triggerShare: trig ? trig.Time / plan['Execution Time'] : 0 };
    } finally {
      client.release();
    }
  }

  async function measure (label, fn, pick = (x) => x) {
    // Warm both sides once, then alternate the order each round.
    await setTrigger(false); await fn();
    await setTrigger(true); await fn();
    const on = [];
    const off = [];
    for (let r = 0; r < ROUNDS; r++) {
      for (const side of (r % 2 === 0 ? [false, true] : [true, false])) {
        await setTrigger(side);
        (side ? on : off).push(pick(await fn()));
      }
    }
    await setTrigger(true);
    const mOn = median(on);
    const mOff = median(off);
    const slowdown = ((mOff - mOn) / mOff) * 100;
    // Each round's two sides ran back to back: their ratio cancels the
    // machine's load drift between rounds.
    const paired = on.map((v, i) => (1 - v / off[i]) * 100).sort((a, b) => a - b);
    const q = (p) => paired[Math.min(paired.length - 1, Math.floor(p * paired.length))];
    console.log(`PGUB ${label}: trigger off ${mOff.toFixed(1)} /s, on ${mOn.toFixed(1)} /s, slowdown of the medians ${slowdown.toFixed(2)}%, ` +
      `paired slowdown median ${median(paired).toFixed(2)}% (quartiles ${q(0.25).toFixed(2)}% .. ${q(0.75).toFixed(2)}%, mean ${(paired.reduce((a, b) => a + b, 0) / paired.length).toFixed(2)}%) ` +
      `(${ROUNDS} rounds; off ${off.map((v) => v.toFixed(0)).join(',')}; on ${on.map((v) => v.toFixed(0)).join(',')})`);
    return { mOn, mOff, slowdown, pairedMedian: median(paired) };
  }

  it('[PGUB1] API batch events.create', async function () {
    await measure(`API batch of ${BATCH} events.create (events/s)`, apiBatch);
  });

  it('[PGUB2] mall.events.create one by one', async function () {
    await measure('mall.events.create sequential (events/s)', mallLoop);
  });

  it('[PGUB3] set-based INSERT into events', async function () {
    const r = await measure(`INSERT ... SELECT of ${SQL_ROWS} rows (rows/s)`, sqlInsert, (x) => x.rowsPerS);
    const usPerRow = (1e6 / r.mOn) - (1e6 / r.mOff);
    console.log(`PGUB trigger cost per row from the throughputs: ${usPerRow.toFixed(2)} us`);
    await setTrigger(true);
    const samples = [];
    for (let i = 0; i < ROUNDS; i++) samples.push(await sqlInsert());
    console.log(`PGUB trigger time per row (EXPLAIN ANALYZE, median of ${ROUNDS}): ${median(samples.map((s) => s.triggerUsPerRow)).toFixed(2)} us, ` +
      `share of the insert statement ${(100 * median(samples.map((s) => s.triggerShare))).toFixed(1)}%`);
  });

  it('[PGUB5] trigger time of single-row inserts, each in its own transaction (as events.create writes them)', async function () {
    await setTrigger(true);
    const n = Math.max(200, BATCH);
    const times = [];
    const exec = [];
    for (let i = 0; i < n; i++) {
      const res = await db.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) INSERT INTO events (user_id, id, stream_ids, time, type, content, created, created_by, modified, modified_by)
         VALUES ($1, $2, '["${streamId}"]'::jsonb, 1, 'note/txt', '"x"'::jsonb, 1, 'bench', 1, 'bench')`, [userId, 'pgub-one-' + cuid()]);
      const plan = res.rows[0]['QUERY PLAN'][0];
      const trig = (plan.Triggers || []).find((t) => t['Trigger Name'] === 'refuse_unindexed_user');
      times.push(trig.Time * 1000);
      exec.push(plan['Execution Time'] * 1000);
    }
    const apiPerEventUs = 1e6 / (await apiBatch());
    const t = median(times);
    console.log(`PGUB single-row insert: trigger ${t.toFixed(1)} us (median of ${n}; p90 ${[...times].sort((a, b) => a - b)[Math.floor(n * 0.9)].toFixed(1)} us), ` +
      `statement ${median(exec).toFixed(1)} us; API batch events.create ${apiPerEventUs.toFixed(0)} us per event: ` +
      `trigger share ${(100 * t / apiPerEventUs).toFixed(2)}%`);
  });

  it('[PGUB4] API single events.create calls', async function () {
    const n = Math.max(50, Math.floor(BATCH / 5));
    await measure(`API events.create one call each, ${n} calls (events/s)`, async () => {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < n; i++) {
        const res = await coreRequest.post('/' + username + '/events').set('Authorization', token).send({ streamIds: [streamId], type: 'note/txt', content: 'pgub one ' + i });
        assert.strictEqual(res.status, 201);
      }
      return n / (Number(process.hrtime.bigint() - t0) / 1e9);
    });
  });
});
