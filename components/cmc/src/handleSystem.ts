/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
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
 *      acceptance time — Phase E slice 2). For now, callers may pass it
 *      explicitly via the access.
 *   4. POST `notification/alert-cmc` or `notification/ack-cmc` to the peer.
 */

const C = require('./constants.ts');
const slugMod = require('./slug.ts');
const outbound = require('./outbound.ts');
const accessesUpdateHookMod = require('./accessesUpdateHook.ts');

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

type AccessLike = {
  id: string;
  type?: string;
  clientData?: any;
};

type OutboundDeps = {
  fetch: (url: string, init?: any) => Promise<any>;
  timeoutMs?: number;
  logger?: { debug: Function; warn: Function };
};

type SystemHandlerResult =
  | {
      ok: true;
      eventType: string;
      remoteEventId?: string;
      currentCount?: number;
    }
  | {
      ok: false;
      reason: string;
      detail?: any;
    };

type DeliverSystemParams = {
  remoteApiEndpoint: string;
  remoteCollectorStreamId: string;
  eventType: string; // notification/alert-cmc or notification/ack-cmc
  payload: any;
  selfIdentity: Counterparty;
  deps: OutboundDeps;
};

/**
 * POST a system message to the counterparty's collectors stream.
 *
 * Returns outbound.postToPeer's discriminated-union result.
 */
async function deliverSystemToPeer (params: DeliverSystemParams): Promise<any> {
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
  triggerEvent: { id?: string; type: string; content: any; streamIds?: string[] };
  selfIdentity: Counterparty;
  deps: {
    mall: { accesses: { get: (userId: string, params?: any) => Promise<AccessLike[]> } };
    fetch: OutboundDeps['fetch'];
    timeoutMs?: number;
    logger?: { debug: Function; warn: Function };
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
  let chosen: AccessLike | null = null;
  for (const acc of accessesList) {
    const cmc = acc?.clientData?.cmc;
    if (cmc?.role !== 'counterparty') continue;
    const cp = cmc?.counterparty;
    if (cp == null) continue;
    if (cp.username !== parsed.counterparty.username) continue;
    // Confirm the hostSlug matches by re-slugifying the access's host.
    const accHostSlug = slugMod.slugifyHost(cp.host);
    if (accHostSlug !== parsed.counterparty.hostSlug) continue;
    if (cmc?.appCode != null && cmc.appCode !== parsed.appCode) continue;
    chosen = acc;
    break;
  }
  if (chosen == null) {
    return { ok: false, reason: 'cmc-system-counterparty-access-not-found', detail: {
      appCode: parsed.appCode,
      counterpartySlug: parsed.counterpartySlug,
    } };
  }

  const cmc = chosen.clientData?.cmc;

  // Phase 2.2 features gating — the offer's negotiated
  // `features.systemMessaging` is the relationship's binding contract.
  // When the counterparty access carries
  // `clientData.cmc.features.systemMessaging === false`, alert + ack
  // sends are rejected. Scope-request / scope-update events are NOT
  // subject to this gate — they're protocol-level (relationship
  // governance), not user-level messaging.
  const isUserMessaging = triggerEvent.type === C.ET_SYSTEM_ALERT ||
                          triggerEvent.type === C.ET_SYSTEM_ACK;
  if (isUserMessaging && cmc?.features?.systemMessaging === false) {
    return { ok: false, reason: 'cmc-system-messaging-disabled', detail: { accessId: chosen.id, eventType: triggerEvent.type } };
  }

  const remoteApiEndpoint: string | undefined = cmc?.counterparty?.apiEndpoint;
  const remoteCollectorStreamId: string | undefined = cmc?.counterparty?.remoteCollectorStreamId;
  if (typeof remoteApiEndpoint !== 'string' || remoteApiEndpoint.length === 0) {
    return { ok: false, reason: 'cmc-system-no-remote-apiendpoint', detail: { accessId: chosen.id } };
  }
  if (typeof remoteCollectorStreamId !== 'string' || remoteCollectorStreamId.length === 0) {
    return { ok: false, reason: 'cmc-system-no-remote-collector-stream', detail: { accessId: chosen.id } };
  }

  let delivery: any;
  try {
    delivery = await deliverSystemToPeer({
      remoteApiEndpoint,
      remoteCollectorStreamId,
      eventType: triggerEvent.type,
      payload: triggerEvent.content ?? {},
      selfIdentity,
      deps,
    });
  } catch (err: any) {
    return { ok: false, reason: 'cmc-handler-delivery-threw', detail: { message: String(err?.message || err) } };
  }

  if (!delivery.ok) {
    return {
      ok: false,
      reason: 'cmc-handler-delivery-failed',
      detail: { status: delivery.status, peerReason: delivery.reason },
    };
  }

  return {
    ok: true,
    eventType: triggerEvent.type,
    remoteEventId: delivery.body?.event?.id,
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
  triggerEvent: { id?: string; type: string; content: any; streamIds?: string[] };
  selfIdentity: Counterparty;
  deps: any;
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
  triggerEvent: { id?: string; type: string; content: any; streamIds?: string[] };
  selfIdentity: Counterparty;
  deps: any;
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
  triggerEvent: { id?: string; type: string; content: any; streamIds?: string[] };
  selfIdentity: Counterparty;
  deps: any;
}): Promise<SystemHandlerResult> {
  if (params.triggerEvent.type !== C.ET_SYSTEM_SCOPE_REQUEST) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: params.triggerEvent.type } };
  }
  return handleSystemEvent(params);
}

/**
 * Handle a `consent/scope-update-cmc` trigger.
 *
 * Issued AFTER the local accesses.update post-hook fires (Phase G slice 3)
 * to inform the peer that an access they hold has had its permissions
 * adjusted. Content typically carries:
 *   - the new permissions
 *   - the new compositeId/version (composite-id access versioning)
 *   - optional reason / human-readable message
 *
 * The peer uses this to know their existing data-grant has new scope
 * AND to reconcile the composite-id chain if they cached the previous
 * version.
 */
async function handleSystemScopeUpdate (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: any; streamIds?: string[] };
  selfIdentity: Counterparty;
  deps: any;
}): Promise<SystemHandlerResult> {
  if (params.triggerEvent.type !== C.ET_SYSTEM_SCOPE_UPDATE) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: params.triggerEvent.type } };
  }

  // Local-apply branch: when the trigger carries an accessId + newPermissions,
  // apply the change to the local data-grant access BEFORE delivering the
  // notification to the peer. The accesses.update is wrapped in
  // runWithSuppression so the post-hook does NOT also fire — this handler
  // is the authoritative notifier for the change.
  //
  // AUTO-MERGE CMC MACHINERY: the plugin owns the `:_cmc:inbox` create-only
  // and the per-peer `:_cmc:apps:*:chats:<slug>` / `collectors:<slug>`
  // contribute permissions on each counterparty data-grant. The caller
  // writing `consent/scope-update-cmc` typically passes only the
  // USER-FACING perm set; if we wrote `newPermissions` verbatim, the
  // machinery perms would be dropped and the back-channel would go silent.
  // We preserve them by reading the access's current permissions, keeping
  // every `:_cmc:*`-stream permission as-is, and overlaying the caller's
  // non-machinery perms on top. Callers CAN include CMC perms explicitly
  // — they're filtered out and replaced with whatever the access actually
  // has (the plugin owns these; user input is informational only).
  const accessId: string | undefined = params.triggerEvent.content?.accessId;
  const newPermissions: any = params.triggerEvent.content?.newPermissions;
  if (typeof accessId === 'string' && Array.isArray(newPermissions) &&
      params.deps?.mall?.accesses?.update != null) {
    try {
      let mergedPerms = newPermissions;
      if (params.deps?.mall?.accesses?.get != null) {
        const accessList = await params.deps.mall.accesses.get(params.userId, {});
        const acc = Array.isArray(accessList)
          ? accessList.find((a: any) => a?.id === accessId)
          : null;
        if (acc != null && Array.isArray(acc.permissions)) {
          const isCmcMachinery = (p: any) =>
            typeof p?.streamId === 'string' && p.streamId.startsWith(':_cmc:');
          const machinery = acc.permissions.filter(isCmcMachinery);
          const userFacing = newPermissions.filter((p: any) => !isCmcMachinery(p));
          mergedPerms = [...userFacing, ...machinery];
        }
      }
      await accessesUpdateHookMod.runWithSuppression(async () => {
        await params.deps.mall.accesses.update(params.userId, {
          id: accessId,
          update: { permissions: mergedPerms },
        });
      });
    } catch (err: any) {
      return {
        ok: false,
        reason: 'cmc-scope-update-local-apply-failed',
        detail: { accessId, message: String(err?.message || err) },
      };
    }
  }

  return handleSystemEvent(params);
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
