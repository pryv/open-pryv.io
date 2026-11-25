/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import assert from 'node:assert';
const require = createRequire(import.meta.url);
const { DBrqlite } = require('../src/DBrqlite.ts');

// Routing- and uniqueness-critical PlatformDB reads must be issued at
// rqlite `strong` read consistency: without it, a `weak` (default) read
// during a leader-core restart / Raft election can serve stale or empty
// node-local state, so core-resolution (`auth.cores`) transiently
// mis-routes a user to the wrong core or reports them unknown.
describe('[RQRC] rqlite read consistency', () => {
  let db;
  let urls;
  let originalFetch;

  // Stub fetch so we capture the request URL without needing a live rqlite.
  // Returns a well-formed rqlite response so callers get a value back.
  function stubFetch (value) {
    urls = [];
    originalFetch = global.fetch;
    global.fetch = async (url) => {
      urls.push(url);
      return {
        ok: true,
        async json () {
          return { results: [{ columns: ['value'], values: value == null ? [] : [[value]] }] };
        },
        async text () { return ''; }
      };
    };
  }

  beforeEach(() => { db = new DBrqlite('http://localhost:4001'); });
  afterEach(() => { if (originalFetch) global.fetch = originalFetch; });

  it('[RQRC1] getUserCore reads at level=strong', async () => {
    stubFetch('core-a');
    const core = await db.getUserCore('alice');
    assert.equal(core, 'core-a');
    assert.equal(urls.length, 1);
    assert.match(urls[0], /[?&]level=strong(&|$)/);
  });

  it('[RQRC2] getUsersUniqueField reads at level=strong', async () => {
    stubFetch('alice');
    const username = await db.getUsersUniqueField('email', 'alice@example.com');
    assert.equal(username, 'alice');
    assert.match(urls[0], /[?&]level=strong(&|$)/);
  });

  it('[RQRC3] getUserIndexedField reads at level=strong', async () => {
    stubFetch('token');
    const value = await db.getUserIndexedField('alice', 'insurancenumber');
    assert.equal(value, 'token');
    assert.match(urls[0], /[?&]level=strong(&|$)/);
  });

  it('[RQRC4] non-routing reads keep the default (no level override)', async () => {
    stubFetch(JSON.stringify({ id: 'core-a' })); // getCoreInfo JSON-parses the value
    await db.getCoreInfo('core-a');
    assert.doesNotMatch(urls[0], /[?&]level=/);
  });

  it('[RQRC5] the cached routing read of getUserCore uses level=linearizable', async () => {
    stubFetch('core-a');
    assert.equal(await db.getUserCore('alice', 'routing'), 'core-a');
    assert.match(urls[0], /[?&]level=linearizable(&|$)/);
  });

  it('[RQRC6] an empty results array (no leader yet) fails a strong or linearizable read instead of reading as no row', async () => {
    originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, async json () { return { results: [] }; }, async text () { return ''; } });
    await assert.rejects(db.getUserCore('alice'), /no result at level strong/);
    await assert.rejects(db.getUserCore('alice', 'routing'), /no result at level linearizable/);
    assert.deepEqual(await db.query('SELECT 1'), [], 'a default-level read keeps the boot-time tolerance');
  });
});

// A follower whose leader is unreachable answers a forwarded write with HTTP
// 200, an error and no result.
describe('[RQNA] rqlite writes without a result', () => {
  const ANSWERS = [
    { results: [], error: 'dial tcp 127.0.0.1:4002: connect: connection refused' },
    { results: [], error: 'not leader' },
    { results: [] },
    { error: 'leadership lost' },
    { results: [{ rows_affected: 1 }], error: 'leadership lost while committing log' },
    {}
  ];
  let db, originalFetch, calls;

  function answer (bodies) {
    calls = 0;
    global.fetch = async () => {
      const body = bodies[Math.min(calls++, bodies.length - 1)];
      if (typeof body === 'number') return { ok: false, status: body, async text () { return 'leader not found'; } };
      return { ok: true, async json () { return body; }, async text () { return ''; } };
    };
  }

  beforeEach(() => { db = new DBrqlite('http://localhost:4001'); originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('[RQNA1] a write answered without a result, or with an error, is an error, and is not sent again', async () => {
    for (const body of ANSWERS) {
      answer([body]);
      await assert.rejects(db.execute('DELETE FROM keyValue'), { name: 'RqliteNoAnswerError', message: /rqlite execute got no result/ }, JSON.stringify(body));
      assert.equal(calls, 1);
      await assert.rejects(db.setUserUniqueField('alice', 'email', 'alice@example.com'), /got no result/, JSON.stringify(body));
    }
  });

  it('[RQNA2] an answered write passes, one that changed nothing included; an SQL error keeps its message', async () => {
    answer([{ results: [{ time: 0.1 }] }]);
    assert.deepEqual(await db.execute('CREATE TABLE t (a)'), { time: 0.1 });
    answer([{ results: [{ rows_affected: 0 }] }]);
    await db.deleteUserUniqueField('email', 'nobody');
    answer([{ results: [{ error: 'near "x": syntax error' }] }]);
    await assert.rejects(db.execute('x'), /^Error: rqlite SQL error: near "x"/);
  });

  it('[RQNA4] an expired access request still reads as gone when it cannot be dropped', async () => {
    const expired = { results: [{ columns: ['value'], values: [[JSON.stringify({ value: {}, expiresAt: 1 })]] }] };
    answer([expired, { results: [], error: 'not leader' }]);
    assert.equal(await db.getAccessState('k'), null);
    assert.equal(calls, 2);
  });

  it('[RQNA3] init waits for a leader, within its limit; another failure is not waited for', async () => {
    answer([{ results: [], error: 'not leader' }, { results: [] }, 503, { results: [{ time: 0.1 }] }]);
    await db.init();
    assert.equal(calls, 4);
    db.initWaitMs = 300;
    answer([{ results: [], error: 'not leader' }]);
    await assert.rejects(db.init(), /got no result: not leader/);
    assert.ok(calls >= 2 && calls <= 4, String(calls));
    db.initWaitMs = 15_000;
    answer([{ results: [{ error: 'disk I/O error' }] }]);
    await assert.rejects(db.init(), /disk I\/O error/);
    assert.equal(calls, 1);
  });
});
