/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger } from './_types.ts';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — outbound retry queue.
 *
 * Zero new storage primitive: retry "queue" is just events in a hidden
 * companion stream `:_cmc:_internal:retries` (one event per pending
 * retry). The event content carries:
 *
 *   - originalEventId      : the trigger event we're re-attempting
 *   - originalType         : the cmc/* event type (e.g. consent/accept-cmc)
 *   - originalStreamIds    : original streamIds (for re-dispatch context)
 *   - originalContent      : original trigger content (so dispatch can
 *                            re-run with the same payload even if the
 *                            trigger event has been GC'd)
 *   - attempts             : number of attempts so far (1-based)
 *   - lastFailureReason    : reason string from last attempt
 *   - lastFailureDetail    : detail object (optional)
 *   - nextAttemptAfter     : ms-epoch; loop skips events with future timestamps
 *   - status               : 'pending' | 'succeeded' | 'failed-permanent'
 *
 * Backoff schedule (ms): 1_000, 5_000, 25_000, 125_000, 600_000 — capped
 * at MAX_DELAY_MS = 10 minutes. After MAX_ATTEMPTS = 6 the event is
 * marked 'failed-permanent' and stops getting picked up; operator can
 * decide whether to delete or hand-process.
 *
 * The loop is run by master workers on an interval (Phase H wires the
 * actual scheduling). This module is pure: it depends only on mall and
 * an injected dispatch function.
 */

const C = require('./constants.ts');
const { isRetryableFailure } = require('./outbound.ts');

const MAX_ATTEMPTS = 6;
const MAX_DELAY_MS = 10 * 60 * 1000; // 10 min
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MULTIPLIER = 5;


type EventLike = {
  id?: string;
  streamIds?: string[];
  type: string;
  content: Record<string, unknown>;
  time?: number;
};

type RetryEvent = EventLike & { content: RetryContent };
type RetryContent = {
  originalEventId?: string | null;
  originalType?: string;
  originalStreamIds?: string[];
  originalContent?: Record<string, unknown> | null;
  attempts?: number;
  lastFailureReason?: string;
  lastFailureDetail?: unknown;
  nextAttemptAfter?: number;
  status: 'pending' | 'succeeded' | 'failed-permanent';
};

type MallParams = Record<string, unknown>;
type MallLike = {
  events: {
    create: (userId: string, params: MallParams) => Promise<EventLike>;
    update: (userId: string, params: MallParams) => Promise<unknown>;
    get: (userId: string, params?: MallParams) => Promise<RetryEvent[]>;
  };
};

type DispatchFn = (params: {
  userId: string;
  event: EventLike;
  deps: unknown;
}) => Promise<{
  handled: boolean;
  status: string;
  reason?: string;
  detail?: { peerReason?: string } | null;
}>;

type RetryDeps = {
  mall: MallLike;
  dispatch: DispatchFn;
  dispatchDeps: unknown;          // forwarded into dispatch
  now?: () => number;
  logger?: CmcLogger;
};

/**
 * Compute the next-attempt-after timestamp given attempts count.
 *
 * attempts is 1-based: the FIRST retry (attempts=1) waits BACKOFF_BASE_MS;
 * the second waits BASE * MULTIPLIER, capped at MAX_DELAY_MS.
 */
function nextAttemptAt (params: { attempts: number; now: number }): number {
  const { attempts, now } = params;
  // For attempts=1 → base, attempts=2 → base*5, attempts=3 → base*25, ...
  const delay = Math.min(
    BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, Math.max(0, attempts - 1)),
    MAX_DELAY_MS
  );
  return now + delay;
}

/**
 * Enqueue a retry event after a handler returned a retryable failure.
 *
 * If the failure was non-retryable (4xx-style) we skip enqueueing and
 * return null. The caller can then mark the trigger as 'failed' directly.
 *
 * Returns the created retry event (or null when skipped).
 */
async function enqueueRetry (params: {
  userId: string;
  trigger: EventLike;
  failureReason: string;
  failureDetail?: { peerReason?: string } | null;
  deps: RetryDeps;
}): Promise<EventLike | null> {
  const { userId, trigger, failureReason, failureDetail, deps } = params;

  // Non-retryable: skip.
  if (!isRetryableReason(failureReason, failureDetail)) {
    return null;
  }

  const now = (deps.now ?? Date.now)();
  const content: RetryContent = {
    originalEventId: trigger.id ?? null,
    originalType: trigger.type,
    originalStreamIds: trigger.streamIds ?? [],
    originalContent: trigger.content ?? null,
    attempts: 1,
    lastFailureReason: failureReason,
    lastFailureDetail: failureDetail ?? null,
    nextAttemptAfter: nextAttemptAt({ attempts: 1, now }),
    status: 'pending',
  };

  const event = await deps.mall.events.create(userId, {
    streamIds: [C.NS_INTERNAL_RETRIES],
    type: C.ET_RETRY,
    time: now / 1000,
    content,
  });
  deps.logger?.debug?.('cmc/retry: enqueued', {
    userId,
    retryEventId: event?.id,
    originalType: trigger.type,
    nextAttemptAfter: content.nextAttemptAfter,
  });
  return event;
}

/**
 * Process a single retry event: rebuild a synthetic trigger from
 * content, call dispatch, then either mark succeeded, increment attempts
 * (and schedule next), or mark failed-permanent if we've exhausted
 * MAX_ATTEMPTS.
 */
async function processRetryEvent (params: {
  userId: string;
  retryEvent: RetryEvent;
  deps: RetryDeps;
}): Promise<{
  outcome: 'succeeded' | 'rescheduled' | 'failed-permanent' | 'skipped-not-due' | 'skipped-non-pending';
  retryEventId?: string;
  attempts?: number;
}> {
  const { userId, retryEvent, deps } = params;
  const c = retryEvent?.content ?? {};

  if (c.status !== 'pending') {
    return { outcome: 'skipped-non-pending', retryEventId: retryEvent?.id };
  }
  const now = (deps.now ?? Date.now)();
  if (typeof c.nextAttemptAfter === 'number' && c.nextAttemptAfter > now) {
    return { outcome: 'skipped-not-due', retryEventId: retryEvent?.id };
  }

  const syntheticTrigger: EventLike = {
    id: c.originalEventId ?? undefined,
    streamIds: c.originalStreamIds ?? [],
    type: c.originalType!,
    content: c.originalContent ?? {},
  };

  const dispatched = await deps.dispatch({
    userId,
    event: syntheticTrigger,
    deps: deps.dispatchDeps,
  });

  // Success path: dispatch returned status='completed' (handler ok).
  if (dispatched.status === 'completed' || dispatched.status === 'delivered') {
    await deps.mall.events.update(userId, {
      ...retryEvent,
      content: { ...c, status: 'succeeded' },
    });
    deps.logger?.debug?.('cmc/retry: succeeded', { retryEventId: retryEvent.id });
    return { outcome: 'succeeded', retryEventId: retryEvent.id };
  }

  // Failed again. Check if we should retry.
  const nextAttempts = (c.attempts ?? 1) + 1;
  if (nextAttempts > MAX_ATTEMPTS || !isRetryableReason(dispatched.reason ?? '', dispatched.detail)) {
    await deps.mall.events.update(userId, {
      ...retryEvent,
      content: {
        ...c,
        status: 'failed-permanent',
        attempts: nextAttempts - 1,   // didn't actually take a new attempt
        lastFailureReason: dispatched.reason ?? 'unknown',
        lastFailureDetail: dispatched.detail ?? null,
      },
    });
    deps.logger?.warn?.('cmc/retry: failed-permanent', {
      retryEventId: retryEvent.id,
      reason: dispatched.reason,
    });
    return { outcome: 'failed-permanent', retryEventId: retryEvent.id, attempts: nextAttempts - 1 };
  }

  // Reschedule.
  await deps.mall.events.update(userId, {
    ...retryEvent,
    content: {
      ...c,
      attempts: nextAttempts,
      lastFailureReason: dispatched.reason ?? 'unknown',
      lastFailureDetail: dispatched.detail ?? null,
      nextAttemptAfter: nextAttemptAt({ attempts: nextAttempts, now }),
    },
  });
  deps.logger?.debug?.('cmc/retry: rescheduled', {
    retryEventId: retryEvent.id,
    attempts: nextAttempts,
  });
  return { outcome: 'rescheduled', retryEventId: retryEvent.id, attempts: nextAttempts };
}

/**
 * One pass of the retry loop: pull all due events from the retries
 * stream, process each.
 */
async function runRetryLoop (params: {
  userId: string;
  deps: RetryDeps;
  limit?: number;
}): Promise<{
  processed: number;
  succeeded: number;
  rescheduled: number;
  failedPermanent: number;
  skipped: number;
}> {
  const { userId, deps } = params;
  const limit = params.limit ?? 100;

  // Pull pending retry events. Implementations may filter on content.status
  // server-side; here we pull broadly + filter client-side because mall.events.get
  // doesn't accept content filters uniformly.
  const events = await deps.mall.events.get(userId, {
    streams: [C.NS_INTERNAL_RETRIES],
    limit,
  });

  const summary = { processed: 0, succeeded: 0, rescheduled: 0, failedPermanent: 0, skipped: 0 };
  for (const ev of events) {
    if (ev?.content?.status !== 'pending') {
      summary.skipped += 1;
      continue;
    }
    summary.processed += 1;
    try {
      const r = await processRetryEvent({ userId, retryEvent: ev, deps });
      if (r.outcome === 'succeeded') summary.succeeded += 1;
      else if (r.outcome === 'rescheduled') summary.rescheduled += 1;
      else if (r.outcome === 'failed-permanent') summary.failedPermanent += 1;
      else summary.skipped += 1;
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/retry: processing threw', {
        retryEventId: ev.id,
        error: String((err as Error)?.message || err),
      });
    }
  }
  return summary;
}

/**
 * Reason → retryable classifier. Mirrors outbound.isRetryableFailure for
 * the reasons surfaced by outbound (http-5xx, network, timeout); also
 * adds the dispatch-level reasons we consider retryable.
 *
 * Non-retryable reasons:
 *   - cmc-handler-wrong-type (programmer error)
 *   - cmc-handler-missing-capability-url
 *   - cmc-handler-counterparty-unknown
 *   - cmc-handler-data-grant-no-apiendpoint
 *   - cmc-handler-data-grant-name-conflict (name collision survives the
 *     uniquified retry — no attempt can converge)
 *   - cmc-handler-delivery-rejected (4xx)
 *   - cmc-offer-empty-permissions
 *   - cmc-system-counterparty-access-not-found
 *   - cmc-system-no-remote-*
 *   - cmc-chat-counterparty-access-not-found
 *   - cmc-chat-no-remote-*
 *   - cmc-revoke-counterparty-missing
 *   - cmc-revoke-counterparty-access-not-found
 *
 * Retryable: the delivery-failed family (5xx / network / timeout) +
 * data-grant-create-failed (transient storage hiccup) +
 * delivery-threw (network exception).
 */
const NON_RETRYABLE_REASONS = new Set([
  'cmc-handler-wrong-type',
  'cmc-handler-missing-capability-url',
  'cmc-handler-counterparty-unknown',
  'cmc-handler-data-grant-no-apiendpoint',
  'cmc-handler-data-grant-name-conflict',
  'cmc-handler-delivery-rejected',
  'cmc-offer-empty-permissions',
  'cmc-system-counterparty-access-not-found',
  'cmc-system-no-remote-apiendpoint',
  'cmc-system-no-remote-collector-stream',
  'cmc-system-stream-not-collector',
  'cmc-chat-counterparty-access-not-found',
  'cmc-chat-no-remote-apiendpoint',
  'cmc-chat-no-remote-chat-stream',
  'cmc-chat-stream-not-chat',
  'cmc-revoke-counterparty-missing',
  'cmc-revoke-counterparty-access-not-found',
]);

function isRetryableReason (reason: string, detail?: { peerReason?: string } | null): boolean {
  if (NON_RETRYABLE_REASONS.has(reason)) return false;
  // detail.peerReason carries the underlying outbound classification when
  // the dispatch wrapper converts it.
  if (detail?.peerReason === 'http-4xx') return false;
  if (detail?.peerReason === 'http-5xx') return true;
  if (detail?.peerReason === 'network') return true;
  if (detail?.peerReason === 'timeout') return true;
  // Unknown reasons default to retryable (cheap insurance — the queue
  // discards after MAX_ATTEMPTS anyway).
  return true;
}

export {
  MAX_ATTEMPTS,
  MAX_DELAY_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MULTIPLIER,
  NON_RETRYABLE_REASONS,
  nextAttemptAt,
  isRetryableReason,
  enqueueRetry,
  processRetryEvent,
  runRetryLoop,
};
// Re-export for type-completeness (isRetryableFailure is the outbound-level
// classifier; tests may want to verify our two helpers stay aligned).
export { isRetryableFailure };
