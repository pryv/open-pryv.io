/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — capability access mint + GC.
 *
 * When a `consent/request-cmc` is written with `capabilityRequested: true`, the
 * plugin creates a `shared` access scoped to two real per-capability
 * streams under `:_cmc:_internal:`:
 *
 *   :_cmc:_internal:offer:<capId>     read   — bears the request event
 *   :_cmc:_internal:responses:<capId> create-only — accepts one accept/refuse
 *
 * The access's apiEndpoint becomes the capability URL. Single-use; the
 * plugin GCs the access + both streams together on first response or TTL
 * expiry.
 *
 * Pure orchestration module: takes mall + id-gen + clock via deps so tests
 * can inject fakes. Issues no HTTP calls — that's the job of outbound.ts.
 */

const C = require('./constants.ts');
const slug = require('./slug.ts');

type AccessRow = { id: string; token?: string; apiEndpoint?: string; clientData?: { cmc?: any }; [k: string]: unknown };
type MallParams = Record<string, unknown>;
type MallLike = {
  streams: { create: (userId: string, params: MallParams) => Promise<unknown>; delete?: (userId: string, params: MallParams) => Promise<unknown> };
  events:  { create: (userId: string, params: MallParams) => Promise<unknown> };
  accesses:{ create: (userId: string, params: MallParams) => Promise<AccessRow>;
             update?: (userId: string, params: MallParams) => Promise<AccessRow>;
             get?:    (userId: string, params?: MallParams) => Promise<AccessRow[]>;
             delete?: (userId: string, params: MallParams) => Promise<unknown> };
};

/**
 * Capability semantics chosen at mint time.
 *
 *   'single-use' — one accept/refuse closes the link. Re-clicks return
 *                  `cmc-capability-consumed` (state-flip detected by the
 *                  responses-stream write-hook). This is the default.
 *
 *   'open-link'  — multiple accepts allowed until the requester
 *                  explicitly invalidates the link (Phase 2 plan;
 *                  open-link writes do NOT transition state to
 *                  'consumed' on accept; invalidation transitions to
 *                  'invalidated'). Use case: a doctor publishing a
 *                  multi-patient study invite.
 *
 * Already-established relationships (data-grants + back-channels)
 * are UNTOUCHED by capability state changes — only the join channel
 * is affected. Per-relationship revocation uses `consent/revoke-cmc`.
 */
type CapabilityMode = 'single-use' | 'open-link';
type CapabilityState = 'open' | 'consumed' | 'invalidated';

type MintDeps = {
  mall: MallLike;
  idGen?: () => string;
  now?: () => number;       // unix seconds
  serviceUrlBase?: string;  // for synthesizing apiEndpoint when access.apiEndpoint isn't set
};

type RequestEventLike = {
  id?: string;
  type: string;       // 'consent/request-cmc'
  content: Record<string, unknown> & { capability?: { mode?: string } };
  streamIds?: string[];
};

type MintResult = {
  capabilityId: string;
  offerStreamId: string;
  responsesStreamId: string;
  capabilityUrl: string;
  expiresAt: number;
  accessId: string;
};

/**
 * Default capability TTL: 7 days (to be aligned with future OAuth2 token
 * TTL in a follow-up).
 */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Bounds for caller-supplied per-invite TTLs (via
 * `consent/request-cmc` `content.request.expiresAt` — the absolute
 * unix-seconds timestamp at which the capability access should expire).
 * Out-of-range values are rejected at mint time by the
 * `capabilityMintHook` with `cmc-capability-ttl-out-of-range`. The
 * `DEFAULT_TTL_SECONDS` continues to apply when no `expiresAt` is
 * provided.
 */
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

function defaultIdGen (): string {
  // Short, URL-safe id generator. Production callers should pass a real
  // CSRPNG-backed id-gen (cuid / nanoid / etc.) via deps.idGen.
  return Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14);
}

function defaultNow (): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Mint a capability access for the given `consent/request-cmc` trigger.
 *
 * Side effects (all via deps.mall):
 *   1. streams.create offer + responses streams under :_cmc:_internal:
 *   2. events.create the request event into the offer stream (read-side payload)
 *   3. accesses.create a shared access with read/create-only on the two streams
 *
 * Returns the new capability handles. The caller updates the original
 * trigger event's content with capabilityUrl + capabilityExpiresAt.
 *
 * NOTE: this function does NOT update the trigger event itself — that's
 * the orchestration loop's job (so the loop can update status alongside).
 */
async function mintCapability (params: {
  userId: string;
  triggerEvent: RequestEventLike;
  ttlSeconds?: number;
  // Capability mode (default 'single-use' for back-compat). Read from
  // `triggerEvent.content.capability.mode` when present; explicit
  // `params.mode` wins. See type doc above.
  mode?: CapabilityMode;
  deps: MintDeps;
  // Optional: when present, the requester's CANONICAL identity is
  // stamped on the offer event content (`requesterUsername`,
  // `requesterHost`). The accepter's handleAccept prefers these over
  // the capability URL's hostname, which in subdomain-style
  // deployments (e.g. https://<username>.pryv.me/) bakes the username
  // into the host and gives a different slug on each side. Pass the
  // selfIdentity result here when wiring the hook.
  requesterIdentity?: { username: string; host: string };
}): Promise<MintResult> {
  const { userId, triggerEvent, deps } = params;
  const requesterIdentity = params.requesterIdentity;
  const ttlSeconds = params.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const triggerCapability = triggerEvent?.content?.capability ?? {};
  const mode: CapabilityMode = (params.mode ??
    (triggerCapability.mode === 'open-link' ? 'open-link' : 'single-use'));
  const idGen = deps.idGen ?? defaultIdGen;
  const now = deps.now ?? defaultNow;

  if (triggerEvent == null || typeof triggerEvent.type !== 'string') {
    throw new Error('cmc/capability: triggerEvent must carry a type');
  }
  if (triggerEvent.type !== C.ET_REQUEST) {
    throw new Error(
      'cmc/capability: triggerEvent.type must be ' + C.ET_REQUEST + ', got ' + triggerEvent.type
    );
  }

  const capabilityId = idGen();
  const expiresAt = now() + ttlSeconds;
  const offerStreamId = C.offerStreamIdFor(capabilityId);
  const responsesStreamId = C.responsesStreamIdFor(capabilityId);

  // 1. Per-capability streams (under :_cmc:_internal:).
  await deps.mall.streams.create(userId, {
    id: offerStreamId,
    parentId: C.NS_INTERNAL,
    name: 'CMC capability offer ' + capabilityId,
    clientData: { cmc: { kind: 'capability-offer', capabilityId } },
  });
  await deps.mall.streams.create(userId, {
    id: responsesStreamId,
    parentId: C.NS_INTERNAL,
    name: 'CMC capability responses ' + capabilityId,
    clientData: { cmc: { kind: 'capability-responses', capabilityId } },
  });

  // 2. Pre-populate the offer stream with the request event so the
  // recipient can read it via the capability connection.
  // We strip fields the recipient shouldn't see (capabilityRequested
  // is the requester's intent flag, not part of the offer).
  // We STAMP capabilityId on the offer so the accepter can recover
  // it for the responses-stream-id computation — without this, the
  // accepter has the capabilityUrl (which carries only the token) but
  // not the capId, and can't build :_cmc:_internal:responses:<capId>
  // to POST the accept response into.
  const offerContent: Record<string, unknown> = { ...(triggerEvent.content || {}) };
  delete offerContent.capabilityRequested;
  delete offerContent.capabilityUrl;
  delete offerContent.capabilityExpiresAt;
  delete offerContent.capabilityAccessId;
  delete offerContent.status;
  delete offerContent.failure;
  offerContent.capabilityId = capabilityId;
  // Stamp the requester's app-scope stream-id so the accepter can pass
  // it back in the consent/accept-cmc delivery — preserving per-request
  // scoping (e.g. :_cmc:apps:my-app:study-1 vs bare :_cmc:apps:my-app).
  // Without this, handleIncomingAccept on the requester side falls back
  // to bare :_cmc:apps:<app-code> and chat/system handlers that target
  // a per-request scope can't find the back-channel access.
  const triggerStreamIds: string[] = Array.isArray(triggerEvent.streamIds) ? triggerEvent.streamIds : [];
  for (const sid of triggerStreamIds) {
    if (typeof sid === 'string' && sid.startsWith(C.NS_APPS + ':')) {
      offerContent.originStreamId = sid;
      break;
    }
  }
  // Stamp canonical requester identity (when supplied by the caller).
  // The accepter's handleAccept prefers requesterHost over the
  // capability URL hostname — see inferCounterparty.
  if (requesterIdentity != null) {
    if (typeof requesterIdentity.username === 'string' && requesterIdentity.username.length > 0) {
      offerContent.requesterUsername = requesterIdentity.username;
    }
    if (typeof requesterIdentity.host === 'string' && requesterIdentity.host.length > 0) {
      offerContent.requesterHost = requesterIdentity.host;
    }
  }

  await deps.mall.events.create(userId, {
    streamIds: [offerStreamId],
    type: C.ET_REQUEST,
    time: now(),
    content: offerContent,
  });

  // 3. The capability access — shared, single-use, TTL-bounded.
  const access = await deps.mall.accesses.create(userId, {
    type: 'shared',
    name: '__cmc-cap-' + capabilityId.substring(0, 8),
    permissions: [
      { streamId: offerStreamId, level: 'read' },
      { streamId: responsesStreamId, level: 'create-only' },
    ],
    clientData: {
      cmc: {
        kind: 'capability',
        capabilityId,
        requestEventId: triggerEvent.id ?? null,
        // Phase 1 lifecycle: a two-state machine on the access itself.
        // `state` is 'open' at mint, flips to 'consumed' on the first
        // successful accept (single-use mode only). Open-link mode
        // stays 'open' until explicit invalidation (Phase 2).
        capability: {
          mode,
          state: 'open',
          stateChangedAt: now(),
        },
        // Legacy advisory flag — kept for back-compat with anything
        // that may have grepped for it.
        singleUse: mode === 'single-use',
      },
    },
    expires: expiresAt,
  });

  const capabilityUrl =
    access.apiEndpoint ??
    (deps.serviceUrlBase != null
      ? buildApiEndpoint(deps.serviceUrlBase, access.token!)
      : null);
  if (capabilityUrl == null) {
    throw new Error(
      'cmc/capability: minted access has no apiEndpoint and no serviceUrlBase fallback was provided'
    );
  }

  return {
    capabilityId,
    offerStreamId,
    responsesStreamId,
    capabilityUrl,
    expiresAt,
    accessId: access.id,
  };
}

/**
 * Plugin GC for a consumed or expired capability — deletes the access
 * AND the two per-capability streams. Idempotent: tolerates "not found"
 * on either delete so re-running on an already-cleaned capability is safe.
 */
async function gcCapability (params: {
  userId: string;
  capabilityId: string;
  accessId: string;
  deps: { mall: MallLike };
}): Promise<void> {
  const { userId, capabilityId, accessId, deps } = params;
  const offerStreamId = C.offerStreamIdFor(capabilityId);
  const responsesStreamId = C.responsesStreamIdFor(capabilityId);

  // Delete access first so no further responses can be written.
  if (deps.mall.accesses.delete != null) {
    await ignoreNotFound(deps.mall.accesses.delete(userId, { id: accessId }));
  }
  await ignoreNotFound(deleteStream(deps.mall, userId, offerStreamId));
  await ignoreNotFound(deleteStream(deps.mall, userId, responsesStreamId));
}

/**
 * Update a capability access's `clientData.cmc.requestEventId` after
 * the trigger event has been persisted (and its id assigned by the
 * mall). The mint hook runs as middleware BEFORE `createEvent`, so
 * `triggerEvent.id` is null at mint time and the capability access
 * was minted with `requestEventId: null`. This post-create helper
 * stamps the now-known id so downstream consumers
 * (`handleIncomingAccept` reading `clientData.cmc.requestEventId` to
 * stamp `inviteEventId` on the inbox-mirror — see Phase 1.1) can
 * resolve the original invite trigger event.
 *
 * Idempotent: if the access already has `requestEventId === id`,
 * returns `{ok:true}` without writing.
 */
async function setRequestEventIdOnAccess (params: {
  userId: string;
  accessId: string;
  requestEventId: string;
  deps: { mall: MallLike };
}): Promise<{ ok: boolean; reason?: string }> {
  const { userId, accessId, requestEventId, deps } = params;
  if (deps.mall.accesses?.get == null || deps.mall.accesses?.update == null) {
    return { ok: false, reason: 'mall-accesses-get-or-update-unavailable' };
  }
  // The mint hook minted by id; we have it directly — but the access
  // shape we need to preserve is unknown without a read. accesses.update
  // top-level merge replaces `clientData` whole-sale, so we read first.
  const list = await deps.mall.accesses.get(userId, {});
  const acc = (list || []).find((a: AccessRow) => a?.id === accessId) ?? null;
  if (acc == null) return { ok: false, reason: 'capability-access-not-found' };
  const cmcCd = acc.clientData?.cmc;
  if (cmcCd?.requestEventId === requestEventId) {
    return { ok: true }; // idempotent
  }
  await deps.mall.accesses.update(userId, {
    id: accessId,
    update: {
      clientData: {
        ...(acc.clientData || {}),
        cmc: {
          ...(cmcCd || {}),
          requestEventId,
        },
      },
    },
  });
  return { ok: true };
}

/**
 * Find the capability access for a given capabilityId. Used by the
 * responses-stream write-hook to read the access's state before
 * letting an accept/refuse pass through.
 *
 * Returns null if no matching access exists (the rare case where the
 * stream-id was forged or the access was deleted out-of-band).
 */
async function findCapabilityAccess (params: {
  userId: string;
  capabilityId: string;
  deps: { mall: MallLike };
}): Promise<AccessRow | null> {
  const { userId, capabilityId, deps } = params;
  if (deps.mall.accesses?.get == null) return null;
  const list = await deps.mall.accesses.get(userId, {});
  for (const acc of (list || [])) {
    const cmcCd = acc?.clientData?.cmc;
    if (cmcCd?.kind === 'capability' && cmcCd?.capabilityId === capabilityId) {
      return acc;
    }
  }
  return null;
}

/**
 * Transition a capability access from `state: 'open'` to
 * `state: 'consumed'`. Called by the responder-side handler after a
 * successful accept lands (single-use mode). Idempotent — calling on
 * an already-consumed access is a no-op (no-op write). Open-link mode
 * callers should NOT call this; their consumption tracking is Phase 2.
 */
async function markCapabilityConsumed (params: {
  userId: string;
  capabilityId: string;
  deps: { mall: MallLike; now?: () => number };
}): Promise<{ ok: boolean; reason?: string }> {
  const { userId, capabilityId, deps } = params;
  const acc = await findCapabilityAccess({ userId, capabilityId, deps });
  if (acc == null) return { ok: false, reason: 'capability-access-not-found' };
  const cmcCd = acc.clientData?.cmc;
  if (cmcCd?.capability?.state === 'consumed') {
    return { ok: true }; // idempotent
  }
  if (deps.mall.accesses.update == null) {
    return { ok: false, reason: 'mall-accesses-update-unavailable' };
  }
  const now = deps.now ?? defaultNow;
  await deps.mall.accesses.update(userId, {
    id: acc.id,
    update: {
      clientData: {
        ...(acc.clientData || {}),
        cmc: {
          ...cmcCd,
          capability: {
            ...(cmcCd.capability || {}),
            state: 'consumed',
            stateChangedAt: now(),
          },
        },
      },
    },
  });
  return { ok: true };
}

/**
 * Append an accepter (`{ username, host }`) to the capability access's
 * `clientData.cmc.capability.acceptedBy` array. Idempotent — if the same
 * pair is already present (compared by lowercased username + slugified
 * host) the function is a no-op. Used by open-link mode after each
 * successful accept on handleIncomingAccept so a same-patient re-click
 * can be detected by the response-stream write-hook.
 */
async function recordAccepter (params: {
  userId: string;
  capabilityId: string;
  accepter: { username: string; host: string };
  deps: { mall: MallLike; now?: () => number };
}): Promise<{ ok: boolean; reason?: string; alreadyPresent?: boolean }> {
  const { userId, capabilityId, accepter, deps } = params;
  if (accepter == null || typeof accepter.username !== 'string' ||
      accepter.username.length === 0 || typeof accepter.host !== 'string' ||
      accepter.host.length === 0) {
    return { ok: false, reason: 'invalid-accepter' };
  }
  const acc = await findCapabilityAccess({ userId, capabilityId, deps });
  if (acc == null) return { ok: false, reason: 'capability-access-not-found' };
  const cmcCd = acc.clientData?.cmc;
  if (deps.mall.accesses.update == null) {
    return { ok: false, reason: 'mall-accesses-update-unavailable' };
  }
  const now = deps.now ?? defaultNow;
  const incomingKey =
    accepter.username.toLowerCase() + '|' + slug.slugifyHost(accepter.host);
  const existing: Array<{ username?: string; host?: string; acceptedAt?: number }> = Array.isArray(cmcCd?.capability?.acceptedBy)
    ? cmcCd.capability.acceptedBy
    : [];
  for (const a of existing) {
    if (a == null || typeof a !== 'object') continue;
    if (typeof a.username !== 'string' || typeof a.host !== 'string') continue;
    const existingKey = a.username.toLowerCase() + '|' + slug.slugifyHost(a.host);
    if (existingKey === incomingKey) {
      return { ok: true, alreadyPresent: true };
    }
  }
  const acceptedAt = now();
  const updatedList = existing.concat([{
    username: accepter.username,
    host: accepter.host,
    acceptedAt,
  }]);
  await deps.mall.accesses.update(userId, {
    id: acc.id,
    update: {
      clientData: {
        ...(acc.clientData || {}),
        cmc: {
          ...cmcCd,
          capability: {
            ...(cmcCd?.capability || {}),
            acceptedBy: updatedList,
          },
        },
      },
    },
  });
  return { ok: true };
}

/**
 * Transition a capability access from `state: 'open'` to
 * `state: 'invalidated'`. Called by handleInvalidateLink when the
 * requester invalidates their own open-link capability. Idempotent —
 * already-`'invalidated'` is a no-op success. Already-`'consumed'`
 * capabilities are also a no-op success (single-use links auto-consume
 * on first accept; nothing to invalidate).
 */
async function markCapabilityInvalidated (params: {
  userId: string;
  capabilityId: string;
  deps: { mall: MallLike; now?: () => number };
}): Promise<{ ok: boolean; reason?: string }> {
  const { userId, capabilityId, deps } = params;
  const acc = await findCapabilityAccess({ userId, capabilityId, deps });
  if (acc == null) return { ok: false, reason: 'capability-access-not-found' };
  const cmcCd = acc.clientData?.cmc;
  const state = cmcCd?.capability?.state;
  if (state === 'invalidated' || state === 'consumed') {
    return { ok: true }; // idempotent / no-op
  }
  if (deps.mall.accesses.update == null) {
    return { ok: false, reason: 'mall-accesses-update-unavailable' };
  }
  const now = deps.now ?? defaultNow;
  await deps.mall.accesses.update(userId, {
    id: acc.id,
    update: {
      clientData: {
        ...(acc.clientData || {}),
        cmc: {
          ...cmcCd,
          capability: {
            ...(cmcCd?.capability || {}),
            state: 'invalidated',
            stateChangedAt: now(),
          },
        },
      },
    },
  });
  return { ok: true };
}

async function deleteStream (mall: MallLike, userId: string, streamId: string): Promise<unknown> {
  if (typeof mall.streams.delete === 'function') return mall.streams.delete(userId, { id: streamId });
  // The MallUserStreams class exposes deleteStream / removeStream / etc. in
  // different repo versions; tolerate missing method (tests inject minimal
  // streams.create only).
  return undefined;
}

async function ignoreNotFound<T> (p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (err: unknown) {
    const e = err as { id?: string; data?: { id?: string }; message?: string };
    const id = e?.id || e?.data?.id;
    if (id === 'unknown-resource' || id === 'unknown-referenced-resource') return undefined;
    const msg = String(e?.message || err);
    if (msg.includes('not found') || msg.includes('unknown')) return undefined;
    throw err;
  }
}

function buildApiEndpoint (base: string, token: string): string {
  if (token == null || token === '') {
    throw new Error('cmc/capability: missing access token for apiEndpoint synthesis');
  }
  const trimmed = base.replace(/\/$/, '');
  // Insert token as URL username: https://<token>@<host>[:<port>]/...
  const idx = trimmed.indexOf('://');
  if (idx === -1) throw new Error('cmc/capability: serviceUrlBase must be an absolute URL');
  return trimmed.substring(0, idx + 3) + token + '@' + trimmed.substring(idx + 3) + '/';
}

export {
  DEFAULT_TTL_SECONDS,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
  mintCapability,
  gcCapability,
  findCapabilityAccess,
  markCapabilityConsumed,
  recordAccepter,
  markCapabilityInvalidated,
  setRequestEventIdOnAccess,
  buildApiEndpoint,
};
export type { CapabilityMode, CapabilityState };
