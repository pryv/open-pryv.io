/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin: the outbox of revoke notices sent while an account is deleted
 * (the account's own queue is gone with it). Same schedule and verdicts as a
 * delivery record; a delivered row is deleted.
 */

const assert = require('node:assert/strict');
const {
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_BACKOFF_BASE_MS,
  DELIVERY_STALE_AFTER_MS,
  DELIVERY_RETRY_AFTER_MAX_MS,
  FAILED_RETENTION_MS,
  STALE_REASON,
  nextDeliveryAttemptAt,
  enqueueDeletionNotice,
  runDeletionOutboxPass,
} = require('../src/retryQueue.ts');

const ENDPOINT = 'https://peer-tok@peer.example.com/bob/';
const HOST = 'https://peer.example.com/bob/';
const BODY = { streamIds: [':_cmc:inbox'], type: 'consent/revoke-cmc', content: { accessId: 'acc-1', revokedAt: 1760000000.5 } };

// In-memory DeletionNoticesLocalDB (the engine classes have their own conformance suite).
function fakeOutbox () {
  const rows = new Map();
  return {
    rows,
    async insert (row) { rows.set(row.id, structuredClone(row)); },
    async listDue (now, limit) {
      return [...rows.values()].filter((r) => r.status === 'pending' && r.nextAttemptAfter <= now)
        .sort((a, b) => a.createdAt - b.createdAt).slice(0, limit).map((r) => structuredClone(r));
    },
    async countPending () { return [...rows.values()].filter((r) => r.status === 'pending').length; },
    async update (row) { if (!rows.has(row.id)) return false; rows.set(row.id, structuredClone(row)); return true; },
    async delete (id) { return rows.delete(id); },
    async pruneFailedBefore (ts) {
      let n = 0;
      for (const [id, r] of rows) if (r.status === 'failed-permanent' && r.createdAt < ts) { rows.delete(id); n++; }
      return n;
    },
  };
}

// A peer answering `spec` ({ status, body?, headers? }, an Error, or a function of the call number).
function peer (plan) {
  const calls = [];
  return {
    calls,
    async fetch (url, init) {
      calls.push({ url, init });
      const spec = typeof plan === 'function' ? plan(calls.length) : plan;
      if (spec instanceof Error) throw spec;
      return {
        status: spec.status,
        ok: spec.status < 300,
        headers: { get: (name) => (spec.headers ?? {})[name.toLowerCase()] ?? null },
        async json () { return spec.body ?? {}; },
        async text () { return JSON.stringify(spec.body ?? {}); },
      };
    },
  };
}

function logger () {
  const lines = [];
  const at = (level) => (msg, ctx) => lines.push({ level, msg, ctx });
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

function depsOf (p, now, log) {
  return { mall: null, dispatch: async () => { throw new Error('never dispatched'); }, dispatchDeps: { fetch: p.fetch }, now: () => now, logger: log };
}

async function queued (outbox, now, overrides = {}) {
  const row = await enqueueDeletionNotice({
    deletedUserId: 'gone-user',
    accessId: 'acc-1',
    delivery: { apiEndpoint: ENDPOINT, path: 'events', body: BODY },
    failureReason: 'network',
    failureDetail: { status: 0 },
    deps: { outbox, now: () => now },
    ...overrides,
  });
  return row;
}

describe('[CMCOB] CMC deletion outbox: revoke notices of a deleted account', () => {
  it('[OBX01] queued with the endpoint and the body, due a minute later; the log names the host, never the token', async () => {
    const outbox = fakeOutbox();
    const log = logger();
    const t = 5_000_000;
    const row = await enqueueDeletionNotice({
      deletedUserId: 'gone-user',
      accessId: 'acc-1',
      delivery: { apiEndpoint: ENDPOINT, path: 'events', body: BODY },
      failureReason: 'network',
      deps: { outbox, now: () => t, logger: log },
    });
    const stored = outbox.rows.get(row.id);
    assert.equal(typeof row.id, 'string');
    assert.deepEqual(stored, {
      id: row.id,
      deletedUserId: 'gone-user',
      accessId: 'acc-1',
      apiEndpoint: ENDPOINT,
      path: 'events',
      body: BODY,
      attempts: 1,
      nextAttemptAfter: t + DELIVERY_BACKOFF_BASE_MS,
      status: 'pending',
      lastFailureReason: 'network',
      lastFailureDetail: null,
      createdAt: t,
    });
    assert.ok(!JSON.stringify(log.lines).includes('peer-tok'), 'the token is never logged');
    assert.equal(log.lines[0].ctx.host, HOST);
  });

  it('[OBX02] a Retry-After of the first attempts is honoured on the first due time, capped', async () => {
    const outbox = fakeOutbox();
    const a = await queued(outbox, 0, { failureReason: 'http-retry-later', failureDetail: { status: 429, retryAfterMs: 300_000 } });
    assert.equal(a.nextAttemptAfter, 300_000);
    const b = await queued(outbox, 0, { failureReason: 'http-retry-later', failureDetail: { status: 429, retryAfterMs: 86_400_000 } });
    assert.equal(b.nextAttemptAfter, DELIVERY_RETRY_AFTER_MAX_MS);
  });

  it('[OBX03] a due row delivered is deleted; the request is the stored one; a row not due is left alone', async () => {
    const outbox = fakeOutbox();
    const row = await queued(outbox, 0);
    const later = await queued(outbox, 10 * DELIVERY_BACKOFF_BASE_MS);
    const p = peer({ status: 201 });
    const r = await runDeletionOutboxPass({ outbox, deps: depsOf(p, DELIVERY_BACKOFF_BASE_MS, logger()) });
    assert.equal(r.processed, 1);
    assert.equal(r.succeeded, 1);
    assert.equal(r.pendingTotal, 1);
    assert.equal(outbox.rows.has(row.id), false);
    assert.equal(outbox.rows.has(later.id), true);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].url, HOST + 'events');
    assert.equal(p.calls[0].init.headers.authorization, 'peer-tok');
    assert.deepEqual(JSON.parse(p.calls[0].init.body), BODY);
  });

  it('[OBX04] a peer still down reschedules on the delivery schedule, then failed-permanent after the last attempt, host only kept', async () => {
    const outbox = fakeOutbox();
    const log = logger();
    const row = await queued(outbox, 0);
    const p = peer({ status: 503 });
    let t = row.nextAttemptAfter;
    for (let attempt = 2; attempt <= DELIVERY_MAX_ATTEMPTS; attempt++) {
      const r = await runDeletionOutboxPass({ outbox, deps: depsOf(p, t, log) });
      assert.equal(r.rescheduled, 1, `attempt ${attempt} rescheduled`);
      const stored = outbox.rows.get(row.id);
      assert.equal(stored.attempts, attempt);
      assert.equal(stored.nextAttemptAfter, nextDeliveryAttemptAt({ attempts: attempt, now: t }));
      assert.equal(stored.apiEndpoint, ENDPOINT, 'the token stays while pending');
      assert.deepEqual(stored.lastFailureDetail, { peerReason: 'http-5xx', status: 503 });
      t = stored.nextAttemptAfter;
    }
    // A schedule this long stays inside the stale threshold.
    assert.ok(t - row.createdAt < DELIVERY_STALE_AFTER_MS);
    const r = await runDeletionOutboxPass({ outbox, deps: depsOf(p, t, log) });
    assert.equal(r.failedPermanent, 1);
    const stored = outbox.rows.get(row.id);
    assert.equal(stored.status, 'failed-permanent');
    assert.equal(stored.attempts, DELIVERY_MAX_ATTEMPTS);
    assert.equal(stored.apiEndpoint, HOST);
    assert.equal(p.calls.length, DELIVERY_MAX_ATTEMPTS);
    const warn = log.lines.find((l) => l.level === 'warn' && /failed-permanent/.test(l.msg));
    assert.equal(warn.ctx.deletedUserId, 'gone-user');
    assert.equal(warn.ctx.host, HOST);
    assert.ok(!JSON.stringify(log.lines).includes('peer-tok'));
  });

  it('[OBX05] a 4xx is the peer\'s answer: failed-permanent at once, credential stripped', async () => {
    const outbox = fakeOutbox();
    const row = await queued(outbox, 0);
    const r = await runDeletionOutboxPass({ outbox, deps: depsOf(peer({ status: 400, body: { error: { id: 'invalid-parameters-format' } } }), row.nextAttemptAfter, logger()) });
    assert.equal(r.failedPermanent, 1);
    const stored = outbox.rows.get(row.id);
    assert.equal(stored.status, 'failed-permanent');
    assert.equal(stored.apiEndpoint, HOST);
    assert.equal(stored.lastFailureReason, 'network');
    assert.deepEqual(stored.lastFailureDetail, { peerReason: 'http-4xx', status: 400 });
  });

  it('[OBX06] 403 invalid-access-token: the peer access is already gone, the row is settled (deleted); a 403 forbidden is not', async () => {
    const outbox = fakeOutbox();
    const gone = await queued(outbox, 0);
    const p = peer({ status: 403, body: { error: { id: 'invalid-access-token', message: 'Cannot find access from token.' } } });
    let r = await runDeletionOutboxPass({ outbox, deps: depsOf(p, gone.nextAttemptAfter, logger()) });
    assert.equal(r.settled, 1);
    assert.equal(r.failedPermanent, 0);
    assert.equal(outbox.rows.has(gone.id), false);

    const forbidden = await queued(outbox, 0);
    r = await runDeletionOutboxPass({ outbox, deps: depsOf(peer({ status: 403, body: { error: { id: 'forbidden' } } }), forbidden.nextAttemptAfter, logger()) });
    assert.equal(r.settled, 0);
    assert.equal(r.failedPermanent, 1);
    assert.equal(outbox.rows.get(forbidden.id).status, 'failed-permanent');
  });

  it('[OBX07] 429 / 408 reschedule with the Retry-After honoured and capped; a network error or timeout reschedules', async () => {
    const outbox = fakeOutbox();
    const row = await queued(outbox, 0);
    let t = row.nextAttemptAfter;
    await runDeletionOutboxPass({ outbox, deps: depsOf(peer({ status: 429, headers: { 'retry-after': '600' } }), t, logger()) });
    let stored = outbox.rows.get(row.id);
    assert.equal(stored.nextAttemptAfter, t + 600_000);
    assert.deepEqual(stored.lastFailureDetail, { peerReason: 'http-retry-later', status: 429, retryAfterMs: 600_000 });
    t = stored.nextAttemptAfter;
    await runDeletionOutboxPass({ outbox, deps: depsOf(peer({ status: 408, headers: { 'retry-after': '86400' } }), t, logger()) });
    stored = outbox.rows.get(row.id);
    assert.equal(stored.nextAttemptAfter, t + DELIVERY_RETRY_AFTER_MAX_MS);
    t = stored.nextAttemptAfter;
    const r = await runDeletionOutboxPass({ outbox, deps: depsOf(peer(new Error('ECONNREFUSED')), t, logger()) });
    assert.equal(r.rescheduled, 1);
    assert.equal(outbox.rows.get(row.id).status, 'pending');
  });

  it('[OBX08] a row older than its whole schedule is retired unsent; failed rows past the retention are pruned', async () => {
    const outbox = fakeOutbox();
    const stale = await queued(outbox, 0);
    const p = peer({ status: 201 });
    const t = DELIVERY_STALE_AFTER_MS + 1;
    let r = await runDeletionOutboxPass({ outbox, deps: depsOf(p, t, logger()) });
    assert.equal(p.calls.length, 0, 'never sent');
    assert.equal(r.failedPermanent, 1);
    const stored = outbox.rows.get(stale.id);
    assert.equal(stored.status, 'failed-permanent');
    assert.equal(stored.lastFailureReason, STALE_REASON);
    assert.equal(stored.apiEndpoint, HOST);

    const recentFailed = await queued(outbox, t);
    await outbox.update({ ...outbox.rows.get(recentFailed.id), status: 'failed-permanent' });
    r = await runDeletionOutboxPass({ outbox, deps: depsOf(p, FAILED_RETENTION_MS + 1, logger()) });
    assert.equal(r.pruned, 1);
    assert.equal(outbox.rows.has(stale.id), false);
    assert.equal(outbox.rows.has(recentFailed.id), true);
  });

  it('[OBX09] a refused destination is failed-permanent with its own reason; one row throwing does not stop the pass', async () => {
    const outbox = fakeOutbox();
    const a = await queued(outbox, 0);
    const b = await queued(outbox, 1);
    const refusing = { fetch: async () => { const e = new Error('refused'); e.code = 'EPEERREFUSED'; e.kind = 'address'; e.host = 'peer.example.com'; throw e; } };
    const flaky = { ...outbox, update: async (row) => { if (row.id === a.id) throw new Error('disk full'); return outbox.update(row); } };
    const r = await runDeletionOutboxPass({ outbox: flaky, deps: depsOf(refusing, b.nextAttemptAfter, logger()) });
    assert.equal(r.processed, 2);
    assert.equal(r.failedPermanent, 1);
    assert.equal(outbox.rows.get(b.id).lastFailureReason, 'cmc-handler-destination-refused');
    assert.equal(outbox.rows.get(a.id).status, 'pending', 'its update threw, left for a later pass');
  });
});
