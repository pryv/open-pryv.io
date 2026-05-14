/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
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
const retryQueueMod = require('./retryQueue.ts');

type SelfIdentity = { username: string; host: string };

type MallLike = {
  accesses: { create: (userId: string, params: any) => Promise<any>; delete?: (userId: string, params: any) => Promise<any>; update?: (userId: string, params: any) => Promise<any> };
  events:   { update: (userId: string, params: any) => Promise<any>; create: (userId: string, params: any) => Promise<any> };
  streams:  { create: (userId: string, params: any) => Promise<any> };
};

type OutboundDeps = {
  fetch: (url: string, init?: any) => Promise<any>;
  timeoutMs?: number;
};

type DispatchDeps = {
  mall: MallLike;
  fetch: OutboundDeps['fetch'];
  timeoutMs?: number;
  logger?: { debug: Function; warn: Function; info?: Function };
  selfIdentityFor: (userId: string) => Promise<SelfIdentity> | SelfIdentity;
  // When true (default), retryable handler failures are auto-enqueued
  // in :_cmc:_internal:retries for later re-dispatch by the retry loop.
  // Disable for tests that don't want the side-effect.
  enqueueRetries?: boolean;
  // Optional callback fired after each mall.events.update we perform on
  // the trigger event (status transitions). Lets the api-server emit
  // pubsub.USERNAME_BASED_EVENTS_CHANGED so the app's socket.io
  // subscription sees the status flip. No-op if undefined.
  notifyEventChanged?: (userId: string, event: any) => void;
};

type DispatchResult = {
  handled: boolean;
  eventType: string | null;
  status: 'pending' | 'delivered' | 'completed' | 'failed' | 'skipped';
  reason?: string;
  detail?: any;
};

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
  event: { id?: string; type: string; content: any; streamIds?: string[] };
  deps: DispatchDeps;
}): Promise<DispatchResult> {
  const { userId, event, deps } = params;
  if (typeof event?.type !== 'string') {
    return { handled: false, eventType: null, status: 'skipped', reason: 'no-event-type' };
  }
  if (!event.type.startsWith('cmc/')) {
    return { handled: false, eventType: event.type, status: 'skipped', reason: 'not-cmc-event' };
  }

  // Stamp 'delivered' before running the handler (the handler may overwrite
  // to 'completed' or 'failed'; 'delivered' is the explicit "we've taken the
  // event off the queue" indicator).
  if (event.id != null && deps.mall.events.update != null) {
    try {
      await deps.mall.events.update(userId, {
        id: event.id,
        update: { content: { ...(event.content || {}), status: 'delivered' } },
      });
      try { deps.notifyEventChanged?.(userId, event); } catch (_e) { /* notify is best-effort */ }
    } catch (err: any) {
      deps.logger?.warn('cmc/dispatch: failed to mark trigger as delivered', {
        eventId: event.id,
        error: String(err?.message || err),
      });
    }
  }

  let selfIdentity: SelfIdentity;
  try {
    const resolved = await deps.selfIdentityFor(userId);
    selfIdentity = resolved;
  } catch (err: any) {
    return await markFailed(deps, userId, event, 'cmc-dispatch-self-identity-failed', {
      message: String(err?.message || err),
    });
  }

  let result: any;
  try {
    switch (event.type) {
      case C.ET_ACCEPT:
        // Direction-aware routing:
        //   - cmc/accept-v1 written on :_cmc:inbox = peer-delivered (the
        //     accepter has just POSTed their accept to us via the
        //     capability URL). Mint the back-channel access + provision
        //     anchor streams via handleIncomingAccept.
        //   - cmc/accept-v1 written on a :_cmc:apps:* stream = the LOCAL
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
      default:
        return { handled: false, eventType: event.type, status: 'skipped', reason: 'unknown-cmc-event' };
    }
  } catch (err: any) {
    return await markFailed(deps, userId, event, 'cmc-dispatch-handler-threw', {
      message: String(err?.message || err),
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

async function markCompleted (deps: DispatchDeps, userId: string, event: any, extra: any): Promise<DispatchResult> {
  if (event.id == null || deps.mall.events.update == null) {
    return { handled: true, eventType: event.type, status: 'completed' };
  }
  try {
    const cleaned: any = {};
    if (extra != null) {
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined) cleaned[k] = v;
      }
    }
    await deps.mall.events.update(userId, {
      id: event.id,
      update: { content: { ...(event.content || {}), status: 'completed', ...cleaned } },
    });
    try { deps.notifyEventChanged?.(userId, event); } catch (_e) { /* best-effort */ }
  } catch (err: any) {
    deps.logger?.warn('cmc/dispatch: failed to mark trigger as completed', {
      eventId: event.id,
      error: String(err?.message || err),
    });
  }
  return { handled: true, eventType: event.type, status: 'completed' };
}

async function markFailed (
  deps: DispatchDeps,
  userId: string,
  event: any,
  reason: string,
  detail?: any
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
          dispatch: dispatch as any,
          dispatchDeps: deps,
          logger: deps.logger,
        },
      });
    } catch (err: any) {
      deps.logger?.warn('cmc/dispatch: failed to enqueue retry', {
        eventId: event.id,
        error: String(err?.message || err),
      });
    }
  }
  if (event.id != null && deps.mall.events.update != null) {
    try {
      await deps.mall.events.update(userId, {
        id: event.id,
        update: {
          content: {
            ...(event.content || {}),
            status: 'failed',
            failure: { reason, detail: detail ?? null },
          },
        },
      });
      try { deps.notifyEventChanged?.(userId, event); } catch (_e) { /* best-effort */ }
    } catch (err: any) {
      deps.logger?.warn('cmc/dispatch: failed to mark trigger as failed', {
        eventId: event.id,
        reason,
        error: String(err?.message || err),
      });
    }
  }
  return { handled: true, eventType: event.type, status: 'failed', reason, detail };
}

/**
 * True if the event's streamIds list includes :_cmc:inbox.
 *
 * Used by the dispatch loop to disambiguate the cmc/accept-v1 direction:
 * peer-delivered accepts land on :_cmc:inbox via the inbox write-hook;
 * locally-initiated accepts live in the user's :_cmc:apps:* scope.
 */
function isOnInbox (event: any): boolean {
  const ids = Array.isArray(event?.streamIds) ? event.streamIds : [];
  return ids.includes(C.NS_INBOX);
}

/**
 * Build a request-scoped dispatch middleware. `buildPerRequestDeps`
 * (optional) lets the caller overlay or replace deps at middleware-fire
 * time — used to bind a per-request `notifyEventChanged` to the live
 * pubsub username (which is only known after auth resolves).
 */
function createDispatchMiddleware (
  deps: DispatchDeps,
  buildPerRequestDeps?: (context: any) => Partial<DispatchDeps>
): (context: any, params: any, result: any, next: any) => void {
  return function cmcDispatchMiddleware (context: any, _params: any, result: any, next: any) {
    // Read the event back from the result (api-server convention).
    const event = result?.event;
    const userId = context?.user?.id;
    if (event != null && userId != null && typeof event.type === 'string' && event.type.startsWith('cmc/')) {
      const requestDeps: DispatchDeps = buildPerRequestDeps != null
        ? { ...deps, ...buildPerRequestDeps(context) }
        : deps;
      // Fire-and-forget. Errors are captured inside dispatch.
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      Promise.resolve()
        .then(() => dispatch({ userId, event, deps: requestDeps }))
        .catch((err) => {
          deps.logger?.warn('cmc/dispatch: unexpected uncaught error', {
            error: String(err?.message || err),
          });
        });
    }
    next();
  };
}

export {
  dispatch,
  createDispatchMiddleware,
};
