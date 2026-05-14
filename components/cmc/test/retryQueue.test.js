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
  nextAttemptAt,
  isRetryableReason,
  enqueueRetry,
  processRetryEvent,
  runRetryLoop,
} = require('../src/retryQueue.ts');

function fakeMall () {
  const events = new Map();
  let seq = 0;
  return {
    events: {
      async create (_userId, params) {
        const id = 'r-' + (++seq);
        const ev = { id, ...params };
        events.set(id, ev);
        return ev;
      },
      async update (_userId, params) {
        const ev = events.get(params.id);
        if (ev == null) throw new Error('no event ' + params.id);
        Object.assign(ev, params);
        if (params.content != null) {
          ev.content = { ...params.content };
        }
        return ev;
      },
      async get (_userId, _params) {
        return Array.from(events.values());
      },
    },
    _events: events,
  };
}

function makeTrigger () {
  return {
    id: 'orig-1',
    type: 'cmc/accept-v1',
    streamIds: [':_cmc:inbox'],
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
      assert.equal(ev.type, 'cmc/retry-v1');
      assert.deepEqual(ev.streamIds, [':_cmc:_internal:retries']);
      assert.equal(ev.content.attempts, 1);
      assert.equal(ev.content.status, 'pending');
      assert.equal(ev.content.originalEventId, 'orig-1');
      assert.equal(ev.content.originalType, 'cmc/accept-v1');
      assert.equal(ev.content.nextAttemptAfter, now + BACKOFF_BASE_MS);
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
          originalType: 'cmc/accept-v1',
          originalStreamIds: [':_cmc:inbox'],
          originalContent: { capabilityUrl: 'https://t@peer.example.com/' },
          attempts: 1,
          nextAttemptAfter: 0,
          status: 'pending',
          ...overrides,
        },
      };
    }

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
  });

  describe('[CMCRQ-LP] runRetryLoop', () => {
    it('[RQ14] processes all due pending events; non-pending counted as skipped', async () => {
      const mall = fakeMall();
      // Set up 3 pending events (2 due + 1 not yet due) + 1 already-succeeded.
      mall._events.set('r-1', { id: 'r-1', content: { originalEventId: 'a', originalType: 'cmc/chat-v1', attempts: 1, nextAttemptAfter: 0, status: 'pending' } });
      mall._events.set('r-2', { id: 'r-2', content: { originalEventId: 'b', originalType: 'cmc/chat-v1', attempts: 1, nextAttemptAfter: 0, status: 'pending' } });
      mall._events.set('r-3', { id: 'r-3', content: { originalEventId: 'c', originalType: 'cmc/chat-v1', attempts: 1, nextAttemptAfter: 10_000_000, status: 'pending' } });
      mall._events.set('r-4', { id: 'r-4', content: { originalEventId: 'd', originalType: 'cmc/chat-v1', attempts: 1, nextAttemptAfter: 0, status: 'succeeded' } });

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
      assert.equal(summary.processed, 3); // r-1, r-2, r-3 (all pending)
      assert.equal(summary.succeeded, 1);
      assert.equal(summary.rescheduled, 1);
      assert.equal(summary.skipped, 2);   // r-3 not-due + r-4 already-succeeded
      assert.equal(calls, 2);              // only r-1 + r-2 dispatched
    });

    it('[RQ15] swallows handler exceptions in the loop (no event crashes whole pass)', async () => {
      const mall = fakeMall();
      mall._events.set('r-1', { id: 'r-1', content: { originalEventId: 'a', originalType: 'cmc/chat-v1', attempts: 1, nextAttemptAfter: 0, status: 'pending' } });
      mall._events.set('r-2', { id: 'r-2', content: { originalEventId: 'b', originalType: 'cmc/chat-v1', attempts: 1, nextAttemptAfter: 0, status: 'pending' } });
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
});
