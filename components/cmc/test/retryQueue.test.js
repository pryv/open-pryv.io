/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — retry queue tests.
 *
 * [CMCRQ] covers backoff math, enqueue policy (skip non-retryable),
 * processRetryEvent state-machine, and the full runRetryLoop pass.
 */

const assert = require('node:assert/strict');
const {
  MAX_ATTEMPTS,
  MAX_DELAY_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MULTIPLIER,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_MAX_DELAY_MS,
  DELIVERY_BACKOFF_BASE_MS,
  nextAttemptAt,
  nextDeliveryAttemptAt,
  isRetryableReason,
  enqueueRetry,
  enqueueDelivery,
  processRetryEvent,
  runRetryLoop,
} = require('../src/retryQueue.ts');
const { assertEventUpdateShape, fakeUpdateWithMerge } = require('./_fake-assertions.cjs');

function fakeMall () {
  const events = new Map();
  let seq = 0;
  return {
    events: {
      async updateWithMerge (...a) { return fakeUpdateWithMerge(this, ...a); },
      async create (_userId, params) {
        const id = 'r-' + (++seq);
        const ev = { id, ...params };
        events.set(id, ev);
        return ev;
      },
      async update (_userId, params) {
        assertEventUpdateShape(params);
        const ev = events.get(params.id);
        if (ev == null) throw new Error('no event ' + params.id);
        Object.assign(ev, params);
        if (params.content != null) {
          ev.content = { ...params.content };
        }
        return ev;
      },
      async get (_userId, params) {
        // The real mall takes stream queries only: a bare id resolves no store.
        assert.ok(params?.streams == null || params.streams.every((q) => q != null && typeof q === 'object'),
          'mall.events.get needs stream queries ({ any: [...] }), got ' + JSON.stringify(params?.streams));
        return Array.from(events.values());
      },
    },
    _events: events,
  };
}

// A received accept, as the requester's core records it: on the capability's
// responses stream (an accept on `:_cmc:inbox` is the server's own mirror,
// never retried, see [RQ30]).
const RESPONSES_STREAM = ':_cmc:_internal:responses:cap-1';

function makeTrigger () {
  return {
    id: 'orig-1',
    type: 'consent/accept-cmc',
    streamIds: [RESPONSES_STREAM],
    content: { capabilityUrl: 'https://t@peer.example.com/' },
  };
}

describe('[CMCRQ] cmc/retryQueue', () => {
  describe('[CMCRQ-BO] backoff math', () => {
    it('[RQ01] nextAttemptAt grows geometrically and caps at MAX_DELAY_MS', () => {
      const now = 100000;
      assert.equal(nextAttemptAt({ attempts: 1, now }) - now, BACKOFF_BASE_MS);
      assert.equal(nextAttemptAt({ attempts: 2, now }) - now, BACKOFF_BASE_MS * BACKOFF_MULTIPLIER);
      assert.equal(nextAttemptAt({ attempts: 3, now }) - now, BACKOFF_BASE_MS * BACKOFF_MULTIPLIER * BACKOFF_MULTIPLIER);
      // High attempt count caps at MAX_DELAY_MS.
      assert.equal(nextAttemptAt({ attempts: 99, now }) - now, MAX_DELAY_MS);
    });
  });

  describe('[CMCRQ-RB] isRetryableReason', () => {
    it('[RQ02] non-retryable reasons are non-retryable', () => {
      assert.equal(isRetryableReason('cmc-handler-wrong-type'), false);
      assert.equal(isRetryableReason('cmc-handler-counterparty-unknown'), false);
      assert.equal(isRetryableReason('cmc-handler-delivery-rejected'), false);
      assert.equal(isRetryableReason('cmc-system-counterparty-access-not-found'), false);
      assert.equal(isRetryableReason('cmc-chat-no-remote-apiendpoint'), false);
      assert.equal(isRetryableReason('cmc-handler-data-grant-name-conflict'), false);
      assert.equal(isRetryableReason('cmc-capability-invalidated'), false);
      assert.equal(isRetryableReason('cmc-capability-invalid'), false);
      assert.equal(isRetryableReason('cmc-capability-consumed'), false);
      assert.equal(isRetryableReason('cmc-capability-already-accepted-by-you'), false);
    });
    it('[RQ03] delivery-failed with peer 5xx / network / timeout is retryable', () => {
      assert.equal(isRetryableReason('cmc-handler-delivery-failed', { peerReason: 'http-5xx' }), true);
      assert.equal(isRetryableReason('cmc-handler-delivery-failed', { peerReason: 'network' }), true);
      assert.equal(isRetryableReason('cmc-handler-delivery-failed', { peerReason: 'timeout' }), true);
    });
    it('[RQ04] delivery-failed with peer 4xx is non-retryable', () => {
      assert.equal(isRetryableReason('cmc-handler-delivery-failed', { peerReason: 'http-4xx' }), false);
    });
  });

  describe('[CMCRQ-EQ] enqueueRetry', () => {
    it('[RQ05] enqueues a retry event with attempts=1 + correct nextAttemptAfter', async () => {
      const mall = fakeMall();
      const now = 1_000_000;
      const ev = await enqueueRetry({
        userId: 'u1',
        trigger: makeTrigger(),
        failureReason: 'cmc-handler-delivery-failed',
        failureDetail: { peerReason: 'http-5xx' },
        deps: { mall, dispatch: async () => ({}), dispatchDeps: {}, now: () => now },
      });
      assert.notEqual(ev, null);
      assert.equal(ev.type, 'cmc-internal/retry-cmc');
      assert.deepEqual(ev.streamIds, [':_cmc:_internal:retries']);
      assert.equal(ev.content.attempts, 1);
      assert.equal(ev.content.status, 'pending');
      assert.equal(ev.content.originalEventId, 'orig-1');
      assert.equal(ev.content.originalType, 'consent/accept-cmc');
      assert.equal(ev.content.nextAttemptAfter, now + BACKOFF_BASE_MS);
      // time stamped on the retry event itself (unix seconds = now ms / 1000)
      // — without it the retry-scheduler's time-ordered query
      // (runRetryLoop) would miss the event entirely.
      assert.equal(ev.time, now / 1000);
    });
    it('[RQ06] returns null + does NOT enqueue when reason is non-retryable', async () => {
      const mall = fakeMall();
      const ev = await enqueueRetry({
        userId: 'u1',
        trigger: makeTrigger(),
        failureReason: 'cmc-handler-counterparty-unknown',
        deps: { mall, dispatch: async () => ({}), dispatchDeps: {}, now: () => 0 },
      });
      assert.equal(ev, null);
      assert.equal(mall._events.size, 0);
    });
    it('[RQ07] returns null when 4xx delivery rejected is the reason', async () => {
      const mall = fakeMall();
      const ev = await enqueueRetry({
        userId: 'u1',
        trigger: makeTrigger(),
        failureReason: 'cmc-handler-delivery-failed',
        failureDetail: { peerReason: 'http-4xx' },
        deps: { mall, dispatch: async () => ({}), dispatchDeps: {}, now: () => 0 },
      });
      assert.equal(ev, null);
    });
  });

  describe('[CMCRQ-PR] processRetryEvent', () => {
    function makeRetryEvent (overrides = {}) {
      return {
        id: 'r-1',
        content: {
          originalEventId: 'orig-1',
          originalType: 'consent/accept-cmc',
          originalStreamIds: [RESPONSES_STREAM],
          originalContent: { capabilityUrl: 'https://t@peer.example.com/' },
          attempts: 1,
          nextAttemptAfter: 0,
          status: 'pending',
          ...overrides,
        },
      };
    }

    it('[RQ30] a retried accept authored by the server is refused, never dispatched: the inbox mirror of a received accept', async () => {
      const mall = fakeMall();
      const dispatched = [];
      const dispatch = async ({ event }) => { dispatched.push(event); return { handled: true, status: 'completed' }; };
      // The mirror as the mall stores it: on `:_cmc:inbox`, createdBy `system`.
      mall._events.set('r-1', makeRetryEvent({ originalStreamIds: [':_cmc:inbox'], originalCreatedBy: 'system' }));
      let r = await processRetryEvent({ userId: 'u1', retryEvent: mall._events.get('r-1'), deps: { mall, dispatch, dispatchDeps: {}, now: () => 10_000 } });
      assert.equal(r.outcome, 'failed-permanent');
      assert.equal(dispatched.length, 0, 'never dispatched');
      let stored = mall._events.get('r-1');
      assert.equal(stored.content.status, 'failed-permanent');
      assert.equal(stored.content.lastFailureReason, 'cmc-retry-system-authored');
      assert.equal(stored.modifiedBy, 'system');
      // A snapshot taken before `originalCreatedBy` existed: the stream says it.
      mall._events.set('r-2', { ...makeRetryEvent({ originalStreamIds: [':_cmc:inbox'] }), id: 'r-2' });
      r = await processRetryEvent({ userId: 'u1', retryEvent: mall._events.get('r-2'), deps: { mall, dispatch, dispatchDeps: {}, now: () => 10_000 } });
      assert.equal(r.outcome, 'failed-permanent');
      assert.equal(dispatched.length, 0);
      stored = mall._events.get('r-2');
      assert.equal(stored.content.lastFailureReason, 'cmc-retry-system-authored');
      assert.equal(isRetryableReason('cmc-retry-system-authored'), false);
      assert.equal(isRetryableReason('cmc-retry-stale'), false);
    });

    it('[RQ31] a retried accept on an app scope authored by the server is refused too; one a client wrote is dispatched', async () => {
      const mall = fakeMall();
      const dispatched = [];
      const dispatch = async ({ event }) => { dispatched.push(event); return { handled: true, status: 'completed' }; };
      // Written by the server on the owner's app scope: would read as the
      // owner's accept and mint a data grant.
      for (const [id, createdBy] of [['r-1', 'system'], ['r-2', 'system some-caller']]) {
        mall._events.set(id, { ...makeRetryEvent({ originalStreamIds: [':_cmc:apps:my-app:study-1'], originalCreatedBy: createdBy }), id });
        const r = await processRetryEvent({ userId: 'u1', retryEvent: mall._events.get(id), deps: { mall, dispatch, dispatchDeps: {}, now: () => 10_000 } });
        assert.equal(r.outcome, 'failed-permanent', createdBy);
        assert.equal(mall._events.get(id).content.lastFailureReason, 'cmc-retry-system-authored');
        assert.deepEqual(mall._events.get(id).content.lastFailureDetail, { originalCreatedBy: createdBy, originalStreamIds: [':_cmc:apps:my-app:study-1'] });
      }
      assert.equal(dispatched.length, 0, 'never dispatched');
      // The owner's own accept (createdBy its personal access), and a
      // received accept on the responses stream: dispatched as before.
      mall._events.set('r-3', { ...makeRetryEvent({ originalStreamIds: [':_cmc:apps:my-app:study-1'], originalCreatedBy: 'acc-personal caller' }), id: 'r-3' });
      mall._events.set('r-4', { ...makeRetryEvent({ originalCreatedBy: 'cap-acc-1' }), id: 'r-4' });
      for (const id of ['r-3', 'r-4']) {
        const r = await processRetryEvent({ userId: 'u1', retryEvent: mall._events.get(id), deps: { mall, dispatch, dispatchDeps: {}, now: () => 10_000 } });
        assert.equal(r.outcome, 'succeeded', id);
      }
      assert.equal(dispatched.length, 2);
      assert.equal(dispatched[0].createdBy, 'acc-personal caller');
      assert.equal(dispatched[1].streamIds[0], RESPONSES_STREAM);
      // Other types written by the server (a sweep record) are not accepts: dispatched.
      mall._events.set('r-5', { ...makeRetryEvent({ originalType: 'consent/member-revoke-cmc', originalStreamIds: [':_cmc:apps:my-app'], originalCreatedBy: 'system' }), id: 'r-5' });
      const r5 = await processRetryEvent({ userId: 'u1', retryEvent: mall._events.get('r-5'), deps: { mall, dispatch, dispatchDeps: {}, now: () => 10_000 } });
      assert.equal(r5.outcome, 'succeeded');
      assert.equal(dispatched.length, 3);
    });

    it('[RQ08] succeeds when dispatch returns status=completed → marks succeeded', async () => {
      const mall = fakeMall();
      mall._events.set('r-1', makeRetryEvent());
      const dispatch = async () => ({ handled: true, status: 'completed' });
      const r = await processRetryEvent({
        userId: 'u1',
        retryEvent: mall._events.get('r-1'),
        deps: { mall, dispatch, dispatchDeps: {}, now: () => 10_000 },
      });
      assert.equal(r.outcome, 'succeeded');
      assert.equal(mall._events.get('r-1').content.status, 'succeeded');
    });

    it('[RQC01] the trigger\'s writer survives the retry: snapshot keeps createdBy, the re-dispatched trigger carries it', async () => {
      const mall = fakeMall();
      const ev = await enqueueRetry({
        userId: 'u1',
        trigger: { ...makeTrigger(), createdBy: 'pat1 caller' },
        failureReason: 'cmc-handler-delivery-failed',
        failureDetail: { peerReason: 'network' },
        deps: { mall, dispatch: async () => ({}), dispatchDeps: {}, now: () => 0 },
      });
      assert.equal(ev.content.originalCreatedBy, 'pat1 caller');
      const seen = [];
      await processRetryEvent({
        userId: 'u1',
        retryEvent: ev,
        deps: { mall, dispatch: async ({ event }) => { seen.push(event); return { handled: true, status: 'completed' }; }, dispatchDeps: {}, now: () => 1_000_000 },
      });
      assert.equal(seen[0].createdBy, 'pat1 caller');
      // a snapshot taken before the field existed re-dispatches without it
      const older = makeRetryEvent();
      mall._events.set('r-1', older);
      const seen2 = [];
      await processRetryEvent({
        userId: 'u1',
        retryEvent: older,
        deps: { mall, dispatch: async ({ event }) => { seen2.push(event); return { handled: true, status: 'completed' }; }, dispatchDeps: {}, now: () => 10_000 },
      });
      assert.equal('createdBy' in seen2[0], false);
      // an accept given through an ended delegation is not retried
      assert.equal(isRetryableReason('cmc-handler-delegation-ended'), false);
    });

    it('[RQ16] the re-dispatch carries the previous attempt as retryContext, beside the other deps', async () => {
      const mall = fakeMall();
      const detail = { accessIds: ['acc-1'], peerNotified: true };
      mall._events.set('r-1', makeRetryEvent({ attempts: 2, lastFailureReason: 'cmc-revoke-delete-failed', lastFailureDetail: detail }));
      const dispatchDeps = { marker: 'kept' };
      const seen = [];
      await processRetryEvent({
        userId: 'u1',
        retryEvent: mall._events.get('r-1'),
        deps: { mall, dispatch: async ({ deps }) => { seen.push(deps); return { handled: true, status: 'completed' }; }, dispatchDeps, now: () => 10_000_000 },
      });
      assert.equal(seen[0].marker, 'kept');
      assert.deepEqual(seen[0].retryContext, { attempts: 2, lastFailureReason: 'cmc-revoke-delete-failed', lastFailureDetail: detail });
      assert.equal('retryContext' in dispatchDeps, false, 'the shared deps are not mutated');
    });

    it('[RQ09] reschedules when dispatch still fails retryably', async () => {
      const mall = fakeMall();
      mall._events.set('r-1', makeRetryEvent());
      const dispatch = async () => ({
        handled: true,
        status: 'failed',
        reason: 'cmc-handler-delivery-failed',
        detail: { peerReason: 'http-5xx' },
      });
      const r = await processRetryEvent({
        userId: 'u1',
        retryEvent: mall._events.get('r-1'),
        deps: { mall, dispatch, dispatchDeps: {}, now: () => 10_000 },
      });
      assert.equal(r.outcome, 'rescheduled');
      assert.equal(r.attempts, 2);
      assert.equal(mall._events.get('r-1').content.attempts, 2);
      // Next attempt scheduled into the future.
      assert.equal(mall._events.get('r-1').content.nextAttemptAfter, 10_000 + BACKOFF_BASE_MS * BACKOFF_MULTIPLIER);
    });

    it('[RQ10] marks failed-permanent when reason becomes non-retryable mid-flight', async () => {
      const mall = fakeMall();
      mall._events.set('r-1', makeRetryEvent());
      const dispatch = async () => ({
        handled: true,
        status: 'failed',
        reason: 'cmc-handler-delivery-rejected', // non-retryable
      });
      const r = await processRetryEvent({
        userId: 'u1',
        retryEvent: mall._events.get('r-1'),
        deps: { mall, dispatch, dispatchDeps: {}, now: () => 0 },
      });
      assert.equal(r.outcome, 'failed-permanent');
      assert.equal(mall._events.get('r-1').content.status, 'failed-permanent');
    });

    it('[RQ11] marks failed-permanent after MAX_ATTEMPTS', async () => {
      const mall = fakeMall();
      mall._events.set('r-1', makeRetryEvent({ attempts: MAX_ATTEMPTS }));
      const dispatch = async () => ({
        handled: true,
        status: 'failed',
        reason: 'cmc-handler-delivery-failed',
        detail: { peerReason: 'http-5xx' },
      });
      const r = await processRetryEvent({
        userId: 'u1',
        retryEvent: mall._events.get('r-1'),
        deps: { mall, dispatch, dispatchDeps: {}, now: () => 0 },
      });
      assert.equal(r.outcome, 'failed-permanent');
      assert.equal(mall._events.get('r-1').content.status, 'failed-permanent');
    });

    it('[RQ12] skips events not yet due', async () => {
      const mall = fakeMall();
      mall._events.set('r-1', makeRetryEvent({ nextAttemptAfter: 100_000 }));
      const dispatch = async () => { throw new Error('should not be called'); };
      const r = await processRetryEvent({
        userId: 'u1',
        retryEvent: mall._events.get('r-1'),
        deps: { mall, dispatch, dispatchDeps: {}, now: () => 1_000 },
      });
      assert.equal(r.outcome, 'skipped-not-due');
    });

    it('[RQ13] skips events that are no longer pending', async () => {
      const mall = fakeMall();
      mall._events.set('r-1', makeRetryEvent({ status: 'succeeded' }));
      const dispatch = async () => { throw new Error('should not be called'); };
      const r = await processRetryEvent({
        userId: 'u1',
        retryEvent: mall._events.get('r-1'),
        deps: { mall, dispatch, dispatchDeps: {}, now: () => 0 },
      });
      assert.equal(r.outcome, 'skipped-non-pending');
    });

    it('[RQ17] each outcome stamps the retry event: modified = write time, modifiedBy = system', async () => {
      const outcomes = [
        ['succeeded', async () => ({ handled: true, status: 'completed' }), {}],
        ['rescheduled', async () => ({ handled: true, status: 'failed', reason: 'cmc-handler-delivery-failed', detail: { peerReason: 'http-5xx' } }), {}],
        ['failed-permanent', async () => ({ handled: true, status: 'failed', reason: 'cmc-handler-delivery-rejected' }), {}],
      ];
      for (const [outcome, dispatch, overrides] of outcomes) {
        const mall = fakeMall();
        mall._events.set('r-1', { ...makeRetryEvent(overrides), modified: 1, modifiedBy: 'system' });
        const r = await processRetryEvent({
          userId: 'u1',
          retryEvent: mall._events.get('r-1'),
          deps: { mall, dispatch, dispatchDeps: {}, now: () => 10_000_000 },
        });
        assert.equal(r.outcome, outcome);
        const stored = mall._events.get('r-1');
        assert.equal(stored.modified, 10_000, outcome + ': modified is the write time (s)');
        assert.equal(stored.modifiedBy, 'system', outcome + ': modifiedBy');
      }
    });
  });

  describe('[CMCRQ-LP] runRetryLoop', () => {
    it('[RQ14] processes all due pending events; non-pending counted as skipped', async () => {
      const mall = fakeMall();
      // Set up 3 pending events (2 due + 1 not yet due) + 1 already-succeeded.
      mall._events.set('r-1', { id: 'r-1', content: { originalEventId: 'a', originalType: 'message/chat-cmc', attempts: 1, nextAttemptAfter: 0, status: 'pending' } });
      mall._events.set('r-2', { id: 'r-2', content: { originalEventId: 'b', originalType: 'message/chat-cmc', attempts: 1, nextAttemptAfter: 0, status: 'pending' } });
      mall._events.set('r-3', { id: 'r-3', content: { originalEventId: 'c', originalType: 'message/chat-cmc', attempts: 1, nextAttemptAfter: 10_000_000, status: 'pending' } });
      mall._events.set('r-4', { id: 'r-4', content: { originalEventId: 'd', originalType: 'message/chat-cmc', attempts: 1, nextAttemptAfter: 0, status: 'succeeded' } });

      let calls = 0;
      const dispatch = async ({ event }) => {
        calls += 1;
        // r-1 succeeds, r-2 fails retryably, r-3 should not be called
        if (event.id === 'a') return { handled: true, status: 'completed' };
        return {
          handled: true,
          status: 'failed',
          reason: 'cmc-handler-delivery-failed',
          detail: { peerReason: 'http-5xx' },
        };
      };
      const summary = await runRetryLoop({
        userId: 'u1',
        deps: { mall, dispatch, dispatchDeps: {}, now: () => 1_000 },
      });
      assert.equal(summary.processed, 2); // r-1, r-2 (pending and due); r-3 is not due
      assert.equal(summary.succeeded, 1);
      assert.equal(summary.rescheduled, 1);
      assert.equal(summary.skipped, 2);   // r-3 not-due + r-4 already-succeeded
      assert.equal(summary.pendingTotal, 3);
      assert.equal(calls, 2);              // only r-1 + r-2 dispatched
    });

    it('[RQ15] swallows handler exceptions in the loop (no event crashes whole pass)', async () => {
      const mall = fakeMall();
      mall._events.set('r-1', { id: 'r-1', content: { originalEventId: 'a', originalType: 'message/chat-cmc', attempts: 1, nextAttemptAfter: 0, status: 'pending' } });
      mall._events.set('r-2', { id: 'r-2', content: { originalEventId: 'b', originalType: 'message/chat-cmc', attempts: 1, nextAttemptAfter: 0, status: 'pending' } });
      const dispatch = async ({ event }) => {
        if (event.id === 'a') throw new Error('boom');
        return { handled: true, status: 'completed' };
      };
      const summary = await runRetryLoop({
        userId: 'u1',
        deps: { mall, dispatch, dispatchDeps: {}, now: () => 1_000 },
      });
      assert.equal(summary.processed, 2);
      assert.equal(summary.succeeded, 1);
    });
  });

  describe('[CMCRQ-DV] delivery records: a notice re-sent as stored, minutes then hours apart', () => {
    const ENDPOINT = 'https://peer-tok@peer.example.com/';
    const BODY = { streamIds: [':_cmc:inbox'], type: 'consent/revoke-cmc', content: { accessId: 'acc-1' } };
    function peer (plan) {
      const calls = [];
      return {
        calls,
        async fetch (url, init) {
          calls.push({ url, init });
          const spec = typeof plan === 'function' ? plan(calls.length) : plan;
          if (spec instanceof Error) throw spec;
          return { status: spec.status, ok: spec.status < 300, async json () { return {}; }, async text () { return '{}'; } };
        },
      };
    }
    function depsOf (mall, p, now) { return { mall, dispatch: async () => { throw new Error('a delivery record is never dispatched'); }, dispatchDeps: { fetch: p.fetch }, now }; }

    it('[RQ20] the schedule runs from a minute to six hours; eight attempts in all', () => {
      const t = 1_000_000;
      assert.equal(nextDeliveryAttemptAt({ attempts: 1, now: t }), t + DELIVERY_BACKOFF_BASE_MS);
      assert.equal(nextDeliveryAttemptAt({ attempts: 2, now: t }), t + 5 * 60_000);
      assert.equal(nextDeliveryAttemptAt({ attempts: 3, now: t }), t + 25 * 60_000);
      assert.equal(nextDeliveryAttemptAt({ attempts: 5, now: t }), t + DELIVERY_MAX_DELAY_MS);
      assert.equal(DELIVERY_MAX_DELAY_MS, 6 * 60 * 60 * 1000);
      assert.equal(DELIVERY_MAX_ATTEMPTS, 8);
    });

    it('[RQ21] queued with the endpoint and the body, due a minute later; the log names the host, never the token', async () => {
      const mall = fakeMall();
      const logged = [];
      const t = 5_000_000;
      const ev = await enqueueDelivery({
        userId: 'u1',
        delivery: { apiEndpoint: ENDPOINT, path: 'events', body: BODY },
        originalEventId: 'rv-1',
        originalType: 'consent/revoke-cmc',
        failureReason: 'http-5xx',
        failureDetail: { status: 503 },
        deps: { mall, now: () => t, logger: { info: (m, d) => logged.push(JSON.stringify([m, d])) } },
      });
      assert.deepEqual(ev.streamIds, [':_cmc:_internal:retries']);
      assert.equal(ev.type, 'cmc-internal/retry-cmc');
      assert.deepEqual(ev.content.delivery, { apiEndpoint: ENDPOINT, path: 'events', body: BODY });
      assert.equal(ev.content.status, 'pending');
      assert.equal(ev.content.attempts, 1);
      assert.equal(ev.content.nextAttemptAfter, t + 60_000);
      assert.equal(ev.content.originalEventId, 'rv-1');
      assert.equal(logged.join('').includes('peer-tok'), false);
      assert.equal(logged.join('').includes('peer.example.com'), true);
    });

    it('[RQ22] once the peer is back the notice lands as stored (the token on the request, the body unchanged), the record is settled and keeps the host only', async () => {
      const mall = fakeMall();
      const ev = await enqueueDelivery({ userId: 'u1', delivery: { apiEndpoint: ENDPOINT, path: 'events', body: BODY }, originalType: 'consent/revoke-cmc', failureReason: 'network', deps: { mall, now: () => 0 } });
      const p = peer({ status: 201 });
      const out = await processRetryEvent({ userId: 'u1', retryEvent: ev, deps: depsOf(mall, p, () => 10 * 60_000) });
      assert.equal(out.outcome, 'succeeded');
      assert.equal(p.calls.length, 1);
      assert.equal(p.calls[0].url, 'https://peer.example.com/events');
      assert.equal(p.calls[0].init.headers.authorization, 'peer-tok');
      assert.deepEqual(JSON.parse(p.calls[0].init.body), BODY);
      const stored = mall._events.get(ev.id).content;
      assert.equal(stored.status, 'succeeded');
      assert.equal(stored.delivery.apiEndpoint, 'https://peer.example.com/');
      assert.equal(JSON.stringify(stored).includes('peer-tok'), false, 'no credential on a settled record');
    });

    it('[RQ23] a peer still down reschedules on the delivery schedule, then failed-permanent after the last attempt; not due is skipped', async () => {
      const mall = fakeMall();
      const ev = await enqueueDelivery({ userId: 'u1', delivery: { apiEndpoint: ENDPOINT, path: 'events', body: BODY }, originalType: 'consent/revoke-cmc', failureReason: 'network', deps: { mall, now: () => 0 } });
      const p = peer(new Error('ECONNREFUSED'));
      let out = await processRetryEvent({ userId: 'u1', retryEvent: ev, deps: depsOf(mall, p, () => 30_000) });
      assert.equal(out.outcome, 'skipped-not-due');
      assert.equal(p.calls.length, 0);
      let t = 60_000;
      for (let attempt = 2; attempt <= DELIVERY_MAX_ATTEMPTS; attempt++) {
        out = await processRetryEvent({ userId: 'u1', retryEvent: mall._events.get(ev.id), deps: depsOf(mall, p, () => t) });
        assert.equal(out.outcome, 'rescheduled', 'attempt ' + attempt);
        const c = mall._events.get(ev.id).content;
        assert.equal(c.attempts, attempt);
        assert.equal(c.nextAttemptAfter, nextDeliveryAttemptAt({ attempts: attempt, now: t }));
        assert.equal(c.delivery.apiEndpoint, ENDPOINT, 'the token stays while pending');
        t = c.nextAttemptAfter;
      }
      out = await processRetryEvent({ userId: 'u1', retryEvent: mall._events.get(ev.id), deps: depsOf(mall, p, () => t) });
      assert.equal(out.outcome, 'failed-permanent');
      const c = mall._events.get(ev.id).content;
      assert.equal(c.status, 'failed-permanent');
      assert.equal(c.attempts, DELIVERY_MAX_ATTEMPTS);
      assert.equal(c.lastFailureReason, 'network');
      assert.deepEqual(c.lastFailureDetail, { peerReason: 'network', status: 0 });
      assert.equal(JSON.stringify(c).includes('peer-tok'), false);
      assert.equal(p.calls.length, DELIVERY_MAX_ATTEMPTS);
    });

    it('[RQ24] a 4xx is the peer\'s answer: failed-permanent at once; the loop carries delivery and trigger records alike', async () => {
      const mall = fakeMall();
      const ev = await enqueueDelivery({ userId: 'u1', delivery: { apiEndpoint: ENDPOINT, path: 'events', body: BODY }, originalType: 'consent/revoke-cmc', failureReason: 'http-5xx', deps: { mall, now: () => 0 } });
      mall._events.set('r-t', { id: 'r-t', content: { originalEventId: 'a', originalType: 'message/chat-cmc', attempts: 1, nextAttemptAfter: 0, status: 'pending' } });
      const p = peer({ status: 400 });
      const dispatched = [];
      const summary = await runRetryLoop({
        userId: 'u1',
        deps: { mall, dispatch: async ({ event }) => { dispatched.push(event.type); return { handled: true, status: 'completed' }; }, dispatchDeps: { fetch: p.fetch }, now: () => 120_000 },
      });
      assert.deepEqual(summary, { processed: 2, succeeded: 1, rescheduled: 0, failedPermanent: 1, skipped: 0, pendingTotal: 2 });
      assert.deepEqual(dispatched, ['message/chat-cmc'], 'the delivery record never goes through the dispatch');
      assert.equal(mall._events.get(ev.id).content.status, 'failed-permanent');
      assert.equal(mall._events.get(ev.id).content.attempts, 1);
    });

    it('[RQ25] a record older than its whole schedule is retired as cmc-retry-stale without a dispatch; a fresh one runs', async () => {
      const mall = fakeMall();
      const day = 24 * 60 * 60 * 1000;
      const now = 10 * day;
      mall._events.set('r-old', { id: 'r-old', time: (now - day) / 1000, content: { originalEventId: 'a', originalType: 'consent/accept-cmc', originalContent: { capabilityUrl: 'https://t@peer/' }, attempts: 2, nextAttemptAfter: 0, status: 'pending' } });
      mall._events.set('r-new', { id: 'r-new', time: (now - 60_000) / 1000, content: { originalEventId: 'b', originalType: 'message/chat-cmc', attempts: 1, nextAttemptAfter: 0, status: 'pending' } });
      const dv = await enqueueDelivery({ userId: 'u1', delivery: { apiEndpoint: ENDPOINT, path: 'events', body: BODY }, originalType: 'consent/revoke-cmc', failureReason: 'network', deps: { mall, now: () => now - 2 * day } });
      const dispatched = [];
      const p = peer({ status: 201 });
      const summary = await runRetryLoop({
        userId: 'u1',
        deps: { mall, dispatch: async ({ event }) => { dispatched.push(event.type); return { handled: true, status: 'completed' }; }, dispatchDeps: { fetch: p.fetch }, now: () => now },
      });
      assert.deepEqual(dispatched, ['message/chat-cmc'], 'the stale accept is never replayed');
      assert.equal(p.calls.length, 0, 'the stale delivery is never sent');
      assert.equal(summary.failedPermanent, 2);
      for (const id of ['r-old', dv.id]) {
        const c = mall._events.get(id).content;
        assert.equal(c.status, 'failed-permanent', id);
        assert.equal(c.lastFailureReason, 'cmc-retry-stale', id);
        assert.equal(c.lastFailureDetail.enqueuedAt, mall._events.get(id).time);
      }
      assert.equal(JSON.stringify(mall._events.get(dv.id).content).includes('peer-tok'), false, 'the token leaves a retired delivery');
      assert.equal(mall._events.get('r-new').content.status, 'succeeded');
    });

    it('[RQ26] every write on a retry record skips event versioning (the record holds a peer token)', async () => {
      const mall = fakeMall();
      const opts = [];
      const update = mall.events.update.bind(mall.events);
      mall.events.update = async (userId, params, transaction, o) => { opts.push(o); return update(userId, params); };
      const ev = await enqueueDelivery({ userId: 'u1', delivery: { apiEndpoint: ENDPOINT, path: 'events', body: BODY }, originalType: 'consent/revoke-cmc', failureReason: 'network', deps: { mall, now: () => 0 } });
      const outcomes = {
        again: { handled: true, status: 'failed', reason: 'cmc-delivery-failed', detail: { peerReason: 'network' } },
        done: { handled: true, status: 'completed' },
        never: { handled: true, status: 'failed', reason: 'cmc-handler-wrong-type' },
      };
      for (const id of Object.keys(outcomes)) {
        mall._events.set('r-' + id, { id: 'r-' + id, time: 0, content: { originalEventId: id, originalType: 'message/chat-cmc', attempts: 1, nextAttemptAfter: 0, status: 'pending' } });
      }
      const p = peer(new Error('down'));
      const summary = await runRetryLoop({ userId: 'u1', deps: { mall, dispatch: async ({ event }) => outcomes[event.id], dispatchDeps: { fetch: p.fetch }, now: () => 120_000 } });
      assert.deepEqual([summary.succeeded, summary.rescheduled, summary.failedPermanent], [1, 2, 1], JSON.stringify(summary));
      assert.equal(opts.length, 4, 'a reschedule, a success, a failed-permanent and the delivery reschedule');
      for (const o of opts) assert.deepEqual(o, { skipVersioning: true });
      assert.equal(mall._events.get(ev.id).content.attempts, 2);
    });

    // A paged read of the fake, newest first, like the real mall.
    function paged (mall) {
      const get = mall.events.get.bind(mall.events);
      mall.events.get = async (userId, params) => {
        const all = (await get(userId, params)).slice().reverse();
        return all.slice(params.skip ?? 0, (params.skip ?? 0) + (params.limit ?? all.length));
      };
    }

    it('[RQ27] the loop reads the whole stream in pages: a pending delivery behind 450 newer terminal records is processed; succeeded records and failed-permanent ones past their retention are pruned after the paging, so no page shifts under the read', async () => {
      const mall = fakeMall();
      const deleted = [];
      mall.events.delete = async (userId, ev) => { deleted.push(ev.id); mall._events.delete(ev.id); };
      paged(mall);
      const now = 100 * 24 * 60 * 60 * 1000;
      const ev = await enqueueDelivery({ userId: 'u1', delivery: { apiEndpoint: ENDPOINT, path: 'events', body: BODY }, originalType: 'consent/revoke-cmc', failureReason: 'network', deps: { mall, now: () => now - 120_000 } });
      // 450 newer terminal records: three pages, prunable ones on every page.
      for (let i = 0; i < 450; i++) {
        const old = i % 3 === 0;
        mall._events.set('t-' + i, { id: 't-' + i, time: (now - (old ? 40 : 1) * 24 * 60 * 60 * 1000) / 1000, content: { originalType: 'message/chat-cmc', attempts: 1, status: i % 2 === 0 ? 'succeeded' : 'failed-permanent' } });
      }
      const p = peer({ status: 201 });
      const summary = await runRetryLoop({ userId: 'u1', deps: { mall, dispatch: async () => { throw new Error('no trigger here'); }, dispatchDeps: { fetch: p.fetch }, now: () => now }, limit: 100 });
      assert.equal(summary.succeeded, 1, JSON.stringify(summary));
      assert.equal(mall._events.get(ev.id).content.status, 'succeeded');
      const succeededCount = 225;
      const oldFailed = [...Array(450).keys()].filter((i) => i % 2 === 1 && i % 3 === 0).length;
      assert.equal(deleted.length, succeededCount + oldFailed, 'succeeded pruned at once, failed-permanent past 30 days pruned, none missed across the page boundaries');
      assert.equal(mall._events.has('t-1'), true, 'a recent failed-permanent record stays for the operator');
    });

    it('[RQ28] only due records fill the window: 150 newer pending records scheduled hours ahead do not hide one older due delivery', async () => {
      const mall = fakeMall();
      paged(mall);
      const now = 100 * 24 * 60 * 60 * 1000;
      const ev = await enqueueDelivery({ userId: 'u1', delivery: { apiEndpoint: ENDPOINT, path: 'events', body: BODY }, originalType: 'consent/revoke-cmc', failureReason: 'network', deps: { mall, now: () => now - 120_000 } });
      for (let i = 0; i < 150; i++) {
        mall._events.set('d-' + i, { id: 'd-' + i, time: (now - 60_000) / 1000, content: { originalType: 'consent/revoke-cmc', delivery: { apiEndpoint: ENDPOINT, path: 'events', body: BODY }, attempts: 2, nextAttemptAfter: now + 5 * 60 * 60 * 1000, status: 'pending' } });
      }
      const p = peer({ status: 201 });
      const summary = await runRetryLoop({ userId: 'u1', deps: { mall, dispatch: async () => { throw new Error('no trigger here'); }, dispatchDeps: { fetch: p.fetch }, now: () => now }, limit: 100 });
      assert.equal(p.calls.length, 1, 'the one due delivery was sent');
      assert.equal(mall._events.get(ev.id).content.status, 'succeeded');
      assert.deepEqual([summary.processed, summary.succeeded, summary.skipped, summary.pendingTotal], [1, 1, 150, 151], JSON.stringify(summary));
    });

    it('[RQ29] due records are processed oldest first (the oldest are the closest to the stale threshold), whatever the read order', async () => {
      const mall = fakeMall();
      paged(mall);
      const now = 100 * 24 * 60 * 60 * 1000;
      // Inserted oldest first; the paged read returns them newest first.
      for (const [i, ageMin] of [[0, 300], [1, 120], [2, 10]]) {
        mall._events.set('o-' + i, { id: 'o-' + i, time: (now - ageMin * 60_000) / 1000, content: { originalType: 'consent/revoke-cmc', delivery: { apiEndpoint: 'https://tok@peer' + i + '.example.com/', path: 'events', body: BODY }, attempts: 2, nextAttemptAfter: now - 1_000, status: 'pending' } });
      }
      const p = peer({ status: 201 });
      const summary = await runRetryLoop({ userId: 'u1', deps: { mall, dispatch: async () => { throw new Error('no trigger here'); }, dispatchDeps: { fetch: p.fetch }, now: () => now } });
      assert.equal(summary.succeeded, 3, JSON.stringify(summary));
      assert.deepEqual(p.calls.map((c) => new URL(c.url).hostname), ['peer0.example.com', 'peer1.example.com', 'peer2.example.com']);
    });
  });
});
