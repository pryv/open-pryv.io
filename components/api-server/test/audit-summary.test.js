/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ASM] audit.getSummary: activity counts of the account's audit trail per
 * hour, day or week, by method class with an error overlay. Personal accesses
 * only; the figures are computed from the rows events.get lists on the
 * `:_audit:` streams.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const validation = require('./helpers/validation');
const methodsSchema = require('../src/schema/auditMethods.ts');
const { withInjectedConfig, pollUntil } = require('test-helpers');
const { getConfig } = require('@pryv/boiler');
const { _testHooks } = require('../src/methods/audit.ts');

const COUNTERS = ['total', 'reads', 'writes', 'session', 'other', 'errors'];

describe('[ASM] audit.getSummary', function () {
  this.timeout(30000);

  let username, basePath, personalToken, appToken, app2Token, sharedToken, auditAppToken, delegateToken;
  let appAccess, app2Access, personalAccess, streamId, startTime;

  before(async function () {
    await initTests();
    const config = await getConfig();
    if (config.get('audit:active') !== true) { this.skip(); return; }
    await initCore();
    username = ('asm' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    basePath = '/' + username;
    personalToken = cuid();
    appToken = cuid();
    app2Token = cuid();
    sharedToken = cuid();
    auditAppToken = cuid();
    delegateToken = 'deleg-' + cuid();
    startTime = Date.now() / 1000 - 60;
    const fixtureUser = await getNewFixture().user(username);
    streamId = 'asms_' + username;
    await fixtureUser.stream({ id: streamId, name: 'ASM stream' });
    personalAccess = await fixtureUser.access({ type: 'personal', token: personalToken });
    await fixtureUser.session(personalToken);
    appAccess = await fixtureUser.access({ type: 'app', name: 'asm-app', token: appToken, permissions: [{ streamId, level: 'manage' }] });
    app2Access = await fixtureUser.access({ type: 'app', name: 'asm-app2', token: app2Token, permissions: [{ streamId, level: 'manage' }] });
    await fixtureUser.access({ type: 'shared', name: 'asm-shared', token: sharedToken, permissions: [{ streamId, level: 'read' }] });
    await fixtureUser.access({ type: 'app', name: 'asm-audit-app', token: auditAppToken, permissions: [{ streamId: ':_audit:', level: 'read' }] });
    // Minted storage-side the way the delegation plugin does: personal, marked.
    await fixtureUser.access({
      type: 'personal',
      token: delegateToken,
      name: 'delegation:asm-parent@core',
      clientData: { delegation: { kind: 'delegate-pat', relId: 'asm-rel', delegate: { username: 'asm-parent', hostSlug: 'core' } } }
    });
    await fixtureUser.session(delegateToken);

    // The activity counted by [ASM2]: 2 reads, 1 write, 1 failing write, and a
    // batch of 2 reads, all with the app token.
    await call(appToken).get(basePath + '/events');
    await call(appToken).get(basePath + '/events');
    assert.equal((await call(appToken).post(basePath + '/events').send({ streamIds: [streamId], type: 'note/txt', content: 'asm' })).status, 201);
    assert.equal((await call(appToken).post(basePath + '/events').send({ streamIds: ['asm-no-such-stream'], type: 'note/txt', content: 'asm' })).status >= 400, true);
    const batch = await coreRequest.post(basePath).set('Authorization', appToken).send([
      { method: 'events.get', params: {} },
      { method: 'streams.get', params: {} }
    ]);
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
  });

  function call (token) {
    return {
      get: (path) => coreRequest.get(path).set('Authorization', token),
      post: (path) => coreRequest.post(path).set('Authorization', token)
    };
  }

  function summary (token, query) {
    return coreRequest.get(basePath + '/audit/summary').query(query).set('Authorization', token);
  }

  function sums (buckets) {
    const out = Object.fromEntries(COUNTERS.map((k) => [k, 0]));
    for (const b of buckets) for (const k of COUNTERS) out[k] += b[k];
    return out;
  }

  // Audit rows are written after the reply: wait until the expected total shows.
  async function summaryUntil (token, query, minTotal) {
    const res = await pollUntil(() => summary(token, query),
      (r) => r.status !== 200 || sums(r.body.summary.buckets).total >= minTotal, { timeoutMs: 5000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res;
  }

  it('[ASM1] a personal caller gets dense buckets with the six counters; the body validates', async function () {
    const toTime = Date.now() / 1000 + 60;
    const res = await summaryUntil(personalToken, { fromTime: startTime, toTime, bucket: 'hour' }, 6);
    validation.check(res, { status: 200, schema: methodsSchema.getSummary.result });
    const s = res.body.summary;
    assert.equal(s.bucket, 'hour');
    assert.equal(s.timezone, 'UTC');
    assert.equal(s.fromTime, startTime);
    assert.equal(s.toTime, toTime);
    assert.ok(s.buckets.length >= 1 && s.buckets.length <= 3, 'one to three hours for a two-minute range');
    for (let i = 0; i < s.buckets.length; i++) {
      const b = s.buckets[i];
      assert.deepEqual(Object.keys(b).sort(), ['time', ...COUNTERS].sort());
      assert.equal(b.time % 3600, 0, 'UTC hour aligned');
      if (i > 0) assert.equal(b.time - s.buckets[i - 1].time, 3600, 'dense and ascending');
      assert.equal(b.total, b.reads + b.writes + b.session + b.other);
    }
    assert.ok(s.buckets[0].time <= startTime);
  });

  it('[ASM2] figures for one access: reads, writes, the error overlay, and no trace of the batch envelope; they match the rows events.get lists', async function () {
    const toTime = Date.now() / 1000 + 60;
    const query = { fromTime: startTime, toTime, bucket: 'day', accessIds: [appAccess.attrs.id] };
    const res = await summaryUntil(personalToken, query, 6);
    const total = sums(res.body.summary.buckets);
    assert.deepEqual(total, { total: 6, reads: 4, writes: 2, session: 0, other: 0, errors: 1 }, JSON.stringify(total));
    // The same rows, listed.
    const rows = await call(personalToken).get(basePath + '/events')
      .query({ streams: JSON.stringify([':_audit:access-' + appAccess.attrs.id]), fromTime: startTime, toTime, limit: 1000 });
    assert.equal(rows.status, 200, JSON.stringify(rows.body));
    const counted = rows.body.events.filter((e) => e.content?.action !== 'callBatch');
    assert.ok(rows.body.events.length > counted.length, 'the batch envelope row exists in the trail');
    assert.equal(counted.length, total.total, 'sum of total equals the listed rows without the batch envelope');
  });

  it('[ASM3] accessIds: one access, two accesses, a repeated id counted once, an unknown id gives zeros', async function () {
    await call(app2Token).get(basePath + '/events');
    const toTime = Date.now() / 1000 + 60;
    const base = { fromTime: startTime, toTime, bucket: 'day' };
    const two = await summaryUntil(personalToken, Object.assign({ accessIds: [appAccess.attrs.id, app2Access.attrs.id] }, base), 7);
    assert.equal(sums(two.body.summary.buckets).total, 7);
    const repeated = await summary(personalToken, Object.assign({ accessIds: [appAccess.attrs.id, appAccess.attrs.id] }, base));
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
    assert.equal(sums(repeated.body.summary.buckets).total, 6);
    const unknown = await summary(personalToken, Object.assign({ accessIds: ['asm-unknown-access'] }, base));
    assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
    assert.equal(sums(unknown.body.summary.buckets).total, 0);
    assert.ok(unknown.body.summary.buckets.length >= 1, 'zeros are dense too');
  });

  it('[ASMC] a composite `<id>:<serial>` counts the calls of that version only, its base id every version', async function () {
    // A versioned access: its calls carry both `access-<id>` and `access-<id>:<serial>`.
    const token = cuid();
    const created = await call(personalToken).post(basePath + '/accesses')
      .send({ type: 'app', name: 'asm-versioned-' + cuid().slice(-6), token, permissions: [{ streamId, level: 'read' }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const baseId = created.body.access.id;
    await call(token).get(basePath + '/events');
    const upd = await coreRequest.put(basePath + '/accesses/' + baseId).set('Authorization', personalToken)
      .send({ clientData: { note: 'asmc' } });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    await call(token).get(basePath + '/events');
    await call(token).get(basePath + '/events');
    // The composite term, as the audit rows carry it.
    const rows = await pollUntil(() => call(personalToken).get(basePath + '/events')
      .query({ streams: JSON.stringify([':_audit:access-' + baseId]), fromTime: startTime, limit: 100 }),
    (r) => r.status === 200 && r.body.events.length >= 3, { timeoutMs: 5000 });
    const composite = rows.body.events.flatMap((e) => e.streamIds)
      .map((s) => s.replace(/^:_audit:access-/, ''))
      .find((s) => s.startsWith(baseId + ':'));
    assert.ok(composite != null, 'a versioned call carries a composite term: ' + JSON.stringify(rows.body.events.map((e) => e.streamIds)));
    const base = { fromTime: startTime, toTime: Date.now() / 1000 + 60, bucket: 'day' };
    const all = await summaryUntil(personalToken, Object.assign({ accessIds: [baseId] }, base), 3);
    assert.equal(sums(all.body.summary.buckets).total, 3, 'the base id counts every version');
    const one = await summary(personalToken, Object.assign({ accessIds: [composite] }, base));
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(sums(one.body.summary.buckets).total, 2, 'the composite id counts that version only');
    const both = await summary(personalToken, Object.assign({ accessIds: [baseId, composite] }, base));
    assert.equal(sums(both.body.summary.buckets).total, 3, 'a row matching two given ids counts once');
  });

  it('[ASM4] app and shared callers are refused, an app holding a read on the whole audit store included', async function () {
    const query = { fromTime: startTime, bucket: 'day' };
    // The audit app reads `:_audit:` (every audit stream): the gate is on the access type, not on permissions.
    for (const token of [appToken, sharedToken, auditAppToken]) {
      const res = await summary(token, query);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error.id, 'forbidden');
    }
    // The same inside a batch.
    const batch = await coreRequest.post(basePath).set('Authorization', auditAppToken)
      .send([{ method: 'audit.getSummary', params: query }]);
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.equal(batch.body.results[0].error?.id, 'forbidden', JSON.stringify(batch.body.results[0]));
  });

  it('[ASMD] the token may be given in the query string', async function () {
    const res = await coreRequest.get(basePath + '/audit/summary').query({ fromTime: startTime, bucket: 'day', auth: personalToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it('[ASM5] a delegate personal access may call it', async function () {
    const res = await summary(delegateToken, { fromTime: startTime, bucket: 'day' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body.summary.buckets));
  });

  it('[ASM6] invalid parameters are refused', async function () {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      { fromTime: startTime },
      { fromTime: startTime, bucket: 'month' },
      { fromTime: startTime, bucket: 'day', timezone: 'Mars/Olympus_Mons' },
      { fromTime: startTime, bucket: 'day', timezone: '+00:07' },
      { fromTime: now, toTime: now, bucket: 'day' },
      { fromTime: now, toTime: now - 10, bucket: 'day' },
      { fromTime: now - 751 * 3600, toTime: now, bucket: 'hour' },
      { fromTime: startTime, bucket: 'day', accessIds: Array.from({ length: 51 }, (_, i) => 'a' + i) },
      { fromTime: startTime, bucket: 'day', accessIds: ["a'b"] },
      { fromTime: startTime, bucket: 'day', accessIds: ['a b'] },
      { fromTime: startTime, bucket: 'day', accessIds: ['a%'] },
      { fromTime: 1e13, toTime: 2e13, bucket: 'day' },
      { fromTime: 8639999999990, toTime: 8640000000100, bucket: 'hour' },
      { fromTime: startTime, toTime: 'Infinity', bucket: 'day' }
    ];
    for (const query of cases) {
      const res = await summary(personalToken, query);
      assert.equal(res.status, 400, JSON.stringify(query) + ' -> ' + JSON.stringify(res.body));
      assert.equal(res.body.error.id, 'invalid-parameters-format', JSON.stringify(query));
    }
    const capped = await summary(personalToken, { fromTime: now - 751 * 3600, toTime: now, bucket: 'hour' });
    assert.equal(capped.body.error.data.maxBuckets, 750);
    const ok = await summary(personalToken, { fromTime: now - 749 * 3600, toTime: now, bucket: 'hour' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.summary.buckets.length <= 750);
  });

  it('[ASM7] with the audit trail off, the method is unavailable', async function () {
    await withInjectedConfig({ audit: { active: false } }, async () => {
      const res = await summary(personalToken, { fromTime: startTime, bucket: 'day' });
      assert.equal(res.body.error?.id, 'unavailable-method', JSON.stringify(res.body));
    });
  });

  it('[ASM8] a partial first bucket starts before fromTime; rows before fromTime are not counted', async function () {
    await call(app2Token).get(basePath + '/events');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cut = Date.now() / 1000;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await call(app2Token).get(basePath + '/events');
    const query = { fromTime: cut, toTime: cut + 3600, bucket: 'day', accessIds: [app2Access.attrs.id] };
    const res = await summaryUntil(personalToken, query, 1);
    const s = res.body.summary;
    assert.ok(s.buckets[0].time < cut, 'the first bucket starts at the day start');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const again = await summary(personalToken, query);
    assert.equal(sums(again.body.summary.buckets).total, 1, 'only the call after fromTime');
  });

  it('[ASM9] the call is audited as a read of the caller', async function () {
    const before = Date.now() / 1000;
    const first = await summary(personalToken, { fromTime: startTime, bucket: 'day' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const res = await summaryUntil(personalToken, { fromTime: before, toTime: Date.now() / 1000 + 60, bucket: 'day', accessIds: [personalAccess.attrs.id] }, 1);
    const total = sums(res.body.summary.buckets);
    assert.ok(total.reads >= 1, JSON.stringify(total));
    assert.equal(total.reads, total.total, 'summaries are reads');
    const rows = await pollUntil(() => call(personalToken).get(basePath + '/events')
      .query({ streams: JSON.stringify([':_audit:action-audit.getSummary']), fromTime: before }),
    (r) => r.status === 200 && r.body.events.length >= 1, { timeoutMs: 5000 });
    assert.ok(rows.body.events.length >= 1, JSON.stringify(rows.body));
  });

  it('[ASMA] callable inside a batch', async function () {
    const res = await coreRequest.post(basePath).set('Authorization', personalToken)
      .send([{ method: 'audit.getSummary', params: { fromTime: startTime, bucket: 'day' } }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.results[0].summary != null, JSON.stringify(res.body.results[0]));
  });

  it('[ASMB] an exhausted work budget is refused without a partial answer; a full queue is refused', async function () {
    _testHooks.forceDeadlineInPast = true;
    try {
      const res = await summary(personalToken, { fromTime: startTime, bucket: 'day' });
      assert.equal(res.body.error?.id, 'invalid-operation', JSON.stringify(res.body));
      assert.equal(res.body.error.data.reason, 'summary-too-large');
      assert.equal(res.body.summary, undefined);
    } finally {
      _testHooks.forceDeadlineInPast = false;
    }
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    _testHooks.holdBefore = () => gate;
    try {
      const pending = Array.from({ length: 6 }, () => summary(personalToken, { fromTime: startTime, bucket: 'day' }).then((r) => r));
      await new Promise((resolve) => setTimeout(resolve, 500));
      _testHooks.holdBefore = null;
      release();
      const results = await Promise.all(pending);
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429], JSON.stringify(results.map((r) => r.body.error?.id)));
      assert.equal(results.find((r) => r.status === 429).body.error.id, 'too-many-requests');
    } finally {
      _testHooks.holdBefore = null;
      if (release) release();
    }
  });

  it('[ASME] a summary whose store was closed under it runs once more; interrupted twice, it is refused with too-many-requests', async function () {
    const query = { fromTime: startTime, toTime: Date.now() / 1000 + 60, bucket: 'day', accessIds: [appAccess.attrs.id] };
    const reference = await summary(personalToken, query);
    assert.equal(reference.status, 200, JSON.stringify(reference.body));
    assert.ok(sums(reference.body.summary.buckets).total > 0);
    try {
      _testHooks.interruptions = 1;
      const once = await summary(personalToken, query);
      assert.equal(once.status, 200, JSON.stringify(once.body));
      assert.deepEqual(once.body.summary, reference.body.summary);
      assert.equal(_testHooks.interruptions, 0);
      _testHooks.interruptions = 2;
      const twice = await summary(personalToken, query);
      assert.equal(twice.status, 429, JSON.stringify(twice.body));
      assert.equal(twice.body.error.id, 'too-many-requests');
      assert.equal(twice.body.summary, undefined);
    } finally {
      _testHooks.interruptions = 0;
    }
  });

  describe('[ASMF] across accounts: two summaries read at once, eight wait, a call that waited too long is refused', function () {
    const accounts = [];
    const entered = new Set();
    let gates;

    before(async function () {
      for (let i = 0; i < 11; i++) {
        const name = ('asmf' + i + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
        const token = cuid();
        const user = await getNewFixture().user(name);
        await user.access({ type: 'personal', token });
        await user.session(token);
        accounts.push({ name, token, id: user.attrs.id });
      }
    });

    beforeEach(function () {
      gates = new Map();
      entered.clear();
      _testHooks.holdBefore = (userId) => {
        entered.add(userId);
        return gates.get(userId)?.promise;
      };
    });

    afterEach(function () {
      for (const gate of gates.values()) gate.release();
      _testHooks.holdBefore = null;
    });

    function gate (account) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      gates.set(account.id, { promise, release });
      return release;
    }

    function sumOf (account) {
      const call = coreRequest.get('/' + account.name + '/audit/summary')
        .query({ fromTime: startTime, bucket: 'day' }).set('Authorization', account.token);
      const tracked = { settled: false };
      tracked.done = call.then((r) => { tracked.settled = true; return r; });
      return tracked;
    }

    async function until (predicate) {
      const limit = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > limit) throw new Error('condition not reached');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    it('[ASMF1] with two accounts reading, a third account waits, then answers once a slot is free', async function () {
      const [a, b, c] = accounts;
      const releaseA = gate(a);
      const releaseB = gate(b);
      const pa = sumOf(a);
      const pb = sumOf(b);
      await until(() => entered.has(a.id) && entered.has(b.id));
      const pc = sumOf(c);
      await sleep(300);
      assert.equal(entered.has(c.id), false, 'the third account does not read while two do');
      assert.equal(pc.settled, false);
      releaseA();
      assert.equal((await pa.done).status, 200);
      const rc = await pc.done;
      assert.equal(rc.status, 200, JSON.stringify(rc.body));
      assert.equal(pb.settled, false, 'the second account is still held');
      releaseB();
      assert.equal((await pb.done).status, 200);
    });

    it('[ASMF2] with eight calls waiting for a slot, the next is refused at once', async function () {
      const [a, b, ...rest] = accounts;
      const releaseA = gate(a);
      const releaseB = gate(b);
      const held = [sumOf(a), sumOf(b)];
      await until(() => entered.has(a.id) && entered.has(b.id));
      const waiting = rest.slice(0, 8).map(sumOf);
      await sleep(300);
      const started = Date.now();
      const refused = await sumOf(rest[8]).done;
      assert.equal(refused.status, 429, JSON.stringify(refused.body));
      assert.equal(refused.body.error.id, 'too-many-requests');
      assert.ok(Date.now() - started < 2000, 'refused without waiting');
      assert.ok(waiting.every((p) => !p.settled), 'the eight wait');
      releaseA();
      releaseB();
      for (const p of [...held, ...waiting]) assert.equal((await p.done).status, 200);
    });

    it('[ASMF3] a call whose turn comes after the wait limit is refused without reading the store', async function () {
      const [a, b, c] = accounts;
      const previous = _testHooks.maxWaitMs;
      _testHooks.maxWaitMs = 200;
      try {
        const releaseA = gate(a);
        const releaseB = gate(b);
        const pa = sumOf(a);
        const pb = sumOf(b);
        await until(() => entered.has(a.id) && entered.has(b.id));
        const readsBefore = _testHooks.storeReads;
        const pc = sumOf(c);
        await sleep(400);
        releaseA();
        const rc = await pc.done;
        assert.equal(rc.status, 429, JSON.stringify(rc.body));
        assert.equal(rc.body.error.id, 'too-many-requests');
        assert.equal((await pa.done).status, 200);
        assert.equal(entered.has(c.id), false, 'the late call never reached the read');
        assert.equal(_testHooks.storeReads - readsBefore, 1, 'only the released call read the store');
        releaseB();
        assert.equal((await pb.done).status, 200);
      } finally {
        _testHooks.maxWaitMs = previous;
      }
    });
  });
});
