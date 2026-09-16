/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global assert, charlatan, cuid, audit, initTests, initCore, coreRequest, coreServer, getNewFixture */

const http = require('http');

// The one test that would have caught the regression this work exists to
// prevent: a real HTTP client aborting mid-response, observed at the PostgreSQL
// pool rather than through a stand-in.
//
// A truly streamed audit read owns a pooled client for the life of the
// response. The audit store has its OWN small pool, so a handful of aborted
// requests is enough to starve it — and what follows is not a clean failure:
// audit writes run after the response through result.onEnd, so they queue for a
// client, time out, and the audit record is LOST.
describe('[AUAB] aborted audit queries release their pooled client', function () {
  this.timeout(120 * 1000);

  let fixtures, username, token, userId, pool, poolMax, eventsPath;
  const SEEDED = 20000; // far beyond any socket buffer: the server is provably mid-cursor

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await initTests();
    await initCore();

    // ⚑ `storages.audit.engine` defaults to sqlite, INDEPENDENTLY of the
    // baseStorage engine — so a plain `just test audit` run has no PostgreSQL
    // audit pool to starve and this test has nothing to measure. It applies
    // only to a deployment that selects the PostgreSQL audit engine, e.g.
    //   storages__audit__engine=postgresql just test audit
    if (audit.storage?.db?.pool == null) {
      // Not a skip-in-silence: say why, so a green run is not mistaken for
      // coverage of the PostgreSQL audit path.
      console.log('      [AUAB] skipped: audit storage engine is not postgresql ' +
        '(set storages__audit__engine=postgresql to exercise the pool)');
      return this.skip();
    }

    fixtures = getNewFixture();
    const user = await fixtures.user(charlatan.Lorem.characters(7), { password: cuid() });
    await user.stream({ id: 'yo', name: 'YO' });
    const access = (await user.access({ type: 'personal', token: cuid() })).attrs;
    await user.session(access.token);
    username = user.attrs.username;
    userId = user.attrs.id;
    token = access.token;
    eventsPath = '/' + username + '/events';

    pool = audit.storage.db.pool;
    poolMax = pool.options.max;

    // One audited call first, so we can copy a REAL row's stream_ids rather
    // than guessing how audit encodes them.
    await coreRequest.get(eventsPath).set('Authorization', token).query({ limit: 1 });
    const sample = await audit.storage.db.query(
      'SELECT stream_ids, type FROM audit_events WHERE user_id = $1 LIMIT 1', [userId]);
    assert.ok(sample.rows.length > 0, 'the first call must have produced an audit row to clone');
    const { stream_ids: streamIds, type } = sample.rows[0];

    // Bulk-seed from that shape in one statement.
    //
    // ⚑ Each row carries ~1KB of padding on purpose. With tiny rows the whole
    // response fits in Node's and the kernel's buffers, so the server finishes
    // the cursor and releases its client BEFORE the client can abort — and the
    // test then passes even when the leak is present (verified: it did). ~20MB
    // cannot be absorbed, so the abort provably lands mid-cursor.
    await audit.storage.db.query(
      `INSERT INTO audit_events
         (user_id, eventid, stream_ids, time, type, content, created, created_by, modified, modified_by)
       SELECT $1, 'auab-' || g, $2, $3::double precision + g, $4,
              jsonb_build_object('pad', repeat('x', 1000)),
              $3::double precision + g, 'test', $3::double precision + g, 'test'
       FROM generate_series(1, $5::int) AS g`,
      [userId, streamIds, Date.now() / 1000, type, SEEDED]
    );
  });

  after(async function () {
    if (fixtures) await fixtures.clean();
  });

  function checkedOut () {
    return pool.totalCount - pool.idleCount;
  }

  async function until (predicate, deadlineMs) {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  // Issue a real request and kill it once the server has started streaming AND
  // is provably holding a client.
  function abortMidResponse () {
    return new Promise((resolve, reject) => {
      const { port } = coreServer.address();
      const req = http.get({
        host: '127.0.0.1',
        port,
        // ⚑ The explicit limit matters: events.get defaults to a small page, so
        // without it the response is a handful of events, finishes instantly,
        // and the abort lands after the cursor is already closed.
        path: eventsPath + '?streams[]=' + encodeURIComponent(':_audit:') + '&limit=' + SEEDED,
        headers: { Authorization: token }
      }, (res) => {
        res.once('data', async () => {
          // Fail rather than skip if no client is ever checked out: that would
          // mean the read is not really streaming and the test proves nothing.
          const held = await until(() => checkedOut() >= 1, 1000);
          req.destroy();
          res.destroy();
          resolve(held);
        });
        res.on('error', () => {});
      });
      req.on('error', () => {}); // destroying our own request is not a failure
      setTimeout(() => {
        req.destroy();
        // This is what a leak looks like from the outside once the pool is
        // empty: the request never gets a client and simply hangs. Say so,
        // with the pool state, so the failure is readable.
        reject(new Error(
          'no response within 20s — pool exhausted? ' +
          `checked out ${checkedOut()}/${poolMax}, waiting ${pool.waitingCount}, ` +
          `total ${pool.totalCount}, idle ${pool.idleCount}`));
      }, 20000).unref();
    });
  }

  it('[AUAB1] ' + '(max + 3) aborted requests leave zero clients checked out', async function () {
    const rounds = poolMax + 3;

    for (let i = 0; i < rounds; i++) {
      const held = await abortMidResponse();
      // Per round, not "at least once across the run". If the server is not
      // holding a client when we abort, it already finished the cursor and this
      // round exercised nothing — which is how an earlier version of this test
      // passed against the leak.
      assert.ok(held,
        `round ${i + 1}/${rounds}: no client was checked out when the abort landed, ` +
        'so the response had already completed and this round proves nothing');
    }

    // Release is bounded by one batch read, so 3s is generous.
    const drained = await until(() => checkedOut() === 0 && pool.waitingCount === 0, 3000);
    assert.ok(drained,
      `after ${rounds} aborts: ${checkedOut()} client(s) still checked out, ` +
      `${pool.waitingCount} waiting (pool max ${poolMax})`);
  });

  it('[AUAB2] the audit store still serves requests afterwards', async function () {
    const before = pool.totalCount;
    const started = Date.now();
    const res = await coreRequest
      .get(eventsPath)
      .set('Authorization', token)
      .query({ streams: [':_audit:'], limit: 10 });
    const elapsed = Date.now() - started;

    assert.strictEqual(res.status, 200);
    // connectionTimeoutMillis is 60s, so an exhausted pool fails this loudly
    // instead of passing slowly.
    assert.ok(elapsed < 5000, `a normal audit read took ${elapsed}ms — the pool is starved`);
    assert.ok(pool.totalCount >= before,
      'aborts must not have destroyed connections (was ' + before + ', now ' + pool.totalCount + ')');
  });

  // Waits for the audit row count to exceed `from`, or gives up.
  async function countGrewFrom (from, deadlineMs = 8000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if ((await countAuditRows()) > from) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  it('[AUAB3] an aborted call is still written to the audit log', async function () {
    // Control first. Without it, a red result here cannot distinguish "the
    // abort path loses the audit record" from "this test cannot see audit
    // records at all", and the second is the likelier mistake.
    const beforeControl = await countAuditRows();
    await coreRequest.get(eventsPath).set('Authorization', token).query({ limit: 1 });
    const controlGrew = await countGrewFrom(beforeControl);
    assert.ok(controlGrew,
      'PREMISE FAILED: a normal completed call did not grow the audit row count, ' +
      'so this test cannot observe audit writes and proves nothing about aborts');

    const beforeAbort = await countAuditRows();
    // The audit record is written AFTER the response, through the same onEnd
    // path that the already-closed guard has to keep alive.
    await abortMidResponse();
    const abortGrew = await countGrewFrom(beforeAbort);

    assert.ok(abortGrew, 'the aborted call must still have produced an audit record');
  });

  async function countAuditRows () {
    const res = await audit.storage.db.query(
      'SELECT count(*)::int AS c FROM audit_events WHERE user_id = $1', [userId]);
    return res.rows[0].c;
  }
});
