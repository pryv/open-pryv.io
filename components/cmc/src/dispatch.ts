/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger, OutboundDeps } from './_types.ts';
import type { CredentialStash } from './credentialScrub.ts';
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
const handleIncomingRevokeMod = require('./handleIncomingRevoke.ts');
const handleIncomingRefuseMod = require('./handleIncomingRefuse.ts');
const handleIncomingBackChannelMod = require('./handleIncomingBackChannel.ts');
const handleInvalidateLinkMod = require('./handleInvalidateLink.ts');
const retryQueueMod = require('./retryQueue.ts');
const outbound = require('./outbound.ts');
const credentialScrub = require('./credentialScrub.ts');

/**
 * Options for every write this loop makes to a trigger event.
 *
 * `skipVersioning` because these are the plugin's own status stamps on the
 * app's trigger, not user edits, and one of them exists precisely to REMOVE a
 * credential from the row (see markCompleted). Under
 * `versioning.forceKeepHistory`, a version row would snapshot the pre-update
 * content, preserving exactly what is being scrubbed and putting it back
 * within reach of `events.getOne?includeHistory=true`. The cost is that a
 * trigger's intermediate statuses leave no history rows, which is bookkeeping
 * noise rather than user data.
 */
const STATUS_STAMP_OPTS = { skipVersioning: true };

type SelfIdentity = { username: string; host: string };

type CmcEvent = {
  id?: string;
  type: string;
  content?: Record<string, unknown> | null;
  streamIds?: string[];
  createdBy?: string;
  [k: string]: unknown;
};

import type { CmcAccessLike as CmcAccess, MallLike } from './_types.ts';

// Mall proxy types — these methods accept and return runtime payloads that
// vary by call site (Mongo-style queries, partial events, partial accesses).
// Keep param/result as `unknown` rather than `any` so consumers get the
// is-undefined check signal at least, but don't model the deep variants.



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
  // The AccessLogic instance of the access that wrote the trigger event
  // (carried over from context.access in the per-request deps closure).
  // handleAccept uses this to call canCreateAccess(payload) before
  // mall.accesses.create — mirroring the chain check the api-server's
  // accesses.create route enforces in applyPrerequisitesForCreation.
  // Defense-in-depth: cmcAcceptAccessGateHook already rejects non-personal
  // tokens at the events.create boundary; the chain check here closes
  // the mall bypass for any path that reaches handleAccept without the
  // gate (test fixtures, hypothetical future feature). Undefined in
  // unit-test contexts that mock dispatch directly — the chain check is
  // skipped in that case (gate is the primary guard).
  triggerAccess?: { canCreateAccess?: (payload: unknown) => boolean | Promise<boolean> };
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
  remoteEventId?: string;
  requesterIdentity?: { username: string; host: string };
  backChannelAccessId?: string;
  anchorStreamIds?: string[];
  // Peer-delivery outcome, reported alongside a successful local action
  // (see markCompleted): `ok` covers the local work, these cover whether
  // the counterparty was actually reached.
  peerNotified?: boolean;
  deliveryFailure?: { reason: string; status?: number };
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

  // A request trigger is not dispatched: its status reports the invite's
  // outcome (inviteState.ts). Return before the 'delivered' stamp below, which
  // writes the in-memory event whole and would overwrite that outcome.
  if (event.type === C.ET_REQUEST) {
    return { handled: false, eventType: event.type, status: 'skipped', reason: 'request-handled-elsewhere' };
  }

  // Stamp 'delivered' before running the handler (the handler may overwrite
  // to 'completed' or 'failed'; 'delivered' is the explicit "we've taken the
  // event off the queue" indicator).
  if (event.id != null && deps.mall.events.update != null) {
    try {
      const deliveredContent = { ...(event.content || {}), status: 'delivered' };
      // Scrubbed HERE too, not only at the terminal stamp. This write is
      // immediately followed by `notifyEventChanged`, which tells the user's
      // socket.io subscribers to fetch the row right now — so leaving the
      // token in it publishes a credential AND invites a read of it. On an
      // incoming back-channel that token is the PEER's, which this account's
      // apps never legitimately held.
      await deps.mall.events.update(userId, {
        ...event,
        content: credentialScrub.scrubCredentials(deliveredContent) ?? deliveredContent,
      }, null, STATUS_STAMP_OPTS);
      // The IN-MEMORY event deliberately keeps the usable content: the handler
      // about to run reads its `capabilityUrl` / `apiEndpoint` from here,
      // `enqueueRetry` snapshots it into the internal retries stream so a
      // retry can re-dispatch, and the terminal stamps build from it and scrub
      // on their own way out. On the live path this object is the middleware's
      // re-hydrated COPY (see createDispatchMiddleware): the row in storage
      // never held the token in the first place. Carrying the status forward
      // also keeps a handler that rewrites `content` (the incoming-revoke
      // enrichment) from dropping it.
      event.content = deliveredContent;
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
  //
  // Revoke is the one type whose incoming variant also does real protocol
  // work — it enforces the revocation locally — so it is routed on the inbox
  // stream as well, see below.
  if (OUTBOUND_LOOPABLE_TYPES.has(event.type)) {
    const peerDelivered = await isPeerDeliveredEvent(userId, event.createdBy, deps);
    // A revoke sitting on `:_cmc:inbox` is peer-delivered by construction:
    // `inboxWriteHook` refuses any write there that does not come from a
    // counterparty-marked access. The test is that stream exactly, not
    // `isOnInbox`, which also matches the per-capability responses streams
    // where that guarantee does not hold. Routing on the stream as well as on
    // `createdBy` matters because the incoming handler DELETES that access, so
    // a later re-dispatch of the same event (retry loop, operator
    // re-processing) would otherwise fall through to `handleRevoke` with the
    // peer's foreign `content.accessId` and mark the withdrawal 'failed' —
    // which an app reads as "the revocation did not work".
    const incoming = peerDelivered ||
      (event.type === C.ET_REVOKE && (event.streamIds ?? []).includes(C.NS_INBOX));
    if (incoming) {
      // An incoming revoke is where the revocation is ENFORCED on this side:
      // the handler deletes the relationship access the peer holds here, then
      // marks a single-use invite it descends from as revoked. It POSTs
      // nothing (its deletes go through the mall, not the api-server route, so
      // they do not fire the accesses-delete hook), so the loop-safety above is
      // unaffected; a failure only logs and never blocks the skip result below.
      if (event.type === C.ET_REVOKE) {
        try {
          await handleIncomingRevokeMod.handleIncomingRevoke({
            userId,
            event,
            deps: {
              mall: deps.mall,
              logger: deps.logger,
              notifyEventChanged: deps.notifyEventChanged,
            },
          });
        } catch (err: unknown) {
          deps.logger?.warn?.('cmc/dispatch: handleIncomingRevoke failed (non-fatal)', {
            error: String((err as Error)?.message ?? err),
          });
        }
      }
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
        // Direction-aware, like accept: a refuse on a responses stream was
        // delivered by the invited party (record it on the invite); one on a
        // :_cmc:apps:* stream is the local user declining (deliver it).
        if (isOnInbox(event)) {
          result = await handleIncomingRefuseMod.handleIncomingRefuse({
            userId, event, deps,
          });
        } else {
          result = await handleAcceptMod.handleRefuse({
            userId, triggerEvent: event, selfIdentity, deps,
          });
        }
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
        // Per-capability lifecycle (open-link mode). Requester
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
      // WITHOUT its token: the trigger event lives in the accepter's own
      // `:_cmc:apps:<app-code>` stream, which an app (typically the
      // requester's) can hold `read` on, and which every export of the
      // account carries. The full endpoint here is a working credential to
      // the accepter's own data; the record only needs to say WHICH access
      // was granted, and `dataGrantAccessId` below already does.
      acceptedBy: result?.dataGrantApiEndpoint
        ? { apiEndpoint: outbound.stripCredentials(result.dataGrantApiEndpoint) }
        : undefined,
      dataGrantAccessId: result?.dataGrantAccessId,
      offerEventId: result?.offerEventId,
      capabilityId: result?.capabilityId,
      // A collector's scope request arrives on the user's account as a
      // different event; the user side must answer THAT id, and this is the
      // only place the collector can learn it.
      remoteEventId: event.type === C.ET_SYSTEM_SCOPE_REQUEST ? result?.remoteEventId : undefined,
      // For handleAccept (accepter side): stamp the resolved REQUESTER
      // identity so listAcceptedRelationships's mapper picks up
      // `content.from = {username, host}` instead of falling through to
      // `content.acceptedBy` (which carries only the accepter's own
      // data-grant endpoint, token stripped). Without this the patient app
      // can't identify the doctor on each relationship row.
      from: result?.requesterIdentity,
      // handleIncomingAccept fields:
      backChannelAccessId: result?.backChannelAccessId,
      anchorStreamIds: result?.anchorStreamIds,
      // Delivery outcome (revoke, and any handler that reports it).
      // `status: 'completed'` means the LOCAL action succeeded — for a
      // revoke that is the authoritative part (the accesses are gone).
      // It does NOT mean the counterparty was told, so surface that
      // separately: a caller polling the trigger can now distinguish
      // "peer knows" from "peer was never reachable", instead of reading
      // an unqualified success. `deliveryFailure.reason` names which.
      peerNotified: result?.peerNotified,
      deliveryFailure: result?.deliveryFailure,
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
    const content: Record<string, unknown> = {
      ...(event.content || {}),
      status: 'completed',
      ...cleaned,
    };
    // The app posts the invite URL, token included, as the trigger's
    // `capabilityUrl`, and the handler has just finished using it. Keep the
    // URL for reference but not the credential: the trigger sits in a
    // `:_cmc:apps:*` stream an app can be granted and an export includes,
    // and in open-link mode the capability stays live after the accept, so
    // the stored copy would remain a usable invite indefinitely.
    const scrubbed = credentialScrub.scrubCredentials(content) ?? content;
    await deps.mall.events.update(userId, { ...event, content: scrubbed }, null, STATUS_STAMP_OPTS);
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
      // Scrubbed like the success path, and for the same reason: this row
      // lives in a `:_cmc:apps:*` stream an app can be granted and an export
      // includes. A failure does not make the token safe to keep there — it
      // makes it MORE dangerous, because a failed single-use accept leaves
      // the requester's capability unconsumed, so the stored invite URL is
      // still live.
      //
      // Safe because the retry path never reads this row: `enqueueRetry`
      // above has already snapshotted the full content into the retry event
      // in `:_cmc:_internal:retries` (unreachable by any API read path), and
      // `processRetryEvent` rebuilds its synthetic trigger from THAT snapshot,
      // never from storage. Order matters: the enqueue precedes this write.
      const failedContent = {
        ...(event.content || {}),
        status: 'failed',
        failure: { reason, detail: detail ?? null },
      };
      await deps.mall.events.update(userId, {
        ...event,
        content: credentialScrub.scrubCredentials(failedContent) ?? failedContent,
      }, null, STATUS_STAMP_OPTS);
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
 *
 * `consent/revoke-cmc` is in here because its OUTBOUND handler POSTs, but its
 * incoming variant is not a no-op either: it tears down the access the peer
 * holds here. It is therefore additionally routed on `isOnInbox`, so that an
 * inbox revoke keeps taking the incoming path once that access is gone.
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
  // `createdBy` is the access id, but becomes `<accessId> <callerId>` when the
  // caller supplied a callerId (MethodContext joins them with a space).
  // Comparing the whole string silently misses every suffixed value, which
  // makes a peer-delivered event look user-originated — and this guard is what
  // stops chat/system ping-pong between the two accounts.
  const separatorIndex = createdBy.indexOf(' ');
  const createdByAccessId = separatorIndex === -1
    ? createdBy
    : createdBy.slice(0, separatorIndex);
  try {
    const list = await mallAccesses.get(userId, {});
    const acc = Array.isArray(list)
      ? list.find((a) => a?.id === createdByAccessId)
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
    const stored = result?.event;
    const userId = context?.user?.id;
    if (stored == null || userId == null || !C.isCmcEventType(stored.type)) {
      return next();
    }
    // Work from a COPY, re-hydrated with whatever the pre-persist stash hook
    // took out (see credentialStashHook.ts). Two reasons:
    //   - the orchestration needs the usable values: the handler reads the
    //     endpoint off this object, and `enqueueRetry` snapshots it into the
    //     internal retries stream so a retry can re-dispatch.
    //   - `result.event` is the response body, and the object
    //     `addIntegrityToContext` verified. `dispatch` stamps `event.content`
    //     in memory, so sharing the object would mutate the response after
    //     the fact. The copy keeps that from happening.
    // With no stash (a unit test, or a record that carried no token) the
    // hydration is the content unchanged.
    const stash = (context as { cmc?: { credentials?: CredentialStash } })?.cmc?.credentials;
    const event: CmcEvent = {
      ...stored,
      content: credentialScrub.restoreCredentials(stored.content, stash),
    };
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
          // persisted; the side-effect failed and is logged. The retry loop
          // re-processes from its own snapshot in the internal retries
          // stream, which is the ONLY re-dispatch source: the stored trigger
          // carries no usable endpoint at any point in its life.
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
