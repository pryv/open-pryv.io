/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger, RetryContext } from './_types.ts';
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
 * A second kind of record, the DELIVERY (`content.delivery`), queues one
 * outbound request rather than a trigger: a `consent/revoke-cmc` notice
 * whose counterparty could not be reached. The trigger it came from is
 * already complete (the local teardown is authoritative) and the access
 * that held the peer endpoint is gone, so the record carries the endpoint
 * and the body itself; it is re-sent as is, on its own, longer schedule
 * (DELIVERY_BACKOFF_BASE_MS × 5^n capped at DELIVERY_MAX_DELAY_MS: 1 min,
 * 5 min, 25 min, about 2 h, then 6 h; DELIVERY_MAX_ATTEMPTS = 8 re-sends
 * from the loop after the in-request round, about 27 h in all) and marked
 * 'failed-permanent' past it, the endpoint's credential removed on either
 * terminal state.
 *
 * A record older than its whole schedule plus a margin (STALE_AFTER_MS,
 * DELIVERY_STALE_AFTER_MS, from the record's `time`) is retired as
 * 'failed-permanent' with reason 'cmc-retry-stale' and never dispatched:
 * a loop that starts on a core which ran with it off must not replay the
 * backlog that built up meanwhile (accepts, chats, scope updates the
 * users saw fail months ago).
 *
 * Terminal records are pruned by the loop: a succeeded one on the next
 * pass, a failed-permanent one after FAILED_RETENTION_MS. The loop reads
 * the stream in pages, so a pending record is never hidden behind newer
 * ones.
 *
 * The loop is run by master workers on an interval; the actual
 * scheduling is wired separately. This module is pure: it depends only
 * on mall and an injected dispatch function.
 */

const C = require('./constants.ts');
const { isRetryableFailure, postToPeer, stripCredentials } = require('./outbound.ts');
const { CAPABILITY_REFUSAL_IDS } = require('./errorIds.ts');

const MAX_ATTEMPTS = 6;
const MAX_DELAY_MS = 10 * 60 * 1000; // 10 min
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MULTIPLIER = 5;
const DELIVERY_MAX_ATTEMPTS = 8;
const DELIVERY_MAX_DELAY_MS = 6 * 60 * 60 * 1000; // 6 h
const DELIVERY_BACKOFF_BASE_MS = 60_000;
// The trigger schedule spans about 23 min, the delivery one about 27 h.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 h
const DELIVERY_STALE_AFTER_MS = 30 * 60 * 60 * 1000; // 30 h
const FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 d
const STALE_REASON = 'cmc-retry-stale';
// A retried `consent/accept-cmc` whose author is the server (`createdBy`
// `system`, or a record on `:_cmc:inbox`, where the only accept is the
// server's mirror of a received one): never re-dispatched. Every accept a
// client writes carries its access id; the server's own copies are not
// triggers, and re-running one would mint again (the mirror: the peer's
// back-channel access; an apps-stream copy: the owner's data grant, since a
// system author reads as the owner's accept). No path enqueues such a record
// today; this is the defence should one appear (an operator tool, a crafted
// record).
const SYSTEM_AUTHORED_REASON = 'cmc-retry-system-authored';
// A record in the retries stream that the plugin did not write. The plugin
// enqueues through the mall with no `createdBy` (stamped `system`), the exact
// `:_cmc:_internal:retries` stream and the `cmc-internal/retry-cmc` type; a
// record failing any of those was placed by something else (a crafted write, a
// legacy stream parented inside the queue) and is never dispatched.
const FOREIGN_RECORD_REASON = 'cmc-retry-foreign-record';
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
// Every write of the plugin on a retry record skips event versioning: the
// record holds a peer token (a delivery's endpoint, an accept's capability
// URL) that must not be copied into history rows.
const WRITE_OPTS = { skipVersioning: true };


type EventLike = {
  id?: string;
  streamIds?: string[];
  type: string;
  content: Record<string, unknown>;
  time?: number;
  createdBy?: string;
};

type RetryEvent = EventLike & { content: RetryContent };
type RetryContent = {
  originalEventId?: string | null;
  originalType?: string;
  originalStreamIds?: string[];
  originalContent?: Record<string, unknown> | null;
  // The access that wrote the trigger. A retry has no request context, so a
  // handler that must know who wrote the trigger (the accept, to find the
  // delegation an accept was given through) reads it back from here.
  originalCreatedBy?: string | null;
  attempts?: number;
  lastFailureReason?: string;
  lastFailureDetail?: unknown;
  nextAttemptAfter?: number;
  status: 'pending' | 'succeeded' | 'failed-permanent';
  // A delivery record: the one request to re-send. `apiEndpoint` carries
  // the peer token while the record is pending (this stream is unreadable
  // by any API path); it is replaced by the credential-free URL once the
  // record is terminal.
  delivery?: { apiEndpoint: string; path: string; body: unknown } | null;
};

type MallParams = Record<string, unknown>;
type MallLike = {
  events: {
    create: (userId: string, params: MallParams) => Promise<EventLike>;
    update: (userId: string, params: MallParams, transaction?: null, opts?: { skipVersioning?: boolean }) => Promise<unknown>;
    get: (userId: string, params?: MallParams) => Promise<RetryEvent[]>;
    // The real mall's delete takes the stored event; optional so unit fakes
    // may omit it (terminal records are then kept).
    delete?: (userId: string, event: EventLike) => Promise<unknown>;
  };
};
type DeliveryDeps = {
  fetch: (url: string, init?: Record<string, unknown>) => Promise<Response>;
  timeoutMs?: number;
  logger?: CmcLogger;
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
    originalCreatedBy: typeof trigger.createdBy === 'string' ? trigger.createdBy : null,
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

/** The next attempt of a delivery record (minutes, then hours). */
function nextDeliveryAttemptAt (params: { attempts: number; now: number }): number {
  const { attempts, now } = params;
  const delay = Math.min(
    DELIVERY_BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, Math.max(0, attempts - 1)),
    DELIVERY_MAX_DELAY_MS
  );
  return now + delay;
}

/**
 * Queue one outbound request whose first attempts failed retryably (the
 * peer down, a 5xx, a timeout): a revoke notice. `originalEventId` and
 * `originalType` name the trigger it came from, for the operator; the
 * request itself (`delivery`) is what the loop re-sends. Returns the record.
 */
async function enqueueDelivery (params: {
  userId: string;
  delivery: { apiEndpoint: string; path: string; body: unknown };
  originalEventId?: string | null;
  originalType: string;
  failureReason: string;
  failureDetail?: unknown;
  deps: { mall: MallLike; now?: () => number; logger?: CmcLogger };
}): Promise<EventLike> {
  const { userId, delivery, deps } = params;
  const now = (deps.now ?? Date.now)();
  const content: RetryContent = {
    originalEventId: params.originalEventId ?? null,
    originalType: params.originalType,
    originalStreamIds: [],
    originalContent: null,
    originalCreatedBy: null,
    delivery,
    attempts: 1,
    lastFailureReason: params.failureReason,
    lastFailureDetail: params.failureDetail ?? null,
    nextAttemptAfter: nextDeliveryAttemptAt({ attempts: 1, now }),
    status: 'pending',
  };
  const event = await deps.mall.events.create(userId, {
    streamIds: [C.NS_INTERNAL_RETRIES],
    type: C.ET_RETRY,
    time: now / 1000,
    content,
  });
  deps.logger?.info?.('cmc/retry: delivery queued', {
    userId,
    retryEventId: event?.id,
    originalType: params.originalType,
    host: stripCredentials(delivery.apiEndpoint),
    nextAttemptAfter: content.nextAttemptAfter,
  });
  return event;
}

/** A terminal delivery record keeps the host, not the token. */
function terminalDelivery (c: RetryContent): RetryContent['delivery'] {
  if (c.delivery == null) return c.delivery;
  return { ...c.delivery, apiEndpoint: stripCredentials(c.delivery.apiEndpoint) };
}

/**
 * One attempt of a delivery record: the request re-sent as stored. A 2xx
 * settles it; a 4xx (the peer's considered answer) retires it at once;
 * anything else reschedules it on the delivery schedule until
 * DELIVERY_MAX_ATTEMPTS.
 */
async function processDeliveryEvent (params: {
  userId: string;
  retryEvent: RetryEvent;
  deps: RetryDeps;
  now: number;
}): Promise<{ outcome: 'succeeded' | 'rescheduled' | 'failed-permanent'; retryEventId?: string; attempts?: number }> {
  const { userId, retryEvent, deps, now } = params;
  const c = retryEvent.content;
  const d = c.delivery!;
  const dd = (deps.dispatchDeps ?? {}) as Partial<DeliveryDeps>;
  const peerDeps: DeliveryDeps = { fetch: dd.fetch!, timeoutMs: dd.timeoutMs, logger: deps.logger ?? dd.logger };
  let result: { ok: boolean; status?: number; reason?: string };
  try {
    result = await postToPeer({ apiEndpoint: d.apiEndpoint, path: d.path, body: d.body, deps: peerDeps });
  } catch (err: unknown) {
    result = { ok: false, reason: 'network' };
    deps.logger?.warn?.('cmc/retry: delivery threw', { retryEventId: retryEvent.id, error: String((err as Error)?.message || err) });
  }
  if (result.ok) {
    await deps.mall.events.update(userId, {
      ...retryEvent,
      ...serverModification(deps),
      content: { ...c, status: 'succeeded', delivery: terminalDelivery(c) },
    }, null, WRITE_OPTS);
    deps.logger?.info?.('cmc/retry: delivery succeeded', { retryEventId: retryEvent.id, attempts: c.attempts ?? 1 });
    return { outcome: 'succeeded', retryEventId: retryEvent.id };
  }
  const nextAttempts = (c.attempts ?? 1) + 1;
  const detail = { peerReason: result.reason, status: result.status };
  // A 4xx is the peer's answer; a refused destination can never be called.
  const refused = result.reason === 'refused';
  if (nextAttempts > DELIVERY_MAX_ATTEMPTS || result.reason === 'http-4xx' || refused) {
    await deps.mall.events.update(userId, {
      ...retryEvent,
      ...serverModification(deps),
      content: {
        ...c,
        status: 'failed-permanent',
        attempts: nextAttempts - 1,
        lastFailureReason: refused ? 'cmc-handler-destination-refused' : (c.lastFailureReason ?? 'cmc-revoke-delivery-failed'),
        lastFailureDetail: detail,
        delivery: terminalDelivery(c),
      },
    }, null, WRITE_OPTS);
    deps.logger?.warn?.('cmc/retry: delivery failed-permanent (the counterparty was never told)', {
      retryEventId: retryEvent.id, originalType: c.originalType, attempts: nextAttempts - 1, reason: result.reason, status: result.status,
    });
    return { outcome: 'failed-permanent', retryEventId: retryEvent.id, attempts: nextAttempts - 1 };
  }
  await deps.mall.events.update(userId, {
    ...retryEvent,
    ...serverModification(deps),
    content: { ...c, attempts: nextAttempts, lastFailureDetail: detail, nextAttemptAfter: nextDeliveryAttemptAt({ attempts: nextAttempts, now }) },
  }, null, WRITE_OPTS);
  deps.logger?.debug?.('cmc/retry: delivery rescheduled', { retryEventId: retryEvent.id, attempts: nextAttempts });
  return { outcome: 'rescheduled', retryEventId: retryEvent.id, attempts: nextAttempts };
}

/** `modified` (write time, unix seconds) and `modifiedBy` for a retry event the plugin updates. */
function serverModification (deps: RetryDeps): { modified: number; modifiedBy: string } {
  return { modified: (deps.now ?? Date.now)() / 1000, modifiedBy: C.SYSTEM_ACCESS_ID };
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
  // A record past its whole schedule is retired, never replayed.
  const staleAfter = c.delivery != null ? DELIVERY_STALE_AFTER_MS : STALE_AFTER_MS;
  if (typeof retryEvent.time === 'number' && now - retryEvent.time * 1000 > staleAfter) {
    await deps.mall.events.update(userId, {
      ...retryEvent,
      ...serverModification(deps),
      content: {
        ...c,
        status: 'failed-permanent',
        lastFailureReason: STALE_REASON,
        lastFailureDetail: { enqueuedAt: retryEvent.time, retiredAt: now / 1000 },
        delivery: terminalDelivery(c),
      },
    }, null, WRITE_OPTS);
    deps.logger?.warn?.('cmc/retry: a pending record older than its schedule was retired, not replayed', {
      retryEventId: retryEvent.id, originalType: c.originalType, enqueuedAt: retryEvent.time, kind: c.delivery != null ? 'delivery' : 'trigger',
    });
    return { outcome: 'failed-permanent', retryEventId: retryEvent.id, attempts: c.attempts ?? 1 };
  }
  if (c.delivery != null) {
    return await processDeliveryEvent({ userId, retryEvent, deps, now });
  }
  if (isSystemAuthoredAccept(c)) {
    await deps.mall.events.update(userId, {
      ...retryEvent,
      ...serverModification(deps),
      content: {
        ...c,
        status: 'failed-permanent',
        lastFailureReason: SYSTEM_AUTHORED_REASON,
        lastFailureDetail: { originalCreatedBy: c.originalCreatedBy ?? null, originalStreamIds: c.originalStreamIds ?? [] },
      },
    }, null, WRITE_OPTS);
    deps.logger?.warn?.('cmc/retry: a retried accept authored by the server was refused, not replayed', {
      retryEventId: retryEvent.id, originalEventId: c.originalEventId, originalCreatedBy: c.originalCreatedBy ?? null, originalStreamIds: c.originalStreamIds ?? [],
    });
    return { outcome: 'failed-permanent', retryEventId: retryEvent.id, attempts: c.attempts ?? 1 };
  }

  const syntheticTrigger: EventLike = {
    id: c.originalEventId ?? undefined,
    streamIds: c.originalStreamIds ?? [],
    type: c.originalType!,
    content: c.originalContent ?? {},
  };
  if (typeof c.originalCreatedBy === 'string') syntheticTrigger.createdBy = c.originalCreatedBy;

  // Tell the handler what the previous attempt reported, so it can avoid
  // repeating a step that already took effect (a revoke whose delivery
  // reached the peer before the local delete failed).
  const retryContext: RetryContext = {
    attempts: c.attempts ?? 1,
    lastFailureReason: c.lastFailureReason ?? null,
    lastFailureDetail: c.lastFailureDetail ?? null,
  };
  const dispatchDeps = deps.dispatchDeps != null && typeof deps.dispatchDeps === 'object'
    ? { ...deps.dispatchDeps, retryContext }
    : deps.dispatchDeps;
  const dispatched = await deps.dispatch({
    userId,
    event: syntheticTrigger,
    deps: dispatchDeps,
  });

  // Success path: dispatch returned status='completed' (handler ok).
  if (dispatched.status === 'completed' || dispatched.status === 'delivered') {
    await deps.mall.events.update(userId, {
      ...retryEvent,
      ...serverModification(deps),
      content: { ...c, status: 'succeeded' },
    }, null, WRITE_OPTS);
    deps.logger?.debug?.('cmc/retry: succeeded', { retryEventId: retryEvent.id });
    return { outcome: 'succeeded', retryEventId: retryEvent.id };
  }

  // Failed again. Check if we should retry.
  const nextAttempts = (c.attempts ?? 1) + 1;
  if (nextAttempts > MAX_ATTEMPTS || !isRetryableReason(dispatched.reason ?? '', dispatched.detail)) {
    await deps.mall.events.update(userId, {
      ...retryEvent,
      ...serverModification(deps),
      content: {
        ...c,
        status: 'failed-permanent',
        attempts: nextAttempts - 1,   // didn't actually take a new attempt
        lastFailureReason: dispatched.reason ?? 'unknown',
        lastFailureDetail: dispatched.detail ?? null,
      },
    }, null, WRITE_OPTS);
    deps.logger?.warn?.('cmc/retry: failed-permanent', {
      retryEventId: retryEvent.id,
      reason: dispatched.reason,
    });
    return { outcome: 'failed-permanent', retryEventId: retryEvent.id, attempts: nextAttempts - 1 };
  }

  // Reschedule.
  await deps.mall.events.update(userId, {
    ...retryEvent,
    ...serverModification(deps),
    content: {
      ...c,
      attempts: nextAttempts,
      lastFailureReason: dispatched.reason ?? 'unknown',
      lastFailureDetail: dispatched.detail ?? null,
      nextAttemptAfter: nextAttemptAt({ attempts: nextAttempts, now }),
    },
  }, null, WRITE_OPTS);
  deps.logger?.debug?.('cmc/retry: rescheduled', {
    retryEventId: retryEvent.id,
    attempts: nextAttempts,
  });
  return { outcome: 'rescheduled', retryEventId: retryEvent.id, attempts: nextAttempts };
}

/**
 * True for a trigger record of a `consent/accept-cmc` the server authored:
 * `originalCreatedBy` is the system access id (`<accessId>` or
 * `<accessId> <callerId>`), or the record sits on `:_cmc:inbox` (an accept
 * there can only be the server's mirror, `inboxWriteHook` refuses a client's).
 */
function isSystemAuthoredAccept (c: RetryContent): boolean {
  if (c.originalType !== C.ET_ACCEPT) return false;
  const createdBy = c.originalCreatedBy;
  if (typeof createdBy === 'string') {
    const separatorIndex = createdBy.indexOf(' ');
    const accessId = separatorIndex === -1 ? createdBy : createdBy.slice(0, separatorIndex);
    if (accessId === C.SYSTEM_ACCESS_ID) return true;
  }
  return Array.isArray(c.originalStreamIds) && c.originalStreamIds.includes(C.NS_INBOX);
}

/**
 * True when a record in the retries stream carries positive evidence that
 * something other than the plugin wrote it, so it must never be dispatched.
 * The plugin enqueues through the mall (author stamped `system`), on the exact
 * `:_cmc:_internal:retries` stream, with the `cmc-internal/retry-cmc` type; a
 * production record always carries all three (the mall stamps `createdBy`).
 * Evidence of a foreign write:
 *   - a `createdBy` whose access id is not `system` (a crafted API write stamps
 *     the writing access's id);
 *   - a `type` other than the retry type;
 *   - a `streamIds` that does not include the retries stream (a legacy stream
 *     parented inside the queue; the loop's `{ any: [retries] }` read also
 *     returns descendant-stream events).
 * A field that is simply absent is not treated as evidence (it only happens in
 * unit fakes; the mall always stamps `createdBy` in production).
 */
function isForeignRetryRecord (ev: RetryEvent): boolean {
  if (ev == null) return false;
  if (typeof ev.createdBy === 'string' && ev.createdBy.length > 0) {
    const sep = ev.createdBy.indexOf(' ');
    const accessId = sep === -1 ? ev.createdBy : ev.createdBy.slice(0, sep);
    if (accessId !== C.SYSTEM_ACCESS_ID) return true;
  }
  if (typeof ev.type === 'string' && ev.type !== C.ET_RETRY) return true;
  if (Array.isArray(ev.streamIds) && ev.streamIds.length > 0 && !ev.streamIds.includes(C.NS_INTERNAL_RETRIES)) return true;
  return false;
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
  // Pending records seen, due or not (the idle back-off reads it).
  pendingTotal: number;
}> {
  const { userId, deps } = params;
  const limit = params.limit ?? 100;
  const now = (deps.now ?? Date.now)();

  // The stream read in pages (newest first), every record seen. A read that
  // fails (an account without the stream yet) is an empty queue.
  // Only DUE pending records are collected (a record scheduled hours ahead
  // must not fill the window and hide an older one that is due); the paging
  // goes on until `limit` due records or the end of the stream. Terminal
  // records to prune (a succeeded record at once, a failed-permanent one past
  // its retention) are collected and deleted AFTER the paging (a delete while
  // paging by skip would shift the later pages). The collected records are
  // processed oldest first: those are the closest to the stale threshold.
  const summary = { processed: 0, succeeded: 0, rescheduled: 0, failedPermanent: 0, skipped: 0, pendingTotal: 0 };
  const pending: RetryEvent[] = [];
  const toPrune: RetryEvent[] = [];
  const toRetire: RetryEvent[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES && pending.length < limit; page++) {
    let events: RetryEvent[];
    try {
      events = await deps.mall.events.get(userId, {
        // The mall takes stream queries (`{ any: [...] }`), never bare ids: a
        // bare id resolves no store and the read throws.
        streams: [{ any: [C.NS_INTERNAL_RETRIES] }],
        limit: PAGE_SIZE,
        skip: page * PAGE_SIZE,
      });
    } catch (err: unknown) {
      if (page === 0) deps.logger?.debug?.('cmc/retry: queue read failed, treated as empty', { userId, error: String((err as Error)?.message || err) });
      break;
    }
    const list = Array.isArray(events) ? events : [];
    for (const ev of list) {
      if (ev?.id != null) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
      }
      const status = ev?.content?.status;
      if (status === 'pending') {
        summary.pendingTotal += 1;
        // Only records the plugin wrote are ever dispatched. A foreign record
        // (crafted, or a legacy stream parented inside the queue) is retired,
        // never run.
        if (isForeignRetryRecord(ev)) {
          summary.skipped += 1;
          if (ev?.id != null) toRetire.push(ev);
          continue;
        }
        const after = ev?.content?.nextAttemptAfter;
        const due = typeof after !== 'number' || after <= now;
        if (due && pending.length < limit) pending.push(ev);
        else summary.skipped += 1;
        continue;
      }
      summary.skipped += 1;
      const retired = status === 'succeeded' ||
        (status === 'failed-permanent' && typeof ev?.time === 'number' && now - ev.time * 1000 > FAILED_RETENTION_MS);
      if (retired && ev?.id != null) toPrune.push(ev);
    }
    if (list.length < PAGE_SIZE) break;
  }
  if (deps.mall.events.delete != null) {
    for (const ev of toPrune) {
      try { await deps.mall.events.delete(userId, ev); } catch (_e) { /* pruned on a later pass */ }
    }
  }
  // Retire foreign pending records once (so they are not re-scanned every pass),
  // without ever dispatching them.
  for (const ev of toRetire) {
    try {
      await deps.mall.events.update(userId, {
        ...ev,
        ...serverModification(deps),
        content: {
          ...(ev.content ?? {}),
          status: 'failed-permanent',
          lastFailureReason: FOREIGN_RECORD_REASON,
          lastFailureDetail: { createdBy: ev.createdBy ?? null, type: ev.type ?? null },
        },
      }, null, WRITE_OPTS);
      deps.logger?.warn?.('cmc/retry: a record the plugin did not write was retired, never dispatched', {
        retryEventId: ev.id, type: ev.type, createdBy: ev.createdBy ?? null,
      });
    } catch (_e) { /* retired on a later pass */ }
  }
  const timeOf = (ev: RetryEvent): number => (typeof ev?.time === 'number' ? ev.time : 0);
  pending.sort((a, b) => timeOf(a) - timeOf(b));
  for (const ev of pending) {
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
 *   - cmc-handler-delivery-rejected (4xx), and the capability refusals
 *     reported in its place (consumed / invalidated / already accepted)
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
 * delivery-threw (network exception) + cmc-revoke-delete-failed (a local
 * delete that threw and left the access in place).
 */
const NON_RETRYABLE_REASONS = new Set([
  // The destination may not be called: re-running cannot change that.
  'cmc-handler-destination-refused',
  'cmc-capability-destination-refused',
  'cmc-handler-wrong-type',
  'cmc-handler-missing-capability-url',
  'cmc-incoming-refuse-missing-capability-id',
  // The invalidate trigger's stream does not hold the invite it names.
  'cmc-invalidate-link-scope-mismatch',
  // The capability URL no longer authenticates (unknown or expired token):
  // re-running cannot change that.
  'cmc-capability-invalid',
  'cmc-handler-counterparty-unknown',
  'cmc-handler-data-grant-no-apiendpoint',
  'cmc-handler-data-grant-name-conflict',
  // An accept given through a delegation that has ended: re-running finds
  // the same ended delegation.
  'cmc-handler-delegation-ended',
  'cmc-handler-delivery-rejected',
  // The capability's own refusals, reported instead of delivery-rejected.
  ...CAPABILITY_REFUSAL_IDS,
  'cmc-offer-empty-permissions',
  'cmc-offer-stream-not-offerable',
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
  // Wrong delivery stream is a property of the event, not of the moment —
  // re-running it can only reach the same verdict. Retrying would also hand a
  // peer probing this path six attempts instead of one.
  'cmc-back-channel-wrong-stream',
  'cmc-back-channel-wrong-type',
  // Scope-update verdicts are properties of the stored request and grant;
  // re-running reaches the same answer.
  'cmc-scope-request-not-found',
  'cmc-scope-request-not-from-peer',
  'cmc-scope-request-stream-mismatch',
  'cmc-scope-request-expired',
  'cmc-scope-request-already-answered',
  'cmc-scope-request-invalid',
  'cmc-scope-update-target-not-counterparty',
  'cmc-scope-update-target-stream-mismatch',
  'cmc-scope-update-nothing-to-apply',
  // Group accounts. The mint type is never queued at all (dispatch
  // NEVER_ENQUEUE_TYPES); its reasons are listed as belt and braces. A
  // membership offer that asks too much, or a channel a member does not
  // have, do not change by re-running.
  'cmc-membership-permissions-invalid',
  'cmc-member-channel-not-supported',
  'cmc-member-access-not-member',
  'cmc-member-access-relationship-not-found',
  'cmc-member-access-scope-outside-membership',
  'cmc-member-access-permissions-not-subset',
  'cmc-member-access-expiry-out-of-range',
  'cmc-member-access-grant-not-delegable',
  'cmc-member-access-peer-rejected',
  'cmc-member-access-peer-unreachable',
  'cmc-member-access-membership-gone',
  'cmc-member-access-not-retryable',
  // The retry loop's own verdicts on a record.
  STALE_REASON,
  SYSTEM_AUTHORED_REASON,
  FOREIGN_RECORD_REASON,
]);

function isRetryableReason (reason: string, detail?: { peerReason?: string; reason?: string } | null): boolean {
  if (NON_RETRYABLE_REASONS.has(reason)) return false;
  // A refused destination, whichever field the handler put it in.
  if (detail?.peerReason === 'refused' || detail?.reason === 'refused') return false;
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
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_MAX_DELAY_MS,
  DELIVERY_BACKOFF_BASE_MS,
  STALE_AFTER_MS,
  DELIVERY_STALE_AFTER_MS,
  FAILED_RETENTION_MS,
  STALE_REASON,
  SYSTEM_AUTHORED_REASON,
  FOREIGN_RECORD_REASON,
  NON_RETRYABLE_REASONS,
  nextAttemptAt,
  nextDeliveryAttemptAt,
  isRetryableReason,
  enqueueRetry,
  enqueueDelivery,
  processRetryEvent,
  runRetryLoop,
};
// Re-export for type-completeness (isRetryableFailure is the outbound-level
// classifier; tests may want to verify our two helpers stay aligned).
export { isRetryableFailure };
