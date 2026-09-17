/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger, OutboundDeps } from './_types.ts';
import type { DeliverResult } from './outbound.ts';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — system-channel handlers (alerts + acks).
 *
 * The system channel carries operator-grade signalling between a user and
 * a counterparty: e.g. a peer is down, a scope-change happened, the
 * relationship was disrupted. Triggered by writes to:
 *
 *   :_cmc:apps:<app-code>:[<user-path>:]collectors:<counterparty-slug>
 *
 * Plugin orchestration (mirror of chat):
 *   1. Parse the trigger stream-id to extract counterparty slug + app scope.
 *   2. Resolve the user's counterparty-access by (app-code, username, host).
 *   3. Look up the remote system stream-id stored on the access's
 *      clientData.cmc.counterparty.remoteCollectorStreamId (filled at
 *      acceptance time). For now, callers may pass it
 *      explicitly via the access.
 *   4. POST `notification/alert-cmc` or `notification/ack-cmc` to the peer.
 */

const C = require('./constants.ts');
const slugMod = require('./slug.ts');
const outbound = require('./outbound.ts');
const accessesUpdateHookMod = require('./accessesUpdateHook.ts');
const relationshipKey = require('./relationshipKey.ts');
const validators = require('./validators.ts');
const { CmcErrorIds } = require('./errorIds.ts');

// Matches the trailing :collectors:<counterparty-slug> portion of a
// system-channel stream-id. Captures (1) the prefix (app scope), (2) the
// counterparty slug.
const COLLECTOR_STREAM_ID_RE = /^(:_cmc:apps:[^:]+(?::[^:]+)*):collectors:([a-z0-9-]+--[a-z0-9-]+)$/;

type Counterparty = { username: string; host: string };

type ParsedCollectorStream = {
  appCode: string;
  scopeStreamId: string;
  counterpartySlug: string;
  counterparty: { username: string; hostSlug: string };
};

/**
 * Parse a system-channel trigger stream-id. Returns null on shape mismatch.
 */
function parseCollectorStreamId (streamId: string): ParsedCollectorStream | null {
  if (typeof streamId !== 'string') return null;
  const m = streamId.match(COLLECTOR_STREAM_ID_RE);
  if (m == null) return null;
  const scopeStreamId = m[1];
  const counterpartySlug = m[2];
  let counterparty;
  try {
    counterparty = slugMod.parseCounterpartySlug(counterpartySlug);
  } catch (_e) {
    return null;
  }
  const appCode = C.getAppCode(scopeStreamId);
  if (appCode == null) return null;
  return { appCode, scopeStreamId, counterpartySlug, counterparty };
}

import type { CmcAccessLike as AccessLike, MallAccessesLike, MallEventsLike } from './_types.ts';


type SystemHandlerResult =
  | {
      ok: true;
      eventType: string;
      remoteEventId?: string;
      currentCount?: number;
      // Scope-update outcome (handleSystemScopeUpdate).
      accessId?: string;
      newPermissions?: Array<Record<string, unknown>>;
      applied?: boolean;
    }
  | {
      ok: false;
      reason: string;
      detail?: unknown;
    };

type DeliverSystemParams = {
  remoteApiEndpoint: string;
  remoteCollectorStreamId: string;
  eventType: string; // notification/alert-cmc or notification/ack-cmc
  payload: Record<string, unknown>;
  selfIdentity: Counterparty;
  deps: OutboundDeps;
};

/**
 * POST a system message to the counterparty's collectors stream.
 *
 * Returns outbound.postToPeer's discriminated-union result.
 */
async function deliverSystemToPeer (params: DeliverSystemParams): Promise<DeliverResult> {
  const { remoteApiEndpoint, remoteCollectorStreamId, eventType, payload, selfIdentity, deps } = params;
  return outbound.postToPeer({
    apiEndpoint: remoteApiEndpoint,
    path: 'events',
    body: {
      streamIds: [remoteCollectorStreamId],
      type: eventType,
      content: {
        ...(payload ?? {}),
        from: selfIdentity,
      },
    },
    deps,
  });
}

/**
 * Shared dispatch core for notification/alert-cmc + notification/ack-cmc.
 *
 * Both event types share the same routing: pull counterparty access,
 * deliver to peer's collectors stream. The only thing that differs is
 * the type field carried into the peer body, so the handler accepts it
 * as a parameter.
 */
const SYSTEM_EVENT_TYPES = new Set([
  C.ET_SYSTEM_ALERT,
  C.ET_SYSTEM_ACK,
  C.ET_SYSTEM_SCOPE_REQUEST,
  C.ET_SYSTEM_SCOPE_UPDATE,
]);

async function handleSystemEvent (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: Record<string, unknown>; streamIds?: string[] };
  selfIdentity: Counterparty;
  deps: {
    mall: { accesses: MallAccessesLike };
    fetch: OutboundDeps['fetch'];
    timeoutMs?: number;
    logger?: CmcLogger;
  };
}): Promise<SystemHandlerResult> {
  const { userId, triggerEvent, selfIdentity, deps } = params;

  if (!SYSTEM_EVENT_TYPES.has(triggerEvent.type)) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: triggerEvent.type } };
  }

  // Pick the collector stream from the trigger's streamIds. An event may
  // be written to multiple streams; we route off the first one that
  // matches the collector pattern.
  const streamIds = Array.isArray(triggerEvent.streamIds) ? triggerEvent.streamIds : [];
  let parsed: ParsedCollectorStream | null = null;
  for (const sid of streamIds) {
    parsed = parseCollectorStreamId(sid);
    if (parsed != null) break;
  }
  if (parsed == null) {
    return { ok: false, reason: 'cmc-system-stream-not-collector', detail: { streamIds } };
  }

  // Resolve the counterparty-access for this (appCode, counterparty).
  // The access stores the remote apiEndpoint + collectors stream-id.
  // We need to map the hostSlug back to the actual host — we read both
  // off the access (the hostSlug in the trigger stream-id is just a
  // routing tag, the access's stored host is canonical).
  const accessesList = await deps.mall.accesses.get(userId, {});
  // Resolve by the relationship's scope — the trigger arrived on
  // `<scope>:collectors:<peer>`, so the scope identifies which of this
  // peer's relationships this alert belongs to. Shared with the inbound
  // matcher so stamping and delivery cannot disagree.
  const chosen: AccessLike | null = relationshipKey.selectRelationshipAccess({
    accesses: accessesList,
    counterparty: parsed.counterparty,
    scopeStreamId: parsed.scopeStreamId,
    appCode: parsed.appCode,
    logger: deps.logger,
  });
  if (chosen == null) {
    return { ok: false, reason: 'cmc-system-counterparty-access-not-found', detail: {
      appCode: parsed.appCode,
      counterpartySlug: parsed.counterpartySlug,
    } };
  }

  const cmc = chosen.clientData?.cmc;

  // Features gating — the offer's negotiated
  // `features.systemMessaging` is the relationship's binding contract.
  // When the counterparty access carries
  // `clientData.cmc.features.systemMessaging === false`, alert + ack
  // sends are rejected. Scope-request / scope-update events are NOT
  // subject to this gate — they're protocol-level (relationship
  // governance), not user-level messaging.
  const isUserMessaging = triggerEvent.type === C.ET_SYSTEM_ALERT ||
                          triggerEvent.type === C.ET_SYSTEM_ACK;
  if (isUserMessaging && (cmc as { features?: { systemMessaging?: boolean } } | undefined)?.features?.systemMessaging === false) {
    return { ok: false, reason: 'cmc-system-messaging-disabled', detail: { accessId: chosen.id, eventType: triggerEvent.type } };
  }

  const remoteApiEndpoint = (cmc as { counterparty?: { apiEndpoint?: string } } | undefined)?.counterparty?.apiEndpoint;
  const remoteCollectorStreamId = (cmc as { counterparty?: { remoteCollectorStreamId?: string } } | undefined)?.counterparty?.remoteCollectorStreamId;
  if (typeof remoteApiEndpoint !== 'string' || remoteApiEndpoint.length === 0) {
    return { ok: false, reason: 'cmc-system-no-remote-apiendpoint', detail: { accessId: chosen.id } };
  }
  if (typeof remoteCollectorStreamId !== 'string' || remoteCollectorStreamId.length === 0) {
    return { ok: false, reason: 'cmc-system-no-remote-collector-stream', detail: { accessId: chosen.id } };
  }

  let delivery: { ok?: boolean; response?: { status?: number; body?: unknown; reason?: string }; remoteEventId?: string; currentCount?: number; [k: string]: unknown } | undefined;
  try {
    delivery = await deliverSystemToPeer({
      remoteApiEndpoint,
      remoteCollectorStreamId,
      eventType: triggerEvent.type,
      payload: triggerEvent.content ?? {},
      selfIdentity,
      deps,
    });
  } catch (err: unknown) {
    return { ok: false, reason: 'cmc-handler-delivery-threw', detail: { message: String((err as Error)?.message || err) } };
  }

  if (!delivery?.ok) {
    return {
      ok: false,
      reason: 'cmc-handler-delivery-failed',
      detail: { status: (delivery as { status?: number } | undefined)?.status, peerReason: (delivery as { reason?: string } | undefined)?.reason },
    };
  }

  return {
    ok: true,
    eventType: triggerEvent.type,
    remoteEventId: (delivery as { body?: { event?: { id?: string } } } | undefined)?.body?.event?.id,
  };
}

/**
 * Handle a `notification/alert-cmc` trigger.
 *
 * Thin wrapper around handleSystemEvent — kept distinct so the dispatch
 * switch is one-handler-per-event-type and future divergence (e.g. alert
 * needs to also write a local sentinel) is a localised change.
 */
async function handleSystemAlert (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: Record<string, unknown>; streamIds?: string[] };
  selfIdentity: Counterparty;
  deps: { mall: { accesses: MallAccessesLike }; fetch: (url: string, init?: RequestInit) => Promise<Response>; logger?: CmcLogger; [k: string]: unknown };
}): Promise<SystemHandlerResult> {
  if (params.triggerEvent.type !== C.ET_SYSTEM_ALERT) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: params.triggerEvent.type } };
  }
  return handleSystemEvent(params);
}

/**
 * Handle a `notification/ack-cmc` trigger.
 */
async function handleSystemAck (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: Record<string, unknown>; streamIds?: string[] };
  selfIdentity: Counterparty;
  deps: { mall: { accesses: MallAccessesLike }; fetch: (url: string, init?: RequestInit) => Promise<Response>; logger?: CmcLogger; [k: string]: unknown };
}): Promise<SystemHandlerResult> {
  if (params.triggerEvent.type !== C.ET_SYSTEM_ACK) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: params.triggerEvent.type } };
  }
  return handleSystemEvent(params);
}

/**
 * Handle a `consent/scope-request-cmc` trigger.
 *
 * Issued when the LOCAL side wants to request additional permissions on
 * an existing data-grant the peer holds. The content carries the requested
 * permissions diff; this handler delivers it via the system channel.
 *
 * Peer-side application of the change (approval, applying the
 * accesses.update) happens on the peer when they receive
 * consent/scope-update-cmc from us — that's a separate trigger
 * issued AFTER local consent.
 */
async function handleSystemScopeRequest (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: Record<string, unknown>; streamIds?: string[] };
  selfIdentity: Counterparty;
  deps: { mall: { accesses: MallAccessesLike }; fetch: (url: string, init?: RequestInit) => Promise<Response>; logger?: CmcLogger; [k: string]: unknown };
}): Promise<SystemHandlerResult> {
  if (params.triggerEvent.type !== C.ET_SYSTEM_SCOPE_REQUEST) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: params.triggerEvent.type } };
  }
  return handleSystemEvent(params);
}

type ScopeUpdateDeps = {
  mall: { accesses: MallAccessesLike; events?: Partial<MallEventsLike> };
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  logger?: CmcLogger;
  // The trigger-writer's AccessLogic, for the permission-chain re-check.
  triggerAccess?: {
    canUpdateAccess?: (target: Record<string, unknown>) => boolean | Promise<boolean>;
    canCreateAccess?: (payload: Record<string, unknown>) => boolean | Promise<boolean>;
  };
};

type ScopeUpdateParams = {
  userId: string;
  triggerEvent: { id?: string; type: string; content: Record<string, unknown>; streamIds?: string[] };
  selfIdentity: Counterparty;
  deps: ScopeUpdateDeps;
};

type PermissionList = Array<Record<string, unknown>>;

type RequestEventLike = {
  id?: string;
  type?: string;
  streamIds?: string[];
  createdBy?: string;
  trashed?: boolean;
  content?: Record<string, unknown>;
};

type ScopeUpdateTarget =
  | { ok: true; accessId: string; newPermissions: PermissionList; requestEvent?: RequestEventLike }
  | { ok: false; reason: string; detail?: unknown };

const isCmcMachinery = (p: Record<string, unknown>): boolean =>
  typeof p?.streamId === 'string' && p.streamId.startsWith(':_cmc:');

function firstCollectorStream (streamIds: unknown): string | null {
  if (!Array.isArray(streamIds)) return null;
  for (const sid of streamIds) {
    if (parseCollectorStreamId(sid) != null) return sid;
  }
  return null;
}

/**
 * Resolve and bind the collector's `consent/scope-request-cmc` a response
 * refers to. The request must be the one that ARRIVED on this account: written
 * by the counterparty grant that serves the request's own collectors stream.
 * That binding is what stops one peer's request from widening another peer's
 * grant, and a user-written event from posing as a peer's request.
 */
async function resolveScopeRequest (params: {
  userId: string;
  triggerEvent: ScopeUpdateParams['triggerEvent'];
  triggerStream: string;
  accessList: AccessLike[];
  deps: ScopeUpdateDeps;
}): Promise<{ ok: true; requestEvent: RequestEventLike; grant: AccessLike } | { ok: false; reason: string; detail?: unknown }> {
  const { userId, triggerEvent, triggerStream, accessList, deps } = params;
  const scopeRequestEventId = triggerEvent.content.scopeRequestEventId as string;
  const notFound = { ok: false as const, reason: CmcErrorIds.SCOPE_REQUEST_NOT_FOUND, detail: { scopeRequestEventId } };

  if (deps.mall.events?.getOne == null) return notFound;
  let requestEvent: RequestEventLike | null = null;
  try {
    // getOne, not get({ id }): the events query does not filter on `id`.
    requestEvent = (await deps.mall.events.getOne(userId, scopeRequestEventId)) as RequestEventLike | null;
  } catch (_e) {
    return notFound;
  }
  if (requestEvent == null || requestEvent.trashed === true || requestEvent.type !== C.ET_SYSTEM_SCOPE_REQUEST) {
    return notFound;
  }

  const notFromPeer = { ok: false as const, reason: CmcErrorIds.SCOPE_REQUEST_NOT_FROM_PEER, detail: { scopeRequestEventId } };
  const requestStream = firstCollectorStream(requestEvent.streamIds);
  if (requestStream == null) return notFromPeer;
  const createdBy = requestEvent.createdBy;
  if (typeof createdBy !== 'string' || createdBy.length === 0) return notFromPeer;
  // `createdBy` is `<accessId>` or `<accessId> <callerId>`.
  const sep = createdBy.indexOf(' ');
  const createdByAccessId = sep === -1 ? createdBy : createdBy.slice(0, sep);
  const grant = accessList.find((a) => a?.id === createdByAccessId) ?? null;
  if (grant == null || grant.clientData?.cmc?.role !== 'counterparty') return notFromPeer;
  // The grant's own channel permission names the relationship it serves; a
  // peer cannot choose which stream its grant may write to.
  const servesRequestStream = Array.isArray(grant.permissions) &&
    grant.permissions.some((p) => (p as { streamId?: unknown })?.streamId === requestStream);
  if (!servesRequestStream) return notFromPeer;

  if (triggerStream !== requestStream) {
    return {
      ok: false,
      reason: CmcErrorIds.SCOPE_REQUEST_STREAM_MISMATCH,
      detail: { scopeRequestEventId, requestStreamId: requestStream, triggerStreamId: triggerStream },
    };
  }

  const content = requestEvent.content ?? {};
  if (typeof content.expires === 'number' && content.expires < Date.now() / 1000) {
    return { ok: false, reason: CmcErrorIds.SCOPE_REQUEST_EXPIRED, detail: { scopeRequestEventId, expires: content.expires } };
  }
  // Answered by THIS trigger means a re-dispatch (retry): proceed.
  if (content.responseEventId != null && content.responseEventId !== triggerEvent.id) {
    return { ok: false, reason: CmcErrorIds.SCOPE_REQUEST_ALREADY_ANSWERED, detail: { scopeRequestEventId } };
  }

  return { ok: true, requestEvent, grant };
}

/**
 * Decide which grant a scope-update applies to and with which permissions.
 *
 *   (a) response to a collector's request (`scopeRequestEventId`): both come
 *       from the bound request, never from the client;
 *   (b) self-initiated, explicit (`accessId` + `newPermissions`): the target
 *       must be a counterparty grant;
 *   (c) self-initiated, implicit (`newPermissions` only): the relationship
 *       grant of the trigger's collectors stream.
 */
async function resolveScopeUpdateTarget (params: {
  userId: string;
  triggerEvent: ScopeUpdateParams['triggerEvent'];
  triggerStream: string;
  accessList: AccessLike[];
  deps: ScopeUpdateDeps;
}): Promise<ScopeUpdateTarget> {
  const { triggerEvent, triggerStream, accessList, deps } = params;
  const content = triggerEvent.content ?? {};

  if (typeof content.scopeRequestEventId === 'string') {
    // An answer must say what it answers: only an explicit acceptance applies.
    if (content.accept !== true) {
      return { ok: false, reason: CmcErrorIds.SCOPE_UPDATE_NOTHING_TO_APPLY, detail: { scopeRequestEventId: content.scopeRequestEventId } };
    }
    const bound = await resolveScopeRequest(params);
    if (!bound.ok) return bound;
    const requestContent = bound.requestEvent.content ?? {};
    const validation = validators.validate(C.ET_SYSTEM_SCOPE_REQUEST, requestContent);
    if (!validation.valid || !Array.isArray(requestContent.newPermissions)) {
      return {
        ok: false,
        reason: CmcErrorIds.SCOPE_REQUEST_INVALID,
        detail: { scopeRequestEventId: content.scopeRequestEventId },
      };
    }
    return {
      ok: true,
      accessId: bound.grant.id,
      newPermissions: requestContent.newPermissions as PermissionList,
      requestEvent: bound.requestEvent,
    };
  }

  if (typeof content.accessId === 'string' && Array.isArray(content.newPermissions)) {
    const target = accessList.find((a) => a?.id === content.accessId) ?? null;
    if (target == null || target.clientData?.cmc?.role !== 'counterparty') {
      return {
        ok: false,
        reason: CmcErrorIds.SCOPE_UPDATE_TARGET_NOT_COUNTERPARTY,
        detail: { accessId: content.accessId },
      };
    }
    // The peer notified is resolved from the trigger stream: the grant changed
    // must be the one serving that stream, or the notice would describe
    // another relationship's grant.
    const servesTriggerStream = Array.isArray(target.permissions) &&
      target.permissions.some((p) => (p as { streamId?: unknown })?.streamId === triggerStream);
    if (!servesTriggerStream) {
      return {
        ok: false,
        reason: CmcErrorIds.SCOPE_UPDATE_TARGET_STREAM_MISMATCH,
        detail: { accessId: target.id, triggerStreamId: triggerStream },
      };
    }
    return { ok: true, accessId: target.id, newPermissions: content.newPermissions as PermissionList };
  }

  if (Array.isArray(content.newPermissions)) {
    const parsed = parseCollectorStreamId(triggerStream) as ParsedCollectorStream;
    const chosen: AccessLike | null = relationshipKey.selectRelationshipAccess({
      accesses: accessList,
      counterparty: parsed.counterparty,
      scopeStreamId: parsed.scopeStreamId,
      appCode: parsed.appCode,
      logger: deps.logger,
    });
    if (chosen == null) {
      return {
        ok: false,
        reason: 'cmc-system-counterparty-access-not-found',
        detail: { appCode: parsed.appCode, counterpartySlug: parsed.counterpartySlug },
      };
    }
    return { ok: true, accessId: chosen.id, newPermissions: content.newPermissions as PermissionList };
  }

  return { ok: false, reason: CmcErrorIds.SCOPE_UPDATE_NOTHING_TO_APPLY };
}

/**
 * Best-effort: record on the stored request how it was answered, so a second
 * answer is refused and a reader of the request sees its outcome.
 */
async function stampScopeRequest (
  userId: string,
  requestEvent: RequestEventLike,
  status: 'accepted' | 'refused',
  responseEventId: string | undefined,
  deps: ScopeUpdateDeps
): Promise<void> {
  if (deps.mall.events?.update == null) return;
  try {
    await deps.mall.events.update(userId, {
      ...requestEvent,
      content: { ...(requestEvent.content ?? {}), status, responseEventId },
    });
  } catch (err: unknown) {
    deps.logger?.warn?.('cmc/handleSystemScopeUpdate: failed to stamp the scope request', {
      scopeRequestEventId: requestEvent.id,
      error: String((err as Error)?.message || err),
    });
  }
}

/**
 * Best-effort: write the outcome recorded on the trigger (`applied`,
 * `accessId`, `newPermissions`) before the peer delivery, which may take up to
 * the outbound timeout. A reader polling the trigger then sees the truth while
 * delivery is still in flight, not a bare `delivered`.
 */
async function persistTriggerOutcome (
  userId: string,
  triggerEvent: ScopeUpdateParams['triggerEvent'],
  deps: ScopeUpdateDeps
): Promise<void> {
  if (triggerEvent.id == null || deps.mall.events?.update == null) return;
  try {
    await deps.mall.events.update(userId, { ...triggerEvent, content: triggerEvent.content });
  } catch (err: unknown) {
    deps.logger?.warn?.('cmc/handleSystemScopeUpdate: failed to record the outcome before delivery', {
      eventId: triggerEvent.id,
      error: String((err as Error)?.message || err),
    });
  }
}

/**
 * Handle a `consent/scope-update-cmc` trigger.
 *
 * The local grant change is APPLIED here, before the peer is notified, and
 * the trigger records it: `accessId`, `newPermissions` (the user-facing set
 * applied) and `applied: true` are written onto the trigger content, so a
 * `completed` status means the grant changed. A refusal applies nothing and
 * records `applied: false`.
 *
 * Accepted shapes are listed on `resolveScopeUpdateTarget`. The collector
 * receives the same content (plus `from`), so it learns the permission set
 * that is now in force.
 */
async function handleSystemScopeUpdate (params: ScopeUpdateParams): Promise<SystemHandlerResult> {
  if (params.triggerEvent.type !== C.ET_SYSTEM_SCOPE_UPDATE) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: params.triggerEvent.type } };
  }
  const { userId, triggerEvent, deps } = params;
  const content = triggerEvent.content ?? {};
  triggerEvent.content = content;

  const triggerStream = firstCollectorStream(triggerEvent.streamIds);
  if (triggerStream == null) {
    return { ok: false, reason: 'cmc-system-stream-not-collector', detail: { streamIds: triggerEvent.streamIds } };
  }
  const listed = await deps.mall.accesses.get(userId, {});
  const accessList: AccessLike[] = Array.isArray(listed) ? listed : [];

  // Refusal of a collector's request: bind it exactly like an acceptance,
  // apply nothing, tell the collector.
  if (content.accept === false) {
    if (typeof content.scopeRequestEventId !== 'string') {
      return { ok: false, reason: CmcErrorIds.SCOPE_UPDATE_NOTHING_TO_APPLY };
    }
    const bound = await resolveScopeRequest({ userId, triggerEvent, triggerStream, accessList, deps });
    if (!bound.ok) return bound;
    content.applied = false;
    await stampScopeRequest(userId, bound.requestEvent, 'refused', triggerEvent.id, deps);
    await persistTriggerOutcome(userId, triggerEvent, deps);
    return handleSystemEvent(params);
  }

  const target = await resolveScopeUpdateTarget({ userId, triggerEvent, triggerStream, accessList, deps });
  if (!target.ok) return target;
  const { accessId, newPermissions } = target;

  // AUTO-MERGE CMC MACHINERY: the plugin owns the `:_cmc:inbox` create-only
  // and the per-peer `:_cmc:apps:*:chats:<slug>` / `collectors:<slug>`
  // contribute permissions on each counterparty data-grant. Whoever supplies
  // the permission set (the collector's request, or the caller) states only
  // the USER-FACING part; writing it verbatim would drop the machinery perms
  // and the back-channel would go silent. We keep every `:_cmc:*` permission
  // the access currently has and overlay the non-machinery perms. `:_cmc:*`
  // entries in the supplied set are ignored (the plugin owns these).
  const userFacing = newPermissions.filter((p) => !isCmcMachinery(p));
  const acc = accessList.find((a) => a?.id === accessId);
  const machinery = Array.isArray(acc?.permissions) ? acc.permissions.filter(isCmcMachinery) : [];
  const mergedPerms = [...userFacing, ...machinery];

  // Chain check (defense in depth) — the api-server's accesses.update
  // route runs the equivalent `canUpdateAccess` + `canCreateAccess`
  // permission-subset checks in applyPrerequisitesForUpdate. The
  // mall.accesses.update path bypasses them. Personal tokens
  // short-circuit both to true; non-personal tokens are blocked by
  // cmcAcceptAccessGateHook at events.create already, so this re-check
  // closes the bypass for any path that reaches the handler without
  // the gate. Skip when triggerAccess isn't plumbed (unit-test dispatch
  // with mocked deps) — the gate is the primary guard.
  const triggerAccess = deps.triggerAccess;
  if (triggerAccess?.canUpdateAccess != null && triggerAccess?.canCreateAccess != null) {
    let canUpdate = true;
    let canGrant = true;
    try {
      canUpdate = await triggerAccess.canUpdateAccess({ id: accessId, type: 'shared' });
    } catch (_e) { canUpdate = false; }
    try {
      canGrant = await triggerAccess.canCreateAccess({ type: 'shared', permissions: mergedPerms });
    } catch (_e) { canGrant = false; }
    if (!canUpdate || !canGrant) {
      return {
        ok: false,
        reason: CmcErrorIds.INSUFFICIENT_PERMISSIONS,
        detail: {
          accessId,
          canUpdate,
          canGrant,
          message: canUpdate
            ? 'trigger-writing access cannot grant the proposed new permissions'
            : 'trigger-writing access cannot update the target counterparty access',
        },
      };
    }
  }

  // The update is wrapped in runWithSuppression so the accesses.update
  // post-hook does NOT also notify the peer: this handler is the
  // authoritative notifier for the change.
  try {
    await accessesUpdateHookMod.runWithSuppression(async () => {
      await deps.mall.accesses.update(userId, {
        id: accessId,
        update: { permissions: mergedPerms },
      });
    });
  } catch (err: unknown) {
    return {
      ok: false,
      reason: CmcErrorIds.SCOPE_UPDATE_LOCAL_APPLY_FAILED,
      detail: { accessId, message: String((err as Error)?.message || err) },
    };
  }

  // Record the outcome on the trigger BEFORE delivery: the content is both
  // what gets persisted (completed or failed) and what the collector
  // receives. A delivery failure after this point leaves a truthful
  // `applied: true` on a failed trigger; a retry re-applies the same set.
  content.accessId = accessId;
  content.newPermissions = userFacing;
  content.applied = true;
  if (target.requestEvent != null) {
    await stampScopeRequest(userId, target.requestEvent, 'accepted', triggerEvent.id, deps);
  }
  await persistTriggerOutcome(userId, triggerEvent, deps);

  const delivered = await handleSystemEvent(params);
  if (!delivered.ok) return delivered;
  return { ...delivered, accessId, newPermissions: userFacing, applied: true };
}

export {
  COLLECTOR_STREAM_ID_RE,
  SYSTEM_EVENT_TYPES,
  parseCollectorStreamId,
  deliverSystemToPeer,
  handleSystemEvent,
  handleSystemAlert,
  handleSystemAck,
  handleSystemScopeRequest,
  handleSystemScopeUpdate,
};
