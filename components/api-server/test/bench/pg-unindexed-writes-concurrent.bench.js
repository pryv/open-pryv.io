/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Bench (not part of the test matrix): cost of the PostgreSQL refusal of rows
 * for an unindexed user id (the `refuse_unindexed_user` insert trigger) with
 * N writers in parallel, on ONE account (every insert locks the same
 * `users_index` row: MultiXacts when they overlap) and on N separate
 * accounts, trigger enabled and disabled in alternating rounds.
 *
 *   [PGUC1] N parallel API batch calls of `events.create` (in-process core);
 *   [PGUC2] N connections each writing events as `events.create` does, one
 *           autocommit statement at a time (the events row, then its
 *           `event_streams` link): the database side alone, no Node work in
 *           between, so the most contention a writer count can produce.
 *
 * Per scenario and N: median wall time per event on each side, slowdown of
 * the medians and paired slowdown, errors by SQLSTATE, MultiXacts consumed,
 * WAL bytes per event, and the backends seen waiting on a lock (sampled).
 * The trigger is enabled again at the end, also when the run is killed
 * (guard-trigger-toggle.js), and its state is printed.
 *
 * Run from components/api-server, PostgreSQL engine, test database:
 *   STORAGE_ENGINE=postgresql NODE_ENV=test npx mocha --no-config --exit \
 *     --require test-helpers/src/helpers-c.ts --timeout 0 test/bench/pg-unindexed-writes-concurrent.bench.js
 * Knobs: BENCH_WRITERS (writer counts, "1,4,8,16"), BENCH_ROUNDS (rounds per
 * side, 5), BENCH_BATCH (events per API batch call, 200), BENCH_SQL_EVENTS
 * (events per writer per SQL round, 500), BENCH_GUARD_BODY (`advisory`, the
 * installed body, or `rowlock`, the row-lock body of the previous release:
 * compare two runs). The installed body is put back at the end; a killed run
 * leaves the row-lock body until the next boot, which reinstalls it.
 */

/* global initTests, initCore, coreRequest, getNewFixture */

import assert from 'node:assert';
import cuid from 'cuid';
import pg from 'pg';
import * as storages from 'storages';
import { guardTriggerToggle } from './guard-trigger-toggle.js';
import { ROW_LOCK_FUNCTION_SQL } from '../../../../storages/engines/postgresql/src/unindexedWritesGuard.ts';

const GUARD_BODY = process.env.BENCH_GUARD_BODY || 'advisory';

const WRITERS = (process.env.BENCH_WRITERS || '1,4,8,16').split(',').map(Number);
const ROUNDS = Number(process.env.BENCH_ROUNDS || 5);
const BATCH = Number(process.env.BENCH_BATCH || 200);
const SQL_EVENTS = Number(process.env.BENCH_SQL_EVENTS || 500);
const MAX_N = Math.max(...WRITERS);

function median (values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

describe('[PGUC] bench: PostgreSQL refusal of unindexed user rows, concurrent writers', function () {
  let db, toggle, pool, fixtures;
  const accounts = [];
  const results = [];
  const errorSamples = [];

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await initTests();
    await initCore();
    db = storages.databasePG;
    toggle = guardTriggerToggle(db);
    // The boot enables a guard trigger an earlier run left disabled.
    console.log(`PGUC events guard trigger after the boot: tgenabled ${await toggle.state()}`);
    await db.ensureUnindexedWritesGuard();
    if (GUARD_BODY === 'rowlock') await db.query(ROW_LOCK_FUNCTION_SQL);
    else assert.strictEqual(GUARD_BODY, 'advisory', 'BENCH_GUARD_BODY: advisory or rowlock');
    console.log(`PGUC guard body under test: ${GUARD_BODY}`);
    const { host, port, database, user, password } = db.poolConfig;
    pool = new pg.Pool({ host, port, database, user, password, max: MAX_N + 2 });
    fixtures = getNewFixture();
    for (let i = 0; i < MAX_N; i++) {
      const username = 'pguc' + cuid.slug().toLowerCase() + i;
      const token = cuid();
      const user = await fixtures.user(username);
      await user.access({ token, type: 'personal' });
      await user.session(token);
      const streamId = 'pguc-' + cuid.slug();
      const res = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id: streamId, name: 'PGUC ' + i });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const path = (await db.query('SELECT path FROM streams WHERE user_id = $1 AND id = $2', [user.attrs.id, streamId])).rows[0]?.path ?? streamId + '/';
      accounts.push({ username, userId: user.attrs.id, token, streamId, path });
    }
  });

  after(async function () {
    if (db == null) return;
    const state = await toggle.restore();
    await db.ensureUnindexedWritesGuard(); // the installed body back after a row-lock run
    console.log(`PGUC events guard trigger at the end: tgenabled ${state}`);
    console.log('PGUC-JSON ' + JSON.stringify({ guardBody: GUARD_BODY, results }));
    if (errorSamples.length > 0) console.log('PGUC API error samples: ' + JSON.stringify(errorSamples.slice(0, 5)));
    // Rows written without the API carry no integrity: removed before the
    // suite's integrity check.
    for (const a of accounts) {
      await db.query("DELETE FROM event_streams WHERE user_id = $1 AND event_id LIKE 'pguc-%'", [a.userId]);
      await db.query("DELETE FROM events WHERE user_id = $1 AND id LIKE 'pguc-%'", [a.userId]);
    }
    await pool?.end();
    await fixtures?.clean();
    assert.strictEqual(state, 'O');
  });

  async function dbCounters (client) {
    const res = await client.query(
      `SELECT mxid_age('1'::xid) AS mxid, pg_current_wal_lsn() AS lsn,
        (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()) AS deadlocks,
        (SELECT COALESCE(sum(blks_zeroed), 0) FROM pg_stat_slru WHERE name LIKE 'Multi%') AS mx_pages`);
    return res.rows[0];
  }

  /** Samples the backends of this database waiting on a lock while `fn` runs. */
  async function observed (fn) {
    const client = await pool.connect();
    try {
      const before = await dbCounters(client);
      const waits = {};
      let samples = 0;
      const run = { on: true };
      const sampler = (async () => {
        while (run.on) {
          const res = await client.query(
            `SELECT wait_event_type || ':' || wait_event AS w, count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()
               AND wait_event_type IN ('Lock', 'LWLock') GROUP BY 1`);
          samples++;
          for (const r of res.rows) waits[r.w] = (waits[r.w] || 0) + r.n;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();
      let out;
      try {
        out = await fn();
      } finally {
        run.on = false;
        await sampler;
      }
      const after = await dbCounters(client);
      const wal = Number((await client.query('SELECT pg_wal_lsn_diff($1, $2) AS d', [after.lsn, before.lsn])).rows[0].d);
      return {
        ...out,
        multixacts: Number(after.mxid) - Number(before.mxid),
        mxPages: Number(after.mx_pages) - Number(before.mx_pages),
        deadlocksStat: Number(after.deadlocks) - Number(before.deadlocks),
        walBytes: wal,
        lockWaitsPerSample: Object.fromEntries(Object.entries(waits).map(([k, v]) => [k, v / Math.max(1, samples)]))
      };
    } finally {
      client.release();
    }
  }

  function writersFor (n, oneAccount) {
    return Array.from({ length: n }, (_, i) => accounts[oneAccount ? 0 : i]);
  }

  async function apiRound (n, oneAccount) {
    const writers = writersFor(n, oneAccount);
    const errors = {};
    const t0 = process.hrtime.bigint();
    await Promise.all(writers.map(async (a, w) => {
      const calls = Array.from({ length: BATCH }, (_, i) => ({ method: 'events.create', params: { streamIds: [a.streamId], type: 'note/txt', content: `pguc ${w} ${i}` } }));
      const res = await coreRequest.post('/' + a.username).set('Authorization', a.token).send(calls);
      if (res.status !== 200) { errors['http-' + res.status] = (errors['http-' + res.status] || 0) + BATCH; return; }
      for (const r of res.body.results) {
        if (r.error == null) continue;
        errors[r.error.id] = (errors[r.error.id] || 0) + 1;
        errorSamples.push(r.error);
      }
    }));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { events: n * BATCH, ms, errors };
  }

  async function sqlRound (n, oneAccount) {
    const writers = writersFor(n, oneAccount);
    const clients = [];
    for (let i = 0; i < n; i++) clients.push(await pool.connect());
    const errors = {};
    const prefix = 'pguc-' + cuid.slug() + '-';
    try {
      const t0 = process.hrtime.bigint();
      await Promise.all(writers.map(async (a, w) => {
        const c = clients[w];
        for (let i = 0; i < SQL_EVENTS; i++) {
          const id = `${prefix}${w}-${i}`;
          const now = Date.now() / 1000;
          try {
            await c.query(
              `INSERT INTO events (user_id, id, stream_ids, time, type, content, created, created_by, modified, modified_by)
               VALUES ($1, $2, $3::jsonb, $4, 'note/txt', '"x"'::jsonb, $4, 'bench', $4, 'bench')`, [a.userId, id, JSON.stringify([a.streamId]), now]);
            await c.query('DELETE FROM event_streams WHERE user_id = $1 AND event_id = $2', [a.userId, id]);
            await c.query('SELECT path FROM streams WHERE user_id = $1 AND id = $2', [a.userId, a.streamId]);
            await c.query(
              'INSERT INTO event_streams (user_id, event_id, stream_id, stream_path) SELECT $1::text, $2::text, $3::text, $4::text ' +
              'WHERE EXISTS (SELECT 1 FROM events WHERE user_id = $1 AND id = $2 FOR KEY SHARE)', [a.userId, id, a.streamId, a.path]);
          } catch (err) {
            errors[err.code || err.message] = (errors[err.code || err.message] || 0) + 1;
          }
        }
      }));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return { events: n * SQL_EVENTS, ms, errors };
    } finally {
      for (const c of clients) c.release();
    }
  }

  async function measure (scenario, n, oneAccount, round) {
    const fn = () => observed(() => round(n, oneAccount));
    // Warm both sides once, then alternate the order each round.
    await toggle.set(false); await fn();
    await toggle.set(true); await fn();
    const on = [];
    const off = [];
    for (let r = 0; r < ROUNDS; r++) {
      for (const side of (r % 2 === 0 ? [false, true] : [true, false])) {
        await toggle.set(side);
        (side ? on : off).push(await fn());
      }
    }
    await toggle.set(true);
    const usPerEvent = (x) => (x.ms * 1000) / x.events;
    const mOn = median(on.map(usPerEvent));
    const mOff = median(off.map(usPerEvent));
    const paired = on.map((x, i) => (usPerEvent(x) / usPerEvent(off[i]) - 1) * 100);
    const sumErrors = (xs) => xs.reduce((acc, x) => { for (const [k, v] of Object.entries(x.errors)) acc[k] = (acc[k] || 0) + v; return acc; }, {});
    const perEvent = (xs, key) => median(xs.map((x) => x[key] / x.events));
    const waits = (xs) => {
      const acc = {};
      for (const x of xs) for (const [k, v] of Object.entries(x.lockWaitsPerSample)) acc[k] = (acc[k] || 0) + v / xs.length;
      return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, Number(v.toFixed(3))]));
    };
    const r = {
      scenario,
      accounts: oneAccount ? 'one' : 'separate',
      writers: n,
      rounds: ROUNDS,
      eventsPerRound: on[0].events,
      usPerEventOff: Number(mOff.toFixed(1)),
      usPerEventOn: Number(mOn.toFixed(1)),
      slowdownOfMediansPct: Number(((mOn / mOff - 1) * 100).toFixed(2)),
      pairedSlowdownMedianPct: Number(median(paired).toFixed(2)),
      pairedSlowdownsPct: paired.map((v) => Number(v.toFixed(1))),
      rawUsPerEventOff: off.map((x) => Number(usPerEvent(x).toFixed(1))),
      rawUsPerEventOn: on.map((x) => Number(usPerEvent(x).toFixed(1))),
      errorsOff: sumErrors(off),
      errorsOn: sumErrors(on),
      multixactsPerEventOff: Number(perEvent(off, 'multixacts').toFixed(3)),
      multixactsPerEventOn: Number(perEvent(on, 'multixacts').toFixed(3)),
      multixactPagesOn: on.reduce((s, x) => s + x.mxPages, 0),
      deadlocksStat: [...on, ...off].reduce((s, x) => s + x.deadlocksStat, 0),
      walBytesPerEventOff: Number(perEvent(off, 'walBytes').toFixed(0)),
      walBytesPerEventOn: Number(perEvent(on, 'walBytes').toFixed(0)),
      lockWaitsOff: waits(off),
      lockWaitsOn: waits(on)
    };
    results.push(r);
    console.log(`PGUC ${scenario} ${r.accounts} account(s), ${n} writer(s): off ${r.usPerEventOff} us/event, on ${r.usPerEventOn} us/event, ` +
      `slowdown of the medians ${r.slowdownOfMediansPct}%, paired median ${r.pairedSlowdownMedianPct}% (${r.pairedSlowdownsPct.join(', ')}); ` +
      `errors off ${JSON.stringify(r.errorsOff)} on ${JSON.stringify(r.errorsOn)}; multixacts/event off ${r.multixactsPerEventOff} on ${r.multixactsPerEventOn}; ` +
      `WAL B/event off ${r.walBytesPerEventOff} on ${r.walBytesPerEventOn}; lock waits/sample off ${JSON.stringify(r.lockWaitsOff)} on ${JSON.stringify(r.lockWaitsOn)}`);
    return r;
  }

  it('[PGUC1] parallel API batch events.create, one account and separate accounts', async function () {
    for (const n of WRITERS) {
      await measure('api-batch', n, true, apiRound);
      if (n > 1) await measure('api-batch', n, false, apiRound);
    }
  });

  it('[PGUC2] parallel autocommit event writes, one account and separate accounts', async function () {
    for (const n of WRITERS) {
      await measure('sql-autocommit', n, true, sqlRound);
      if (n > 1) await measure('sql-autocommit', n, false, sqlRound);
    }
  });

  // The direct measure (as [PGUB5], under load): the trigger's own time in
  // each single-row insert, N writers at once, set against the API per-event
  // time of [PGUC1] at the same N. Not noise-bound like the A/B above.
  async function triggerTimes (n, oneAccount) {
    const writers = writersFor(n, oneAccount);
    const clients = [];
    for (let i = 0; i < n; i++) clients.push(await pool.connect());
    const trig = [];
    const exec = [];
    const errors = {};
    const prefix = 'pguc-x-' + cuid.slug() + '-';
    try {
      await Promise.all(writers.map(async (a, w) => {
        for (let i = 0; i < SQL_EVENTS; i++) {
          try {
            const res = await clients[w].query(
              `EXPLAIN (ANALYZE, FORMAT JSON) INSERT INTO events (user_id, id, stream_ids, time, type, content, created, created_by, modified, modified_by)
               VALUES ($1, $2, $3::jsonb, 1, 'note/txt', '"x"'::jsonb, 1, 'bench', 1, 'bench')`, [a.userId, `${prefix}${w}-${i}`, JSON.stringify([a.streamId])]);
            const plan = res.rows[0]['QUERY PLAN'][0];
            trig.push(plan.Triggers.find((t) => t['Trigger Name'] === 'refuse_unindexed_user').Time * 1000);
            exec.push(plan['Execution Time'] * 1000);
          } catch (err) {
            errors[err.code || err.message] = (errors[err.code || err.message] || 0) + 1;
          }
        }
      }));
    } finally {
      for (const c of clients) c.release();
    }
    return { events: trig.length, trig, exec, errors };
  }

  it('[PGUC3] trigger time per insert with N parallel writers, and its share of the API per-event time', async function () {
    await toggle.set(true);
    for (const n of WRITERS) {
      for (const oneAccount of (n > 1 ? [true, false] : [true])) {
        const x = await observed(() => triggerTimes(n, oneAccount));
        const sorted = [...x.trig].sort((a, b) => a - b);
        const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        const api = results.find((r) => r.scenario === 'api-batch' && r.writers === n && r.accounts === (oneAccount ? 'one' : 'separate'));
        const mean = x.trig.reduce((s, v) => s + v, 0) / x.trig.length;
        // With n writers each one waits n times the inverse throughput per
        // event: the trigger adds to that. The serialized bound (trigger time
        // against the inverse throughput itself) is the cost if no two
        // triggers overlapped.
        const pct = (us, per) => api ? Number((100 * us / per).toFixed(2)) : null;
        const r = {
          scenario: 'trigger-time',
          accounts: oneAccount ? 'one' : 'separate',
          writers: n,
          inserts: x.events,
          triggerUsMedian: Number(median(x.trig).toFixed(1)),
          triggerUsP90: Number(q(0.9).toFixed(1)),
          triggerUsP99: Number(q(0.99).toFixed(1)),
          triggerUsMax: Number(sorted[sorted.length - 1].toFixed(1)),
          triggerUsMean: Number(mean.toFixed(1)),
          statementUsMedian: Number(median(x.exec).toFixed(1)),
          apiUsPerEventOff: api?.usPerEventOff ?? null,
          shareOfWriterEventPctMean: pct(mean, n * api?.usPerEventOff),
          serializedBoundPctMean: pct(mean, api?.usPerEventOff),
          errors: x.errors,
          multixactsPerInsert: Number((x.multixacts / x.events).toFixed(3)),
          lockWaits: x.lockWaitsPerSample
        };
        results.push(r);
        console.log(`PGUC trigger time ${r.accounts} account(s), ${n} writer(s): median ${r.triggerUsMedian} us, mean ${r.triggerUsMean}, p90 ${r.triggerUsP90}, p99 ${r.triggerUsP99}, max ${r.triggerUsMax} ` +
          `(statement ${r.statementUsMedian} us); API ${r.apiUsPerEventOff} us/event: mean share of a writer's event time ${r.shareOfWriterEventPctMean}% (serialized bound ${r.serializedBoundPctMean}%); ` +
          `errors ${JSON.stringify(r.errors)}; multixacts/insert ${r.multixactsPerInsert}; lock waits/sample ${JSON.stringify(r.lockWaits)}`);
      }
    }
  });
});
