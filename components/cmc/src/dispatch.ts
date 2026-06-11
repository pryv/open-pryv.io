/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger, OutboundDeps } from './_types.ts';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — orchestration dispatch loop.
 *
 * Fires AFTER a `cmc/*` trigger event is persisted: picks the matching
 * handler by event type, runs it, and updates the trigger event's
 * content.status field as orchestration progresses.
 *
 * Triggers immediately return `status: 'pending'` to the caller (the
 * write hook stamps that on its way through). This dispatch then
 * transitions through 'delivered' / 'completed' / 'failed' depending on
 * the handler outcome. The app subscribes to the trigger's home stream
 * to see the status updates land.
 *
 * The middleware wrapper (createDispatchMiddleware) kicks off the dispatch
 * without awaiting — the events.create response returns to the client
 * immediately. Logger captures handler exceptions; the dispatch never
 * propagates errors back to the events.create chain (a failed handler
 * surfaces as content.status='failed' on the trigger).
 */

const C = require('./constants.ts');
const handleAcceptMod = require('./handleAccept.ts');
const handleSystemMod = require('./handleSystem.ts');
const handleChatMod = require('./handleChat.ts');
const handleRevokeMod = require('./handleRevoke.ts');
const handleIncomingAcceptMod = require('./handleIncomingAccept.ts');
const handleIncomingBackChannelMod = require('./handleIncomingBackChannel.ts');
const handleInvalidateLinkMod = require('./handleInvalidateLink.ts');
const retryQueueMod = require('./retryQueue.ts');

type SelfIdentity = { username: string; host: string };

type CmcEvent = {
  id?: string;
  type: string;
  content?: Record<string, unknown> | null;
  streamIds?: string[];
  createdBy?: string;
  [k: string]: unknown;
};

type CmcAccess = {
  id?: string;
  clientData?: { cmc?: { role?: string; [k: string]: unknown }; [k: string]: unknown };
  [k: string]: unknown;
};

// Mall proxy types — these methods accept and return runtime payloads that
// vary by call site (Mongo-style queries, partial events, partial accesses).
// Keep param/result as `unknown` rather than `any` so consumers get the
// is-undefined check signal at least, but don't model the deep variants.
type MallLike = {
  accesses: {
    create: (userId: string, params: unknown) => Promise<unknown>;
    delete?: (userId: string, params: unknown) => Promise<unknown>;
    update?: (userId: string, params: unknown) => Promise<unknown>;
    get?: (userId: string, params?: unknown) => Promise<CmcAccess[]>;
  };
  events: {
    update: (userId: string, params: unknown) => Promise<unknown>;
    create: (userId: string, params: unknown) => Promise<unknown>;
    get?: (userId: string, params?: unknown) => Promise<unknown[]>;
  };
  streams: { create: (userId: string, params: unknown) => Promise<unknown> };
};


type DispatchDeps = {
  mall: MallLike;
  fetch: OutboundDeps['fetch'];
  timeoutMs?: number;
  logger?: CmcLogger;
  selfIdentityFor: (userId: string) => Promise<SelfIdentity> | SelfIdentity;
  // When true (default), retryable handler failures are auto-enqueued
  // in :_cmc:_internal:retries for later re-dispatch by the retry loop.
  // Disable for tests that don't want the side-effect.
  enqueueRetries?: boolean;
  // Optional callback fired after each mall.events.update we perform on
  // the trigger event (status transitions). Lets the api-server emit
  // pubsub.USERNAME_BASED_EVENTS_CHANGED so the app's socket.io
  // subscription sees the status flip. No-op if undefined.
  notifyEventChanged?: (userId: string, event: CmcEvent) => void;
};

type DispatchResult = {
  handled: boolean;
  eventType: string | null;
  status: 'pending' | 'delivered' | 'completed' | 'failed' | 'skipped';
  reason?: string;
  detail?: unknown;
};

type HandlerResult = {
  ok?: boolean;
  reason?: string;
  detail?: unknown;
  dataGrantApiEndpoint?: string;
  dataGrantAccessId?: string;
  offerEventId?: string;
  capabilityId?: string;
  requesterIdentity?: { username: string; host: string };
  backChannelAccessId?: string;
  anchorStreamIds?: string[];
};

// Middleware-fire-time context shape. The api-server passes its
// MethodContext here; we only read user.id + leave per-request deps
// up to buildPerRequestDeps callers.
type MiddlewareContext = { user?: { id?: string; [k: string]: unknown }; [k: string]: unknown };
type MiddlewareResult = { event?: CmcEvent; [k: string]: unknown };

/**
 * Dispatch a single CMC trigger event through its handler.
 *
 * Returns immediately if the event isn't a recognised cmc/* type (e.g.
 * an app-defined type written into :_cmc:apps:*).
 *
 * Errors from the handler are caught and surfaced as a 'failed' status —
 * never thrown back to the caller.
 */
async function dispatch (params: {
  userId: string;
  event: CmcEvent;
  deps: DispatchDeps;
}): Promise<DispatchResult> {
  const { userId, event, deps } = params;
  if (typeof event?.type !== 'string') {
    return { handled: false, eventType: null, status: 'skipped', reason: 'no-event-type' };
  }
  if (!C.isCmcEventType(event.type)) {
    return { handled: false, eventType: event.type, status: 'skipped', reason: 'not-cmc-event' };
  }

  // Stamp 'delivered' before running the handler (the handler may overwrite
  // to 'completed' or 'failed'; 'delivered' is the explicit "we've taken the
  // event off the queue" indicator).
  if (event.id != null && deps.mall.events.update != null) {
    try {
      await deps.mall.events.update(userId, {
        ...event,
        content: { ...(event.content || {}), status: 'delivered' },
      });
      try { deps.notifyEventChanged?.(userId, event); } catch (_e) { /* notify is best-effort */ }
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/dispatch: failed to mark trigger as delivered', {
        eventId: event.id,
        error: String((err as Error)?.message ?? err),
      });
    }
  }

  let selfIdentity: SelfIdentity;
  try {
    const resolved = await deps.selfIdentityFor(userId);
    selfIdentity = resolved;
  } catch (err: unknown) {
    return await markFailed(deps, userId, event, 'cmc-dispatch-self-identity-failed', {
      message: String((err as Error)?.message ?? err),
    });
  }

  // Loop avoidance: events created by a counterparty access on this user's
  // mall are peer-delivered (bob's plugin POSTed via the counterparty
  // access bob holds on alice's account). Re-dispatching them would re-POST
  // to bob, which arrives back at alice — the classic chat/system
  // ping-pong. Skip outbound handler types when `event.createdBy` resolves
  // to a counterparty-role access on this mall.
  //
  // Lifecycle handlers (accept / refuse / back-channel / request) are
  // exempt: their dispatch path is direction-aware via `isOnInbox` and
  // the incoming variants do real protocol work (mint back-channel,
  // update data-grant). Only chat / system / revoke handlers POST
  // unconditionally back out, so only they need the guard.
  if (OUTBOUND_LOOPABLE_TYPES.has(event.type)) {
    const incoming = await isPeerDeliveredEvent(userId, event.createdBy, deps);
    if (incoming) {
      // Mark 'completed' (not 'skipped') so the trigger event's status
      // reflects "we processed this and decided no outbound was needed."
      // Skip the markCompleted call though — incoming events typically
      // come from a peer POST and rewriting their status would emit a
      // pubsub notification on every chat received, which is noisy.
      return {
        handled: true,
        eventType: event.type,
        status: 'skipped',
        reason: 'cmc-incoming-from-peer',
      };
    }
  }

  let result: HandlerResult | undefined;
  try {
    switch (event.type) {
      case C.ET_ACCEPT:
        // Direction-aware routing:
        //   - consent/accept-cmc written on :_cmc:inbox = peer-delivered (the
        //     accepter has just POSTed their accept to us via the
        //     capability URL). Mint the back-channel access + provision
        //     anchor streams via handleIncomingAccept.
        //   - consent/accept-cmc written on a :_cmc:apps:* stream = the LOCAL
        //     user is accepting an incoming request. handleAccept reads
        //     the offer via capability + creates the data-grant access +
        //     delivers the accept back to the peer.
        if (isOnInbox(event)) {
          result = await handleIncomingAcceptMod.handleIncomingAccept({
            userId, acceptEvent: event, selfIdentity, deps,
          });
        } else {
          result = await handleAcceptMod.handleAccept({
            userId, triggerEvent: event, selfIdentity, deps,
          });
        }
        break;
      case C.ET_REFUSE:
        result = await handleAcceptMod.handleRefuse({
          userId, triggerEvent: event, selfIdentity, deps,
        });
        break;
      case C.ET_BACK_CHANNEL:
        // Back-channel info delivered by the requester to the accepter's
        // :_cmc:inbox. Updates the data-grant access with the requester's
        // back-channel apiEndpoint + remote stream-ids so future chat /
        // system deliveries from accepter to requester can resolve.
        result = await handleIncomingBackChannelMod.handleIncomingBackChannel({
          userId, event, deps,
        });
        break;
      case C.ET_REQUEST:
        // request triggers are handled separately by a capability-mint
        // middleware (Phase D slice 2). Dispatch loop is a no-op here.
        return { handled: false, eventType: event.type, status: 'skipped', reason: 'request-handled-elsewhere' };
      case C.ET_SYSTEM_ALERT:
        result = await handleSystemMod.handleSystemAlert({
          userId, triggerEvent: event, selfIdentity, deps,
        });
        break;
      case C.ET_SYSTEM_ACK:
        result = await handleSystemMod.handleSystemAck({
          userId, triggerEvent: event, selfIdentity, deps,
        });
        break;
      case C.ET_CHAT:
        result = await handleChatMod.handleChat({
          userId, triggerEvent: event, selfIdentity, deps,
        });
        break;
      case C.ET_REVOKE:
        result = await handleRevokeMod.handleRevoke({
          userId, triggerEvent: event, selfIdentity, deps,
        });
        break;
      case C.ET_SYSTEM_SCOPE_REQUEST:
        result = await handleSystemMod.handleSystemScopeRequest({
          userId, triggerEvent: event, selfIdentity, deps,
        });
        break;
      case C.ET_SYSTEM_SCOPE_UPDATE:
        result = await handleSystemMod.handleSystemScopeUpdate({
          userId, triggerEvent: event, selfIdentity, deps,
        });
        break;
      case C.ET_INVALIDATE_LINK:
        // Per-capability lifecycle (open-link mode, Phase 2). Requester
        // invalidates their own capability locally; no peer delivery.
        result = await handleInvalidateLinkMod.handleInvalidateLink({
          userId, triggerEvent: event, deps,
        });
        break;
      default:
        return { handled: false, eventType: event.type, status: 'skipped', reason: 'unknown-cmc-event' };
    }
  } catch (err: unknown) {
    return await markFailed(deps, userId, event, 'cmc-dispatch-handler-threw', {
      message: String((err as Error)?.message ?? err),
    });
  }

  if (result?.ok) {
    await markCompleted(deps, userId, event, {
      acceptedBy: result?.dataGrantApiEndpoint
        ? { apiEndpoint: result.dataGrantApiEndpoint }
        : undefined,
      dataGrantAccessId: result?.dataGrantAccessId,
      offerEventId: result?.offerEventId,
      capabilityId: result?.capabilityId,
      // For handleAccept (accepter side): stamp the resolved REQUESTER
      // identity so listAcceptedRelationships's mapper picks up
      // `content.from = {username, host}` instead of falling through to
      // `content.acceptedBy` (which carries only the accepter's own
      // data-grant apiEndpoint). Without this the patient app can't
      // identify the doctor on each relationship row.
      from: result?.requesterIdentity,
      // handleIncomingAccept fields:
      backChannelAccessId: result?.backChannelAccessId,
      anchorStreamIds: result?.anchorStreamIds,
    });
    return { handled: true, eventType: event.type, status: 'completed' };
  }

  return await markFailed(
    deps,
    userId,
    event,
    result?.reason || 'cmc-dispatch-handler-failed',
    result?.detail
  );
}

async function markCompleted (deps: DispatchDeps, userId: string, event: CmcEvent, extra: Partial<HandlerResult> & Record<string, unknown>): Promise<DispatchResult> {
  if (event.id == null || deps.mall.events.update == null) {
    return { handled: true, eventType: event.type, status: 'completed' };
  }
  try {
    const cleaned: Record<string, unknown> = {};
    if (extra != null) {
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined) cleaned[k] = v;
      }
    }
    await deps.mall.events.update(userId, {
      ...event,
      content: { ...(event.content || {}), status: 'completed', ...cleaned },
    });
    try { deps.notifyEventChanged?.(userId, event); } catch (_e) { /* best-effort */ }
  } catch (err: unknown) {
    deps.logger?.warn?.('cmc/dispatch: failed to mark trigger as completed', {
      eventId: event.id,
      error: String((err as Error)?.message ?? err),
    });
  }
  return { handled: true, eventType: event.type, status: 'completed' };
}

async function markFailed (
  deps: DispatchDeps,
  userId: string,
  event: CmcEvent,
  reason: string,
  detail?: unknown
): Promise<DispatchResult> {
  // Auto-enqueue a retry for retryable failures (default on; tests opt out
  // by setting enqueueRetries=false).
  const shouldQueue = deps.enqueueRetries !== false &&
    retryQueueMod.isRetryableReason(reason, detail) &&
    deps.mall.events.create != null;
  if (shouldQueue) {
    try {
      await retryQueueMod.enqueueRetry({
        userId,
        trigger: event,
        failureReason: reason,
        failureDetail: detail,
        deps: {
          mall: deps.mall,
          dispatch,
          dispatchDeps: deps,
          logger: deps.logger,
        },
      });
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/dispatch: failed to enqueue retry', {
        eventId: event.id,
        error: String((err as Error)?.message ?? err),
      });
    }
  }
  if (event.id != null && deps.mall.events.update != null) {
    try {
      await deps.mall.events.update(userId, {
        ...event,
        content: {
          ...(event.content || {}),
          status: 'failed',
          failure: { reason, detail: detail ?? null },
        },
      });
      try { deps.notifyEventChanged?.(userId, event); } catch (_e) { /* best-effort */ }
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/dispatch: failed to mark trigger as failed', {
        eventId: event.id,
        reason,
        error: String((err as Error)?.message ?? err),
      });
    }
  }
  return { handled: true, eventType: event.type, status: 'failed', reason, detail };
}

/**
 * True if the event's streamIds list includes :_cmc:inbox OR is on a
 * per-capability responses stream (`:_cmc:_internal:responses:*`).
 *
 * Both are peer-delivered events from the requester's perspective:
 *   - `:_cmc:inbox` is the standard one-shot lifecycle delivery
 *     (used for peer-pushed events post-acceptance, e.g. revoke).
 *   - `:_cmc:_internal:responses:<capId>` is where the accepter's
 *     plugin posts consent/accept-cmc via the capability connection
 *     during the initial handshake (per INTERNALS.md flow 3).
 *
 * Both route to handleIncomingAccept on the requester side, which
 * mints the back-channel access + provisions anchor streams + mirrors
 * a copy to :_cmc:inbox so the requester's app sees the accept via
 * standard inbox subscription.
 */
function isOnInbox (event: CmcEvent): boolean {
  const ids = Array.isArray(event?.streamIds) ? event.streamIds : [];
  if (ids.includes(C.NS_INBOX)) return true;
  for (const id of ids) {
    if (typeof id === 'string' && id.startsWith(C.NS_INTERNAL + ':responses:')) return true;
  }
  return false;
}

/**
 * Build a request-scoped dispatch middleware. `buildPerRequestDeps`
 * (optional) lets the caller overlay or replace deps at middleware-fire
 * time — used to bind a per-request `notifyEventChanged` to the live
 * pubsub username (which is only known after auth resolves).
 */
// Event types whose handlers MUST run synchronously inside the
// events.create chain (i.e. before next() is called) — without this,
// the response would race the side-effect.
//
// ET_BACK_CHANNEL: the requester's handleIncomingAccept POSTs this to
// the accepter's :_cmc:inbox; the response from that POST signals to
// the requester that the data-grant access has been updated. If we
// dispatch fire-and-forget, the response returns BEFORE the update
// commits, and any chat / system delivery the accepter triggers
// immediately afterwards finds the data-grant without an apiEndpoint
// (`cmc-chat-no-remote-apiendpoint`).
const SYNC_DISPATCH_TYPES = new Set<string>([
  'consent/back-channel-cmc',
]);

/**
 * Event types whose handlers ALWAYS POST outbound and would re-trigger on
 * the peer (creating a ping-pong loop) if dispatched on a peer-delivered
 * event. Skipped at dispatch time when `event.createdBy` resolves to a
 * counterparty-role access — see `isPeerDeliveredEvent`.
 *
 * Lifecycle types (accept / refuse / back-channel / request) are NOT in
 * here: their incoming variants do real protocol work (mint back-channel,
 * update data-grant). Routing for those is direction-aware via
 * `isOnInbox` already.
 */
const OUTBOUND_LOOPABLE_TYPES = new Set<string>([
  'message/chat-cmc',
  'notification/alert-cmc',
  'notification/ack-cmc',
  'consent/scope-request-cmc',
  'consent/scope-update-cmc',
  'consent/revoke-cmc',
]);

/**
 * True when the event was created on this mall by a counterparty-role
 * access (= the peer's plugin POSTed it via the access we hold for them).
 * False for user-originated events (personal / app / shared accesses), for
 * events with no `createdBy` (defensive), and when the access lookup
 * can't run.
 */
async function isPeerDeliveredEvent (
  userId: string,
  createdBy: string | undefined,
  deps: DispatchDeps
): Promise<boolean> {
  if (typeof createdBy !== 'string' || createdBy.length === 0) return false;
  const mallAccesses = deps.mall.accesses;
  if (mallAccesses?.get == null) return false;
  try {
    const list = await mallAccesses.get(userId, {});
    const acc = Array.isArray(list)
      ? list.find((a) => a?.id === createdBy)
      : null;
    return acc?.clientData?.cmc?.role === 'counterparty';
  } catch (_e) {
    return false;
  }
}

function createDispatchMiddleware (
  deps: DispatchDeps,
  buildPerRequestDeps?: (context: MiddlewareContext) => Partial<DispatchDeps>
): (context: MiddlewareContext, params: unknown, result: MiddlewareResult, next: () => void) => unknown {
  return function cmcDispatchMiddleware (context: MiddlewareContext, _params: unknown, result: MiddlewareResult, next: () => void) {
    // Read the event back from the result (api-server convention).
    const event = result?.event;
    const userId = context?.user?.id;
    if (event == null || userId == null || !C.isCmcEventType(event.type)) {
      return next();
    }
    const requestDeps: DispatchDeps = buildPerRequestDeps != null
      ? { ...deps, ...buildPerRequestDeps(context) }
      : deps;
    if (SYNC_DISPATCH_TYPES.has(event.type)) {
      // Synchronous dispatch — await before returning so the response
      // reflects the side-effect.
      dispatch({ userId, event, deps: requestDeps })
        .then(() => next())
        .catch((err: unknown) => {
          deps.logger?.warn?.('cmc/dispatch: sync handler failed', {
            type: event.type,
            error: String((err as Error)?.message ?? err),
          });
          // Don't propagate as an events.create failure — the event was
          // persisted; the side-effect failed and is logged. The retry
          // loop / operator can re-process from the trigger event.
          next();
        });
      return;
    }
    // Default: fire-and-forget. Errors captured inside dispatch.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    Promise.resolve()
      .then(() => dispatch({ userId, event, deps: requestDeps }))
      .catch((err) => {
        deps.logger?.warn?.('cmc/dispatch: unexpected uncaught error', {
          error: String((err as Error)?.message ?? err),
        });
      });
    next();
  };
}

export {
  dispatch,
  createDispatchMiddleware,
};
