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

  it('[RQRC6] an empty results array (no leader yet) fails a read at every level instead of reading as no row', async () => {
    originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, async json () { return { results: [] }; }, async text () { return ''; } });
    db.readWaitMs = 0;
    await assert.rejects(db.getUserCore('alice'), /no result at level strong/);
    await assert.rejects(db.getUserCore('alice', 'routing'), /no result at level linearizable/);
    await assert.rejects(db.query('SELECT 1'), { name: 'RqliteNoAnswerError', message: /no result at level default/ });
  });
});

// A read without an answer (no leader, leader unreachable, rqlited not
// reachable) is not "no row": it is sent again for `readWaitMs`, then fails.
describe('[RQNR] rqlite reads without an answer', () => {
  const ANSWERS = [
    { results: [], error: 'dial tcp 127.0.0.1:4002: connect: connection refused' },
    { results: [], error: 'not leader' },
    { results: [] },
    { error: 'leadership lost' },
    { results: [{ columns: ['value'], values: [['x']] }], error: 'leadership lost while committing log' },
    {},
    503,
    'connection'
  ];
  const ROW = { results: [{ columns: ['value'], values: [[JSON.stringify({ id: 'x', value: 'x', expiresAt: Date.now() + 60_000 })]] }] };
  let db, originalFetch, calls, urls;

  function answer (bodies) {
    calls = 0;
    urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      const body = bodies[Math.min(calls++, bodies.length - 1)];
      if (body === 'connection') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      if (typeof body === 'number') return { ok: false, status: body, async text () { return 'leader not found'; } };
      return { ok: true, async json () { return body; }, async text () { return ''; } };
    };
  }

  beforeEach(() => { db = new DBrqlite('http://localhost:4001'); db.readWaitMs = 0; originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  const READS = [
    ['query', (d) => d.query('SELECT 1')],
    ['getCoreInfo', (d) => d.getCoreInfo('core-a')],
    ['getInvitationToken', (d) => d.getInvitationToken('t')],
    ['getDnsRecord', (d) => d.getDnsRecord('www')],
    ['getAccessState', (d) => d.getAccessState('k')],
    ['getPlatformKv', (d) => d.getPlatformKv('oauth-client/x')],
    ['getAllCoreInfos', (d) => d.getAllCoreInfos()],
    ['listPlatformKvEntries', (d) => d.listPlatformKvEntries('oauth-client/')]
  ];

  it('[RQNR1] every unanswered body, HTTP 503 and a refused connection reject at the default level, one call each', async () => {
    for (const body of ANSWERS) {
      for (const [name, read] of READS) {
        answer([body]);
        await assert.rejects(read(db), { name: 'RqliteNoAnswerError', message: /no result at level default/ }, name + ' ' + JSON.stringify(body));
        assert.equal(calls, 1, name + ' ' + JSON.stringify(body));
      }
    }
  });

  it('[RQNR2] an answered result without rows is still "no row"', async () => {
    for (const body of [{ results: [{ columns: ['value'] }] }, { results: [{}] }, { results: [{ columns: ['value'], values: [] }] }]) {
      answer([body]);
      assert.deepEqual(await db.query('SELECT 1'), [], JSON.stringify(body));
      answer([body]);
      assert.equal(await db.getCoreInfo('core-a'), null, JSON.stringify(body));
      answer([body]);
      assert.deepEqual(await db.getAllCoreInfos(), [], JSON.stringify(body));
    }
  });

  it('[RQNR3] within the wait, an unanswered read is sent again until answered; an SQL error or another HTTP failure is not', async () => {
    db.readWaitMs = 3000;
    answer([{ results: [] }, 'connection', ROW]);
    assert.deepEqual(await db.getCoreInfo('core-a'), JSON.parse(ROW.results[0].values[0][0]));
    assert.equal(calls, 3);
    answer([{ results: [{ error: 'no such table: keyValue' }] }, ROW]);
    await assert.rejects(db.query('SELECT 1'), /^Error: rqlite SQL error: no such table/);
    assert.equal(calls, 1);
    answer([500, ROW]);
    await assert.rejects(db.query('SELECT 1'), /rqlite query failed \(500\)/);
    assert.equal(calls, 1);
  });

  it('[RQNR4] the wait is bounded; after a wait in vain the next read makes one attempt; an answered read restores the wait', async () => {
    db.readWaitMs = 250;
    answer([{ results: [] }]);
    const started = Date.now();
    await assert.rejects(db.query('SELECT 1'), { name: 'RqliteNoAnswerError' });
    assert.ok(calls >= 2 && calls <= 4, String(calls));
    assert.ok(Date.now() - started < 1000);
    answer([{ results: [] }, ROW]);
    await assert.rejects(db.query('SELECT 1'), { name: 'RqliteNoAnswerError' });
    assert.equal(calls, 1, 'one attempt while the outage lasts');
    answer([ROW]);
    await db.query('PRAGMA integrity_check', undefined, 'none');
    answer([{ results: [] }, ROW]);
    await assert.rejects(db.query('SELECT 1'), { name: 'RqliteNoAnswerError' });
    assert.equal(calls, 1, 'a node-local read answered without a leader does not end the outage');
    answer([ROW]);
    await db.query('SELECT 1');
    answer([{ results: [] }, ROW]);
    await db.query('SELECT 1');
    assert.equal(calls, 2, 'the wait is back once a read was answered');
  });

  it('[RQNR5] setUserUniqueFieldIfNotExists reads back at level=strong and rejects on a no-answer, never false', async () => {
    answer([{ results: [{ rows_affected: 1 }] }, { results: [{ columns: ['value'], values: [['alice']] }] }]);
    assert.equal(await db.setUserUniqueFieldIfNotExists('alice', 'email', 'a@example.com'), true);
    assert.match(urls[1], /[?&]level=strong(&|$)/);
    answer([{ results: [{ rows_affected: 1 }] }, { results: [] }]);
    await assert.rejects(db.setUserUniqueFieldIfNotExists('alice', 'email', 'a@example.com'), { name: 'RqliteNoAnswerError' });
  });

  it('[RQNR6] bumpWindowedCounter: a refused budget whose read-back is unanswered answers now + 1000', async () => {
    answer([{ results: [{ rows_affected: 0 }] }, { results: [], error: 'not leader' }]);
    assert.equal(await db.bumpWindowedCounter('k', 3, 60_000, 1_000_000), 1_001_000);
    assert.equal(calls, 2);
    answer([{ results: [{ rows_affected: 0 }] }, { results: [{ error: 'disk I/O error' }] }]);
    await assert.rejects(db.bumpWindowedCounter('k', 3, 60_000, 1_000_000), /disk I\/O error/);
  });

  it('[RQNR8] isPlatformNoAnswer recognises the engine error, also wrapped, and nothing else', async () => {
    const { isPlatformNoAnswer } = require('../../../interfaces/platformStorage/noAnswer.ts');
    answer([{ results: [] }]);
    const err = await db.query('SELECT 1').catch((e) => e);
    assert.equal(isPlatformNoAnswer(err), true);
    assert.equal(isPlatformNoAnswer({ message: 'x', innerError: err }), true);
    assert.equal(isPlatformNoAnswer(new Error('wrapped', { cause: err })), true);
    assert.equal(isPlatformNoAnswer(new Error('rqlite query failed (500): boom')), false);
    assert.equal(isPlatformNoAnswer(null), false);
  });

  it('[RQNR7] readWaitMs is taken from the engine configuration and checked', () => {
    assert.equal(new DBrqlite('http://localhost:4001').readWaitMs, 3000);
    assert.equal(new DBrqlite('http://localhost:4001', { readWaitMs: 0 }).readWaitMs, 0);
    assert.equal(new DBrqlite('http://localhost:4001', { readWaitMs: 500 }).readWaitMs, 500);
    assert.throws(() => new DBrqlite('http://localhost:4001', { readWaitMs: -1 }), /readWaitMs/);
    assert.throws(() => new DBrqlite('http://localhost:4001', { readWaitMs: '3000' }), /readWaitMs/);
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
