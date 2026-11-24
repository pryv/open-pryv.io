/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');

// An audit record that cannot be written leaves the call's answer unchanged
// (see batch-audit-failure.test.js) and is counted once, by kind and cause, at
// the audit object. The write is failed below it, in the audit storage, so
// what is tested is the count itself.
describe('[ALRC] lost audit records are counted', function () {
  this.timeout(60_000);

  const SYNC_LOG = path.join(__dirname, '../var-pryv/logs/test-sync.log');

  let fixtures, audit, auditStorage, lossCounter, observability, emitter;
  let originalForUser;
  let username, token, streamId;
  let rejections = [];
  const onRejection = (reason) => { rejections.push(reason); };

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = 'alrc-' + cuid().slice(-8);
    token = cuid();
    streamId = 'alrc-stream';
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: streamId, name: streamId });
    audit = require('audit').default;
    auditStorage = require('storages').auditStorage;
    originalForUser = auditStorage.forUser;
    lossCounter = require('audit/src/lossCounter.ts');
    observability = require('business/src/observability/index.ts');
    emitter = require('business/src/observability/emitter.ts');
  });

  after(async function () {
    if (auditStorage != null) auditStorage.forUser = originalForUser;
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  beforeEach(function () {
    rejections = [];
    process.on('unhandledRejection', onRejection);
  });

  afterEach(function () {
    process.removeListener('unhandledRejection', onRejection);
    auditStorage.forUser = originalForUser;
    lossCounter._setTransport(null);
    observability._reset();
  });

  /** Fails the audit writes of the test user, except for the actions in `keep`. */
  function failWrites ({ keep = [] } = {}) {
    auditStorage.forUser = async function (userId, ...rest) {
      const real = await originalForUser.call(auditStorage, userId, ...rest);
      if (userId !== username) return real;
      return {
        createEvent: async (event) => {
          if (keep.includes(event.content.action)) return real.createEvent(event);
          throw new Error('simulated audit storage failure');
        }
      };
    };
  }

  function totals () { return lossCounter.snapshot().lost; }

  /** What was counted since `before`: the differences, zeros left out. */
  function since (before) {
    const now = totals();
    const delta = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - b[k]]).filter(([, n]) => n !== 0));
    return { total: now.total - before.total, byKind: delta(now.byKind, before.byKind), byReason: delta(now.byReason, before.byReason) };
  }

  async function settled (before, expected) {
    for (let i = 0; i < 100 && totals().total - before.total < expected; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // and leave the time for one too many
    await new Promise((resolve) => setTimeout(resolve, 100));
    return since(before);
  }

  async function auditRows (action) {
    const userDb = await originalForUser.call(auditStorage, username);
    const events = await userDb.getEvents({ query: [] });
    return events.filter((e) => e.content?.action === action).length;
  }

  function create (content) {
    return coreRequest.post('/' + username + '/events')
      .set('Authorization', token)
      .send({ streamIds: [streamId], type: 'note/txt', content });
  }

  function row (action = 'mfa.recovered') {
    return { streamIds: [':_audit:action-' + action], type: 'audit-log/mfa', time: 1, created: 1, createdBy: 'system', modified: 1, modifiedBy: 'system', content: { action, source: { name: 'test' } } };
  }

  it('[ALRC1] a single call: its answer stands, one valid record lost, also in the telemetry buffer', async function () {
    observability.init({
      endpoint: 'https://otlp.example.test',
      headers: {},
      serviceName: 'x',
      serviceVersion: '1',
      instanceId: 'y',
      worker: '1',
      methodIds: ['events.create'],
      flushIntervalMs: 3600000,
      send: async () => {}
    });
    const before = totals();
    failWrites();
    const res = await create('alrc1');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(await settled(before, 1), { total: 1, byKind: { valid: 1 }, byReason: { 'storage-write-failed': 1 } });
    assert.deepStrictEqual(emitter._buffered().counters['audit.records.lost'], [
      { attributes: { 'audit.record.kind': 'valid', 'audit.loss.reason': 'storage-write-failed' }, value: 1 }
    ]);
    assert.ok(Math.abs(totals().lastAt - Date.now() / 1000) < 30);
    assert.deepStrictEqual(rejections.map(String), [], 'no unhandled rejection');
  });

  it('[ALRC2] a batch: one count per lost inner record, the envelope written and not counted', async function () {
    const before = totals();
    const envelopes = await auditRows('callBatch');
    failWrites({ keep: ['callBatch'] });
    const res = await coreRequest.post('/' + username).set('Authorization', token).send([
      { method: 'events.create', params: { streamIds: [streamId], type: 'note/txt', content: 'alrc2-a' } },
      { method: 'events.create', params: { streamIds: ['alrc-unknown'], type: 'note/txt', content: 'alrc2-b' } },
      { method: 'events.create', params: { streamIds: [streamId], type: 'note/txt', content: 'alrc2-c' } }
    ]);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.results[0].event?.id);
    assert.strictEqual(res.body.results[1].error?.id, 'unknown-referenced-resource');
    assert.ok(res.body.results[2].event?.id);
    assert.deepStrictEqual(await settled(before, 3), {
      total: 3, byKind: { valid: 2, error: 1 }, byReason: { 'storage-write-failed': 3 }
    });
    auditStorage.forUser = originalForUser;
    assert.strictEqual(await auditRows('callBatch'), envelopes + 1);
  });

  it('[ALRC3] a refused single call: one error record lost', async function () {
    const before = totals();
    failWrites();
    const res = await coreRequest.post('/' + username + '/events').set('Authorization', token)
      .send({ streamIds: ['alrc-unknown'], type: 'note/txt', content: 'x' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.deepStrictEqual(await settled(before, 1), { total: 1, byKind: { error: 1 }, byReason: { 'storage-write-failed': 1 } });
  });

  it('[ALRC4] nothing is counted when records are written, or when a method is not audited', async function () {
    const before = totals();
    assert.strictEqual((await create('alrc4')).status, 201);
    await audit.validApiCall({ methodId: 'system.getAuditStatus', tracing: {} }, {});
    assert.deepStrictEqual(await settled(before, 0), { total: 0, byKind: {}, byReason: {} });
  });

  it('[ALRC5] a record that is not valid is refused as before, and counted', async function () {
    const before = totals();
    let stored = 0;
    auditStorage.forUser = async () => { stored++; return { createEvent: async () => {} }; };
    await assert.rejects(audit.eventForUser(username, { ...row(), streamIds: 'not-an-array' }), /Invalid audit event/);
    assert.strictEqual(stored, 0);
    assert.deepStrictEqual(since(before), { total: 1, byKind: { event: 1 }, byReason: { 'invalid-record': 1 } });
  });

  it('[ALRC6] a call whose record cannot be built is counted once, as its own kind', async function () {
    const before = totals();
    const spans = [];
    const tracing = { startSpan: () => {}, finishSpan: (name) => { spans.push(name); throw new Error('tracing failure'); }, logForSpan: () => {} };
    const context = { methodId: 'events.get', user: { id: username }, access: { id: 'a' }, tracing, get callerId () { throw new Error('cannot build'); } };
    await assert.rejects(audit.validApiCall(context, {}), /cannot build/);
    await assert.rejects(audit.errorApiCall(context, { id: 'x', message: 'y' }), /cannot build/);
    assert.deepStrictEqual(since(before), { total: 2, byKind: { valid: 1, error: 1 }, byReason: { 'invalid-record': 2 } });
    assert.deepStrictEqual(spans, ['audit.validApiCall', 'audit.errorApiCall'], 'both spans are finished');

    // and a tracing error does not replace the error of the write
    failWrites();
    const writable = { methodId: 'events.get', user: { id: username }, access: { id: 'a' }, tracing };
    await assert.rejects(audit.validApiCall(writable, {}), /simulated audit storage failure/);
    await assert.rejects(audit.errorApiCall(writable, { id: 'x', message: 'y' }), /simulated audit storage failure/);
  });

  it('[ALRC7] counting that fails changes nothing: the caller gets the original error', async function () {
    const before = totals();
    failWrites();
    lossCounter._setTransport(() => { throw new Error('channel closed'); });
    await assert.rejects(audit.eventForUser(username, row()), /^Error: simulated audit storage failure$/);
    assert.strictEqual((await create('alrc7')).status, 201);
    assert.deepStrictEqual(await settled(before, 2), { total: 2, byKind: { event: 1, valid: 1 }, byReason: { 'storage-write-failed': 2 } });
  });

  it('[ALRC8] a syslog failure is counted and does not cost the stored record; a storage failure after it counts once', async function () {
    const Audit = require('audit/src/Audit.ts').default;
    const failingSyslog = new Audit();
    failingSyslog.filter = { isAudited: () => ({ syslog: true, storage: true }) };
    failingSyslog._syslog = { eventForUser: () => { throw new Error('simulated syslog failure'); } };
    failingSyslog._storage = auditStorage;
    const rows = await auditRows('mfa.recovered');
    let before = totals();
    await failingSyslog.eventForUser(username, row());
    assert.deepStrictEqual(since(before), { total: 1, byKind: { event: 1 }, byReason: { 'syslog-failed': 1 } });
    assert.strictEqual(await auditRows('mfa.recovered'), rows + 1, 'the record is stored');

    before = totals();
    failWrites();
    await assert.rejects(failingSyslog.eventForUser(username, row()), /simulated audit storage failure/);
    assert.deepStrictEqual(since(before), { total: 1, byKind: { event: 1 }, byReason: { 'storage-write-failed': 1 } });
  });

  it('[ALRC9] without an audit storage each record is counted, no throw, one log line for all', async function () {
    const Audit = require('audit/src/Audit.ts').default;
    const noStorage = new Audit();
    noStorage.filter = { isAudited: () => ({ syslog: false, storage: true }) };
    const before = totals();
    let offset = 0;
    try { offset = fs.statSync(SYNC_LOG).size; } catch (_e) { /* not created yet */ }
    await noStorage.eventForUser(username, row());
    await noStorage.eventForUser(username, row());
    assert.deepStrictEqual(since(before), { total: 2, byKind: { event: 2 }, byReason: { 'storage-unavailable': 2 } });
    const logged = fs.readFileSync(SYNC_LOG).subarray(offset).toString();
    assert.strictEqual(logged.split('No audit storage').length - 1, 1, logged);

    // With a failing syslog too, the one record is one loss, the storage's.
    noStorage.filter = { isAudited: () => ({ syslog: true, storage: true }) };
    noStorage._syslog = { eventForUser: () => { throw new Error('simulated syslog failure'); } };
    const both = totals();
    await noStorage.eventForUser(username, row());
    assert.deepStrictEqual(since(both), { total: 1, byKind: { event: 1 }, byReason: { 'storage-unavailable': 1 } });
  });

  it('[ALRCA] an OAuth event dropped before the audit object is counted', async function () {
    const before = totals();
    const { audit: emit } = require('oauth2/src/audit.ts');
    await emit('oauth.token.issued', { clientId: 'alrc' });
    assert.deepStrictEqual(since(before), { total: 1, byKind: { event: 1 }, byReason: { 'invalid-record': 1 } });
  });

  describe('[ALRW] the status read', function () {
    let adminKey;
    before(async function () {
      adminKey = (await require('@pryv/boiler').getConfig()).get('auth:adminAccessKey');
      // initCore wires only the user-facing API (see migrations-status.test.js).
      if (!global.app.systemAPI.has('system.getAuditStatus')) {
        await require('api-server/src/methods/system.ts').default(global.app.systemAPI, global.app.api);
      }
    });

    const get = (key) => {
      const req = coreRequest.get('/system/audit-status');
      return key == null ? req : req.set('Authorization', key);
    };

    it('[ALRW1] no admin key or a wrong one: 404, nothing read', async function () {
      for (const res of [await get(null), await get('not-the-admin-key')]) {
        assert.strictEqual(res.status, 404, JSON.stringify(res.body));
        assert.strictEqual(res.body?.audit, undefined);
      }
    });

    it('[ALRW2] the counts by kind and cause, and only these fields', async function () {
      const before = totals();
      failWrites();
      await create('alrw2');
      await settled(before, 1);
      const res = await get(adminKey);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.headers['cache-control'], 'no-store');
      const { audit: status } = res.body;
      assert.deepStrictEqual(Object.keys(status).sort(), ['active', 'lost', 'scope', 'since']);
      assert.strictEqual(status.active, true);
      assert.strictEqual(status.scope, 'process', 'the test core has no master');
      assert.strictEqual(status.since, lossCounter.snapshot().since);
      assert.deepStrictEqual(status.lost, totals());
      assert.deepStrictEqual(Object.keys(status.lost).sort(), ['byKind', 'byReason', 'lastAt', 'total']);
      assert.strictEqual(status.lost.total, before.total + 1);
      assert.ok(!JSON.stringify(status).includes(username), 'no account in the answer');
    });

    it('[ALRW7] `active` follows the configuration', async function () {
      const { injectTestConfigSnapshot } = require('test-helpers');
      const restore = injectTestConfigSnapshot({ audit: { active: false } });
      try {
        assert.strictEqual((await get(adminKey)).body.audit.active, false);
      } finally {
        restore();
      }
      assert.strictEqual((await get(adminKey)).body.audit.active, true);
    });

    it('[ALRW3] the read itself is not audited and answers while the audit storage fails', async function () {
      const before = totals();
      auditStorage.forUser = async () => { throw new Error('simulated audit storage failure'); };
      assert.strictEqual((await get(adminKey)).status, 200);
      assert.deepStrictEqual(await settled(before, 0), { total: 0, byKind: {}, byReason: {} });
    });

    it('[ALRW4] the master adds up what the workers report and ignores anything else', function () {
      const { attach, STATUS_REQUEST, STATUS_REPLY } = require('audit/src/lossAggregator.ts');
      const cluster = new EventEmitter();
      const { snapshot } = attach(cluster);
      const sent = [];
      const worker = { send: (msg) => { sent.push(msg); } };
      cluster.emit('message', worker, { type: 'audit:lost', kind: 'valid', reason: 'storage-write-failed' });
      cluster.emit('message', { send: () => {} }, { type: 'audit:lost', kind: 'event', reason: 'invalid-record' });
      for (const other of [null, undefined, {}, { type: 'audit:lost' }, { type: 'audit:lost', kind: 'alice', reason: 'invalid-record' },
        { type: 'audit:lost', kind: 'valid', reason: '__proto__' }, { type: 'mail:reload' }]) {
        cluster.emit('message', worker, other);
      }
      assert.deepStrictEqual(sent, []);
      cluster.emit('message', worker, { type: STATUS_REQUEST, requestId: 'r1' });
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0], { type: STATUS_REPLY, requestId: 'r1', ...snapshot() });
      assert.strictEqual(sent[0].lost.total, 2);
      assert.deepStrictEqual(sent[0].lost.byKind, { valid: 1, error: 0, event: 1 });
      // A worker that left before its answer does not break the master.
      cluster.emit('message', { send: () => { throw new Error('gone'); } }, { type: STATUS_REQUEST, requestId: 'r2' });
    });

    it('[ALRW5] a worker takes the master\'s answer to its own request, its own counts otherwise', async function () {
      const { readLossStatus } = require('api-server/src/methods/helpers/auditStatusIpc.ts');
      const lost = { total: 7, byKind: {}, byReason: {}, lastAt: 1 };
      function handle (answer) {
        const proc = new EventEmitter();
        proc.send = (msg, cb) => answer(proc, msg, cb);
        return proc;
      }
      const answered = handle((proc, msg) => {
        proc.emit('message', { type: 'audit:loss-status:reply', requestId: 'another', since: 0, lost: {} });
        proc.emit('message', { type: 'audit:loss-status:reply', requestId: msg.requestId, since: 5, lost });
      });
      assert.deepStrictEqual(await readLossStatus({ processHandle: answered, isWorker: true }), { scope: 'core', since: 5, lost });
      assert.strictEqual(answered.listenerCount('message'), 0);

      const local = { scope: 'process', ...lossCounter.snapshot() };
      const silent = handle(() => true);
      assert.deepStrictEqual(await readLossStatus({ processHandle: silent, isWorker: true, timeoutMs: 30 }), local);
      assert.strictEqual(silent.listenerCount('message'), 0);
      const closed = handle((_p, _m, cb) => cb(new Error('ERR_IPC_CHANNEL_CLOSED')));
      assert.deepStrictEqual(await readLossStatus({ processHandle: closed, isWorker: true }), local);
      const throwing = handle(() => { throw new Error('no channel'); });
      assert.deepStrictEqual(await readLossStatus({ processHandle: throwing, isWorker: true }), local);
      assert.deepStrictEqual(await readLossStatus({ processHandle: silent, isWorker: false }), local);
    });

    it('[ALRW8] bin/master.js keeps the totals of the core', function () {
      const source = fs.readFileSync(path.resolve(__dirname, '../../../bin/master.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const primary = source.indexOf('if (cluster.isPrimary) {');
      const worker = source.indexOf('\n} else {', primary);
      const attached = source.indexOf("\n    require('audit/src/lossAggregator.ts').attach(cluster);\n");
      assert.ok(primary !== -1 && worker > primary, 'the two branches of master.js are found');
      assert.ok(attached > primary && attached < worker, 'attached in the primary branch');
    });

    it('[ALRW6] on a real cluster: totals of the core, kept when a worker leaves', async function () {
      const out = await new Promise((resolve, reject) => {
        execFile(process.execPath, [path.join(__dirname, 'support/auditLossCluster.js')], { timeout: 40_000 },
          (err, stdout, stderr) => err != null ? reject(new Error(err.message + '\n' + stderr)) : resolve(stdout));
      });
      const lines = out.trim().split('\n').map((line) => JSON.parse(line));
      const status = lines.find((line) => line.status != null).status;
      // A loss on a channel that is gone, or closing, must not stop the worker.
      assert.deepStrictEqual(lines.find((line) => line.late != null), { late: 2, connected: false });
      assert.deepStrictEqual(lines.find((line) => line.exit != null), { exit: 0, signal: null });
      assert.strictEqual(status.scope, 'core');
      assert.strictEqual(status.lost.total, 3);
      assert.deepStrictEqual(status.lost.byKind, { valid: 1, error: 1, event: 1 });
      assert.deepStrictEqual(status.lost.byReason, {
        'storage-write-failed': 2, 'storage-unavailable': 0, 'invalid-record': 1, 'syslog-failed': 0
      });
    });
  });
});
