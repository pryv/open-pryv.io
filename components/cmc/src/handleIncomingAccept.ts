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
 * CMC plugin — requester-side incoming `consent/accept-cmc` handler.
 *
 * When the accepter posts a `consent/accept-cmc` event back to the requester's
 * platform via the capability URL, the event lands on the requester's
 * `:_cmc:inbox` (after going through inboxWriteHook's counterparty
 * validation + content.from stamping). The requester needs to provision
 * the BACK-CHANNEL access — i.e. mint an access on their own account
 * scoped to the accepter's CMC namespace so future chat / system
 * deliveries from the requester to the accepter have an authoritated
 * apiEndpoint to POST to.
 *
 * Flow:
 *   1. Extract content.grantedAccess.apiEndpoint (the accepter's
 *      data-grant URL — that's where the requester's app can READ the
 *      accepted permissions).
 *   2. Extract content.from (server-stamped by inboxWriteHook —
 *      {username, host} of the accepter).
 *   3. Read the original request event from one of the requester's
 *      `:_cmc:apps:<app>:[<path>:]` streams to find the appCode + scope.
 *   4. Create the back-channel access:
 *      - permissions: create on `:_cmc:inbox` + rights on the chats
 *        and collectors streams under the app scope.
 *      - clientData.cmc = {role:'counterparty', appCode, counterparty:
 *        {username, host, apiEndpoint, remoteChatStreamId,
 *        remoteCollectorStreamId}}
 *      - The remote stream-ids are computed deterministically from our
 *        identity (the accepter mirrors the structure on their side).
 *   5. Auto-create the anchor streams on this side:
 *      - :_cmc:apps:<app>:[<path>:]chats
 *      - :_cmc:apps:<app>:[<path>:]chats:<accepter-slug>
 *      - :_cmc:apps:<app>:[<path>:]collectors
 *      - :_cmc:apps:<app>:[<path>:]collectors:<accepter-slug>
 *
 * Returns { ok, accessId, anchorStreamIds } on success, or
 * { ok:false, reason, detail } on failure (so the caller can log /
 * surface to operator audit; the inbox write-hook itself never reverts
 * the inbox event — the audit record is the durable proof).
 */

const C = require('./constants.ts');
const slugMod = require('./slug.ts');
const anchors = require('./anchorStreams.ts');
const capabilityMod = require('./capability.ts');

type Counterparty = { username: string; host: string };

type AccessLike = {
  id: string;
  name?: string;
  apiEndpoint?: string;
  permissions?: Array<Record<string, unknown>>;
  clientData?: Record<string, unknown>;
  [k: string]: unknown;
};

type IncomingAcceptResult =
  | {
      ok: true;
      backChannelAccessId: string;
      backChannelApiEndpoint?: string;
      anchorStreamIds: string[];
      appCode: string;
      counterparty: Counterparty;
    }
  | {
      ok: false;
      reason: string;
      detail?: unknown;
    };

type MallLike = {
  accesses: {
    create: (userId: string, params: unknown) => Promise<AccessLike>;
    update?: (userId: string, params: unknown) => Promise<AccessLike | null | undefined>;
    get?: (userId: string, params?: unknown) => Promise<unknown[]>;
  };
  events: {
    get: (userId: string, params?: unknown) => Promise<unknown[]>;
    create: (userId: string, params: unknown) => Promise<unknown>;
    update?: (userId: string, params: unknown) => Promise<unknown>;
  };
  streams: { create: (userId: string, params: unknown) => Promise<unknown> };
};

type SelfIdentity = { username: string; host: string };

/**
 * Process an incoming `consent/accept-cmc` event after it has been persisted
 * in the requester's :_cmc:inbox. Provisions the back-channel access +
 * anchor streams.
 *
 * On stream-create failures: we ignore "stream-already-exists" (idempotent —
 * a re-delivery of the same accept just rebuilds the same anchors). Other
 * stream-create errors fail the handler so an operator can investigate.
 */
async function handleIncomingAccept (params: {
  userId: string;
  acceptEvent: { id?: string; type: string; content: Record<string, unknown>; streamIds?: string[] };
  selfIdentity: SelfIdentity;
  deps: {
    mall: MallLike;
    logger?: CmcLogger;
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
  };
}): Promise<IncomingAcceptResult> {
  const { userId, acceptEvent, selfIdentity, deps } = params;
  const { mall } = deps;

  if (acceptEvent.type !== C.ET_ACCEPT) {
    return { ok: false, reason: 'cmc-incoming-accept-wrong-type', detail: { type: acceptEvent.type } };
  }

  const grantedApiEndpoint = (acceptEvent.content?.grantedAccess as { apiEndpoint?: string } | undefined)?.apiEndpoint;
  if (typeof grantedApiEndpoint !== 'string' || grantedApiEndpoint.length === 0) {
    return { ok: false, reason: 'cmc-incoming-accept-no-granted-apiendpoint' };
  }

  const cp = acceptEvent.content?.from as { username?: string; host?: string } | undefined;
  if (cp == null || typeof cp.username !== 'string' || typeof cp.host !== 'string') {
    return { ok: false, reason: 'cmc-incoming-accept-from-missing' };
  }
  const counterparty: Counterparty = { username: cp.username, host: cp.host };

  // The accepter's accept references the original request via either
  // content.capabilityId or content.requestEventId. We use the request
  // event to recover the appCode + the scope stream-id under which to
  // anchor the chat/collectors streams.
  let scopeStreamId: string | null = null;
  let appCode: string | null = null;
  // Priority order (most authoritative first):
  //   1. acceptEvent.content.requesterAppCode — set by the accepter's
  //      handleAccept from offer.requesterMeta.appId. Reliable because
  //      the accepter read the offer and stamped this on the delivery.
  //   2. resolveRequestScope — looks up the original request event by
  //      id in the requester's own store. May fail if the original
  //      event was pruned or never had an id we can match.
  //   3. Fall back to 'unknown' — back-channel access still gets
  //      created; chat/system handlers won't match it but the
  //      handshake itself is recorded.
  const fromAcceptContent = acceptEvent.content?.requesterAppCode;
  const originStreamFromAccept = acceptEvent.content?.requesterOriginStreamId;
  if (typeof originStreamFromAccept === 'string' && originStreamFromAccept.length > 0 &&
      originStreamFromAccept.startsWith(C.NS_APPS + ':')) {
    // Most authoritative: the accepter passed back the requester's
    // per-request streamId (e.g. :_cmc:apps:my-app:study-1). Anchors
    // land exactly here, so chat/system triggers in the same scope
    // resolve cleanly.
    scopeStreamId = originStreamFromAccept;
    appCode = C.getAppCode(originStreamFromAccept) ?? null;
  }
  if (scopeStreamId == null && typeof fromAcceptContent === 'string' && fromAcceptContent.length > 0) {
    appCode = fromAcceptContent;
    scopeStreamId = C.NS_APPS + ':' + appCode;
  }
  if (scopeStreamId == null) {
    try {
      const lookup = await resolveRequestScope({ userId, acceptEvent, mall });
      scopeStreamId = lookup.scopeStreamId;
      appCode = lookup.appCode;
    } catch (err: unknown) {
      return { ok: false, reason: 'cmc-incoming-accept-scope-lookup-failed', detail: { message: String((err as Error)?.message || err) } };
    }
    if (scopeStreamId == null || appCode == null) {
      appCode = 'unknown';
      scopeStreamId = C.NS_APPS + ':' + appCode;
    }
  }

  // Compute the relevant slugs + stream-ids. The peer's stream-ids
  // mirror the structure on their account (both sides derive from
  // app-scope + counterparty slug — deterministic).
  const peerSlug = slugMod.counterpartySlug({ username: counterparty.username, host: counterparty.host });
  const selfSlug = slugMod.counterpartySlug({ username: selfIdentity.username, host: selfIdentity.host });
  const chatStream = C.chatStreamUnder(scopeStreamId, peerSlug);
  const collectorStream = C.collectorStreamUnder(scopeStreamId, peerSlug);
  const remoteChatStreamId = C.chatStreamUnder(scopeStreamId, selfSlug);
  const remoteCollectorStreamId = C.collectorStreamUnder(scopeStreamId, selfSlug);

  // Provision the four anchor streams. Idempotent.
  const provisioned = await anchors.provisionAnchorStreams({
    userId,
    scopeStreamId,
    peerSlug,
    mall,
  });
  if (!provisioned.ok) {
    return {
      ok: false,
      reason: 'cmc-incoming-accept-anchor-stream-create-failed',
      detail: { streamId: provisioned.failedStreamId, message: provisioned.failureMessage },
    };
  }
  const created = provisioned.created;

  // Mint the back-channel access. Permissions:
  //   - create-only on :_cmc:inbox (so the peer can deliver to us)
  //   - read/contribute on chats + collectors anchor streams (so the
  //     peer can deliver chat + system messages targeted to our slug)
  //
  // Name disambiguator: appCode + peerSlug (separated by `--`) so two
  // distinct apps with the same counterparty don't collide. If a stale
  // access with the same name exists (e.g. from a re-delivery or a
  // previous run that minted under different scope rules), update it
  // in-place rather than failing the whole handshake — re-delivery is a
  // legitimate retry path and the access's clientData + permissions
  // must reflect the LATEST acceptance.
  const accessName = 'cmc-back-channel-' + appCode + '--' + peerSlug;
  // Phase 2.2 features gating — features negotiated by the offer
  // (and accepted by the counterparty) are delivered on
  // `acceptEvent.content.features`. Mirror them onto the
  // back-channel access's clientData so handleChat / handleSystem on
  // the REQUESTER side can enforce the contract symmetrically with
  // the accepter side (whose data-grant access carries the same
  // field via buildDataGrantPayload). Absent / null → permissive.
  const negotiatedFeatures: Record<string, unknown> | null = ((acceptEvent?.content as { features?: Record<string, unknown> | null } | undefined)?.features ?? null) as Record<string, unknown> | null;
  const accessParams = {
    type: 'shared',
    name: accessName,
    permissions: [
      { streamId: C.NS_INBOX, level: 'create-only' },
      { streamId: chatStream, level: 'contribute' },
      { streamId: collectorStream, level: 'contribute' },
    ],
    clientData: {
      cmc: {
        role: 'counterparty',
        appCode,
        features: negotiatedFeatures,
        counterparty: {
          username: counterparty.username,
          host: counterparty.host,
          apiEndpoint: grantedApiEndpoint,
          remoteChatStreamId,
          remoteCollectorStreamId,
        },
      },
    },
  };
  let access: AccessLike;
  try {
    access = await mall.accesses.create(userId, accessParams);
  } catch (err: unknown) {
    // Duplicate name (re-delivery / re-run) — look up the existing access
    // and update its clientData + permissions to reflect the latest
    // handshake state. This makes re-delivery idempotent and lets us heal
    // accesses that were minted under earlier (buggy) scope rules.
    const msg = String((err as Error)?.message || err);
    const isDuplicate = (err as { id?: string })?.id === 'item-already-exists' ||
      (err as { id?: string })?.id === 'duplicate-key' ||
      /duplicate key|already exists|item-already-exists/i.test(msg);
    if (!isDuplicate) {
      return {
        ok: false,
        reason: 'cmc-incoming-accept-back-channel-create-failed',
        detail: { message: msg },
      };
    }
    const existing = await findAccessByName({ mall, userId, name: accessName });
    if (existing == null) {
      return {
        ok: false,
        reason: 'cmc-incoming-accept-back-channel-duplicate-but-not-found',
        detail: { name: accessName },
      };
    }
    if (typeof mall.accesses.update === 'function') {
      try {
        const updated = await mall.accesses.update(userId, {
          id: existing.id,
          update: {
            permissions: accessParams.permissions,
            clientData: accessParams.clientData,
          },
        });
        access = updated ?? existing;
      } catch (uerr: unknown) {
        // Partial healing — at least surface the existing access id so the
        // chat/system handlers can still find it; permissions might be
        // stale but the resolver matches on (appCode, counterparty) which
        // we just refreshed in-memory below if update succeeded.
        deps.logger?.warn?.('cmc/handleIncomingAccept: existing back-channel access update failed', {
          accessId: existing.id,
          error: String((uerr as Error)?.message || uerr),
        });
        access = existing;
      }
    } else {
      access = existing;
    }
  }

  // Look up the local capability access once for the inbox-mirror
  // enrichment + the state-flip block below. The accepter's plugin only
  // knows `capabilityId` from the URL/cap-id; only the requester (here)
  // can read `clientData.cmc.requestEventId` (which is the original
  // invite trigger event id from `consent/request-cmc` — the one the
  // doctor's app uses with `cmc.revokeRelationship({inviteEventId})`).
  const capabilityIdToConsume = acceptEvent?.content?.capabilityId;
  let capabilityAccess: { id?: string; token?: string; [k: string]: unknown } | null = null;
  if (typeof capabilityIdToConsume === 'string' && capabilityIdToConsume.length > 0) {
    try {
      capabilityAccess = await capabilityMod.findCapabilityAccess({
        userId, capabilityId: capabilityIdToConsume, deps: { mall },
      });
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/handleIncomingAccept: capability access lookup failed (non-fatal)', {
        capabilityId: capabilityIdToConsume,
        error: String((err as Error)?.message || err),
      });
    }
  }
  const inviteEventId: string | null =
    ((capabilityAccess?.clientData as { cmc?: { requestEventId?: string } } | undefined)?.cmc?.requestEventId ?? null) as string | null;

  // Mirror the accept to :_cmc:inbox so the requester's app sees it via
  // standard inbox subscription (per INTERNALS.md flow 3 step 11). The
  // accept event itself lives in :_cmc:_internal:responses:<capId>; the
  // mirror is a copy on :_cmc:inbox that carries the same content
  // (grantedAccess.apiEndpoint + from + features). Best-effort — the
  // back-channel access is already created so the app can be notified
  // separately even if this mirror fails (e.g. inbox stream not yet
  // provisioned and lazy-provision didn't run on this code path).
  if (acceptEvent.streamIds?.includes(C.NS_INBOX) !== true && deps.mall.events != null) {
    try {
      // Augment the mirror's content with handles the doctor's app can
      // only discover via the requester side:
      //   - `backChannelAccessId` — the data-grant id we just minted
      //     locally. Power-user revoke path
      //     (`cmc.revokeRelationship({accessId, scopeStreamId})`)
      //     needs this.
      //   - `inviteEventId` — the original `consent/request-cmc`
      //     trigger event id, read from the capability access's
      //     `clientData.cmc.requestEventId`. Convenience revoke path
      //     (`cmc.revokeRelationship({inviteEventId})`) matches against
      //     this on the inbox event.
      const mirrorContent: Record<string, unknown> = {
        ...(acceptEvent.content || {}),
        backChannelAccessId: access.id,
      };
      if (inviteEventId != null) mirrorContent.inviteEventId = inviteEventId;
      await deps.mall.events.create(userId, {
        streamIds: [C.NS_INBOX],
        type: C.ET_ACCEPT,
        time: Date.now() / 1000,
        content: mirrorContent,
      });
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/handleIncomingAccept: inbox mirror failed (non-fatal)', {
        error: String((err as Error)?.message || err),
      });
    }
  }

  // Deliver back-channel info to the peer (accepter). The peer's
  // data-grant access carries `:_cmc:inbox` create-only specifically
  // for this — we POST a `consent/back-channel-cmc` event there containing
  // our back-channel apiEndpoint + remote stream-ids. The peer's
  // dispatch routes it to handleIncomingBackChannel, which updates the
  // data-grant access's clientData.cmc.counterparty so the peer's chat
  // / system handlers can find an apiEndpoint to POST to when sending
  // back to us. Best-effort — if delivery fails, the peer can't send
  // chat/system to us, but the data-grant for read access is intact and
  // the operator can retry.
  if (typeof deps.fetch === 'function' && access.apiEndpoint != null) {
    const outbound = require('./outbound.ts');
    try {
      await outbound.postToPeer({
        apiEndpoint: grantedApiEndpoint,
        path: 'events',
        body: {
          streamIds: [C.NS_INBOX],
          type: C.ET_BACK_CHANNEL,
          content: {
            from: { username: selfIdentity.username, host: selfIdentity.host },
            apiEndpoint: access.apiEndpoint,
            remoteChatStreamId: chatStream,
            remoteCollectorStreamId: collectorStream,
            appCode,
          },
        },
        deps: { fetch: deps.fetch, timeoutMs: deps.timeoutMs, logger: deps.logger },
      });
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/handleIncomingAccept: back-channel info delivery failed (non-fatal)', {
        peerApiEndpoint: grantedApiEndpoint,
        error: String((err as Error)?.message || err),
      });
    }
  }

  // Phase 1 single-use lifecycle: flip the capability access's
  // `clientData.cmc.capability.state` from 'open' to 'consumed' so a
  // subsequent re-click via the same capabilityUrl can be rejected
  // with `cmc-capability-consumed` by the responses-stream write-hook
  // (instead of silently re-running this handler and minting a
  // duplicate back-channel access). Open-link mode skips this step —
  // capabilities with `mode: 'open-link'` keep state='open' until
  // explicit invalidation (Phase 2 plan). Best-effort; the back-channel
  // access is already minted so the relationship is established.
  //
  // `capabilityIdToConsume` and `capabilityAccess` were resolved above
  // (for the inbox-mirror enrichment). Reuse to avoid a second lookup.
  if (typeof capabilityIdToConsume === 'string' && capabilityIdToConsume.length > 0) {
    try {
      const capabilityMode = (capabilityAccess?.clientData as { cmc?: { capability?: { mode?: string } } } | undefined)?.cmc?.capability?.mode;
      if (capabilityMode === 'single-use' || capabilityMode == null) {
        // Default 'single-use' for legacy capabilities minted before
        // this field existed.
        await capabilityMod.markCapabilityConsumed({
          userId, capabilityId: capabilityIdToConsume, deps: { mall },
        });
      } else if (capabilityMode === 'open-link') {
        // Open-link mode (Phase 2 lifecycle): instead of flipping state
        // to 'consumed', append the accepter to acceptedBy so a
        // same-patient re-click can be detected by the response-stream
        // write-hook. The capability stays open until the requester
        // explicitly invalidates the link via `consent/invalidate-link-cmc`.
        await capabilityMod.recordAccepter({
          userId,
          capabilityId: capabilityIdToConsume,
          accepter: counterparty,
          deps: { mall },
        });
      }
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/handleIncomingAccept: capability state-flip failed (non-fatal)', {
        capabilityId: capabilityIdToConsume,
        error: String((err as Error)?.message || err),
      });
    }
  }

  return {
    ok: true,
    backChannelAccessId: access.id,
    backChannelApiEndpoint: access.apiEndpoint,
    anchorStreamIds: created,
    // appCode is guaranteed non-null by the scope-resolution branches
    // above (the fallback sets it to 'unknown'), but TS narrowing
    // doesn't carry through the multiple if-chains. Coerce to string.
    appCode: appCode as string,
    counterparty,
  };
}

/**
 * Best-effort lookup of the original request event's scope. The accept
 * event carries either `originalEventId` or `capabilityId`; we use it
 * to find the request event in our streams and return the streamId
 * + appCode it was written under. Returns nulls if we can't resolve
 * (caller falls back to a synthetic scope).
 */
async function resolveRequestScope (params: {
  userId: string;
  acceptEvent: { id?: string; type?: string; content?: Record<string, unknown>; streamIds?: string[]; [k: string]: unknown };
  mall: MallLike;
}): Promise<{ scopeStreamId: string | null; appCode: string | null }> {
  const { userId, acceptEvent, mall } = params;
  const reqId = acceptEvent.content?.originalEventId ?? acceptEvent.content?.requestEventId;
  if (typeof reqId !== 'string' || reqId.length === 0) {
    return { scopeStreamId: null, appCode: null };
  }
  try {
    const events = await mall.events.get(userId, { id: reqId, limit: 1 });
    const ev = events?.[0] as { streamIds?: string[] } | undefined;
    const reqStreamIds: string[] = Array.isArray(ev?.streamIds) ? ev.streamIds : [];
    for (const sid of reqStreamIds) {
      const appCode = C.getAppCode(sid);
      if (appCode != null) {
        return { scopeStreamId: sid, appCode };
      }
    }
  } catch (_e) {
    // Lookup failure → fall back.
  }
  return { scopeStreamId: null, appCode: null };
}

/**
 * Look up an access by its `name` field. Returns null if not found or if
 * the mall doesn't expose an accesses.get method.
 */
async function findAccessByName (params: {
  mall: MallLike;
  userId: string;
  name: string;
}): Promise<AccessLike | null> {
  const { mall, userId, name } = params;
  if (typeof mall.accesses.get !== 'function') return null;
  try {
    const list = await mall.accesses.get(userId, {});
    const arr = (Array.isArray(list) ? list : ((list as { accesses?: unknown[] })?.accesses ?? [])) as AccessLike[];
    for (const a of arr) {
      if (a?.name === name) return a;
    }
  } catch (_e) {
    return null;
  }
  return null;
}

export {
  handleIncomingAccept,
  resolveRequestScope,
  findAccessByName,
};
