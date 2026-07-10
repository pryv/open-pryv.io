/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — accept / refuse orchestration primitives.
 *
 * When an app writes `consent/accept-cmc` to its scope stream on the recipient's
 * platform, the plugin needs to:
 *
 *   1. Open the capability connection (URL is in the trigger's content).
 *   2. Read the offer event via `events.get(:_cmc:_internal:offer)`.
 *   3. Create the local data-grant access on the recipient's account with
 *      permissions from the offer + clientData.cmc.role='counterparty'.
 *   4. Deliver `consent/accept-cmc` to the requester's responses stream via
 *      the capability connection, carrying the data-grant's apiEndpoint.
 *   5. Receive back-channel apiEndpoint from the requester (via offer-stream
 *      follow-up event OR events.create response).
 *   6. Store the back-channel apiEndpoint on the local data-grant access.
 *
 * This module exposes those steps as separate, unit-testable functions.
 * The full orchestration loop wires them together with retry + status
 * updates (deferred to a higher-level dispatch loop in Phase E).
 *
 * Refuse is the same shape minus the data-grant creation: just deliver
 * the refusal via the capability connection.
 *
 * outbound HTTP via outbound.ts; mall calls via the standard storage path.
 */

const C = require('./constants.ts');
const outbound = require('./outbound.ts');
const { CmcErrorIds } = require('./errorIds.ts');
// Permission-lexicon single point (pure module — covers the FULL
// accesses.create grammar: stream AND feature permissions).
const permissionSet = require('business/src/accesses/permissionSet.ts');

type PermissionLike = { streamId: string; level: string } | { feature: string; setting: string };
type OfferContent = {
  request?: { permissions?: unknown[] };
  requesterMeta?: { appId?: string };
};

type OfferEvent = {
  id: string;
  type: string;
  content: OfferContent;
};

type FetchResponse = {
  status: number;
  json: () => Promise<unknown>;
};
type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal | null;
};
type CapabilityDeps = {
  fetch: (url: string, init?: FetchInit) => Promise<FetchResponse>;
  timeoutMs?: number;
  logger?: { debug: (msg: string, ...rest: unknown[]) => void; warn: (msg: string, ...rest: unknown[]) => void };
};
type ApiError = Error & { status?: number; body?: unknown; id?: string };

/**
 * Read the offer event through a capability connection.
 *
 * The capability URL has format `https://<token>@<host>/`. We GET
 * `events?streamIds=:_cmc:_internal:offer` — the access has `read` on
 * one specific child stream under that parent, so recursive expand
 * resolves to the single accessible offer event.
 *
 * Returns the single offer event, or throws if the read fails or returns
 * 0 / >1 events.
 */
async function readOfferViaCapability (params: {
  capabilityUrl: string;
  deps: CapabilityDeps;
}): Promise<OfferEvent> {
  const { capabilityUrl, deps } = params;
  const { token, base } = outbound.parseApiEndpoint(capabilityUrl);
  // Capability access has `read` on a single per-capability stream
  // (:_cmc:_internal:offer:<capId>) but the accepter doesn't know
  // <capId> from the capabilityUrl alone. Query events.get without a
  // streams filter — the access's permissions limit the response to
  // the one event that lives on the only stream this token can read.
  // types filter narrows to consent/request-cmc in case the offer stream
  // ever holds more than one event in future revisions.
  const url = base + 'events?types[]=' + encodeURIComponent(C.ET_REQUEST);

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutMs = deps.timeoutMs ?? outbound.DEFAULT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  if (controller != null) timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await deps.fetch(url, {
      method: 'GET',
      headers: { authorization: token, accept: 'application/json' },
      signal: controller?.signal,
    });
    if (timer != null) clearTimeout(timer);
    if (res.status < 200 || res.status >= 300) {
      const body = await safeJson(res);
      const err: ApiError = new Error('cmc/accept: capability events.get failed: ' + res.status);
      err.status = res.status;
      err.body = body;
      // 401 covers "never existed" + "expired past TTL" (auth
      // middleware can't tell them apart, and the plugin doesn't keep
      // tombstones). The newly-introduced single-use `consumed` state
      // is NOT hit here — that case has the access still present but
      // its CMC state flipped, and is caught by the responses-stream
      // write-hook (emits CAPABILITY_CONSUMED via a 4xx with that id).
      if (res.status === 401) {
        err.id = CmcErrorIds.CAPABILITY_INVALID;
      }
      throw err;
    }
    const body = await safeJson(res) as { events?: OfferEvent[] } | null;
    const events = body?.events ?? [];
    if (events.length === 0) {
      const err: ApiError = new Error('cmc/accept: capability returned no offer events');
      err.id = CmcErrorIds.CAPABILITY_EMPTY;
      throw err;
    }
    if (events.length > 1) {
      const err: ApiError = new Error(
        'cmc/accept: capability returned ' + events.length + ' offer events; expected 1'
      );
      err.id = CmcErrorIds.CAPABILITY_MULTIPLE_OFFERS;
      throw err;
    }
    return events[0];
  } catch (err: unknown) {
    if (timer != null) clearTimeout(timer);
    if ((err as Error)?.name === 'AbortError') {
      const t: ApiError = new Error('cmc/accept: capability events.get timed out');
      t.id = CmcErrorIds.CAPABILITY_TIMEOUT;
      throw t;
    }
    throw err;
  }
}

/**
 * Permissions offered by the request, derived from the offer event's
 * content.request.permissions. Validated against the full
 * accesses.create permission lexicon (stream AND feature permissions,
 * e.g. selfRevoke). Returned in CONSENT form — the `mandatory`
 * annotation is preserved for grant validation and consent display;
 * strip it (permissionSet.stripConsentAnnotations) before minting.
 */
function permissionsFromOffer (offerEvent: OfferEvent): PermissionLike[] {
  const perms = offerEvent?.content?.request?.permissions;
  if (!Array.isArray(perms) || perms.length === 0) {
    const err: ApiError = new Error('cmc/accept: offer has no permissions');
    err.id = CmcErrorIds.OFFER_EMPTY_PERMISSIONS;
    throw err;
  }
  try {
    return permissionSet.normalizePermissions(perms, { consent: true });
  } catch (e: unknown) {
    const err: ApiError = new Error('cmc/accept: offer permissions invalid: ' + (e as Error).message);
    err.id = CmcErrorIds.OFFER_INVALID_PERMISSIONS;
    throw err;
  }
}

/** The offer's user-choice flag — default FALSE (all-or-nothing). */
function allowsUserChoice (offerEvent: OfferEvent): boolean {
  return (offerEvent?.content?.request as { allowUserChoice?: unknown } | undefined)?.allowUserChoice === true;
}

/**
 * Build the access-create payload for the recipient's local data-grant.
 * The access has read/contribute/etc. on the offer's permissions PLUS
 * contribute on the anchor chat + collector streams (so the requester
 * can POST chat / system messages to us via this same apiEndpoint —
 * the data-grant is also the messaging channel from the requester's side).
 * Carries the counterparty identity in clientData.cmc.role='counterparty'.
 *
 * `extraPermissions` (e.g. our anchor streams) are appended to the base
 * permissions — caller is responsible for ensuring the streams exist
 * (handleAccept provisions them before calling accesses.create when it
 * has the scope; if not, the callers fall back to lazy creation).
 */
function buildDataGrantPayload (params: {
  offerEvent: OfferEvent;
  counterparty: { username: string; host: string };
  accessName?: string;
  features?: { chat?: boolean; systemMessaging?: boolean };
  extraPermissions?: PermissionLike[];
  // Consent downgrade: grant only this subset of the offer's
  // permissions (full lexicon, exact-entry identity). Must be a
  // non-empty ⊆ of the offer's set — throws
  // `cmc-granted-permissions-not-subset` otherwise.
  grantedPermissions?: PermissionLike[];
  // The id of the local `consent/accept-cmc` event that triggered this
  // data-grant. Stamped on `clientData.cmc.acceptEventId` so client
  // code can find the resulting access by the event id it just wrote,
  // instead of disambiguating by accessName (which collides across
  // re-runs from the same app/counterparty pair).
  acceptEventId?: string;
}): Record<string, unknown> {
  const { offerEvent, counterparty, accessName, features, extraPermissions, grantedPermissions, acceptEventId } = params;
  const meta = offerEvent?.content?.requesterMeta ?? {};
  const computedName = accessName ??
    ('cmc:' + (meta.appId || 'app') + ':' + counterparty.username + '@' + counterparty.host);
  const offeredPerms = permissionsFromOffer(offerEvent); // consent form (mandatory preserved)
  let basePerms: PermissionLike[];
  if (grantedPermissions != null) {
    let normalized: PermissionLike[];
    try {
      normalized = permissionSet.normalizePermissions(grantedPermissions);
    } catch (e: unknown) {
      const err: ApiError = new Error('cmc/accept: grantedPermissions invalid: ' + (e as Error).message);
      err.id = CmcErrorIds.GRANTED_PERMISSIONS_NOT_SUBSET;
      throw err;
    }
    if (normalized.length === 0) {
      const err: ApiError = new Error('cmc/accept: grantedPermissions must not be empty (refuse instead)');
      err.id = CmcErrorIds.GRANTED_PERMISSIONS_NOT_SUBSET;
      throw err;
    }
    // THE consent-grant rule (single point): granted ⊆ offered; without
    // request.allowUserChoice the grant is ALL OR NOTHING; with it,
    // mandatory entries must still be granted.
    const check = permissionSet.checkConsentGrant(normalized, offeredPerms, allowsUserChoice(offerEvent));
    if (!check.ok) {
      const err: ApiError = new Error(
        'cmc/accept: grantedPermissions rejected (' + check.reason + '); offending: ' +
        JSON.stringify(check.offending)
      );
      err.id = check.reason === 'choice-not-allowed'
        ? CmcErrorIds.USER_CHOICE_NOT_ALLOWED
        : (check.reason === 'mandatory-refused'
            ? CmcErrorIds.MANDATORY_PERMISSION_REFUSED
            : CmcErrorIds.GRANTED_PERMISSIONS_NOT_SUBSET);
      throw err;
    }
    basePerms = normalized;
  } else {
    // No explicit grant → the whole offer, sans consent annotations.
    basePerms = permissionSet.stripConsentAnnotations(offeredPerms);
  }
  const allPerms = Array.isArray(extraPermissions) && extraPermissions.length > 0
    ? basePerms.concat(extraPermissions)
    : basePerms;
  return {
    type: 'shared',
    name: computedName,
    permissions: allPerms,
    clientData: {
      cmc: {
        role: 'counterparty',
        counterparty,
        offerEventId: offerEvent.id,
        acceptEventId: acceptEventId ?? null,
        // The back-channel apiEndpoint is added by the orchestration loop
        // after the requester's plugin returns it.
        backChannelApiEndpoint: null,
        features: features ?? null,
      },
    },
  };
}

/**
 * POST a `consent/accept-cmc` event into the requester's responses stream via
 * the capability connection. Carries the recipient's data-grant apiEndpoint
 * so the requester's plugin can mint the back-channel access pointing at it.
 */
async function deliverAcceptViaCapability (params: {
  capabilityUrl: string;
  capabilityId: string;
  dataGrantApiEndpoint: string;
  counterparty: { username: string; host: string };
  features?: { chat?: boolean; systemMessaging?: boolean };
  // Carry the requester's app-code (from offer.requesterMeta.appId),
  // the per-request origin streamId (from offer.originStreamId), and
  // the offer-event id back so the requester's handleIncomingAccept
  // can mint the back-channel access exactly scoped to the original
  // app + per-request sub-path. Without these the back-channel falls
  // back to bare :_cmc:apps:<app-code> and chat / system handlers
  // that target per-request streams can't resolve it.
  requesterAppCode?: string;
  requesterOriginStreamId?: string;
  offerEventId?: string;
  deps: CapabilityDeps;
}): Promise<{ ok: boolean; response: unknown }> {
  // The capability access has create-only on the per-capability
  // responses stream — :_cmc:_internal:responses:<capId>, not the
  // parent. Build the leaf id from capabilityId (carried in the
  // offer event's content).
  const responsesStreamId = C.responsesStreamIdFor(params.capabilityId);
  const r = await outbound.postToPeer({
    apiEndpoint: params.capabilityUrl,
    path: 'events',
    body: {
      streamIds: [responsesStreamId],
      type: C.ET_ACCEPT,
      content: {
        from: params.counterparty,
        // Stamp capabilityId so handleIncomingAccept can locate the
        // capability access on the requester side and transition its
        // single-use lifecycle state from 'open' to 'consumed' (or
        // append to acceptedBy[] in open-link mode). Without this,
        // the state-flip block in handleIncomingAccept silently no-ops
        // and a second accept on the same URL succeeds instead of
        // being rejected with `cmc-capability-consumed`.
        capabilityId: params.capabilityId,
        grantedAccess: { apiEndpoint: params.dataGrantApiEndpoint },
        features: params.features ?? null,
        requesterAppCode: params.requesterAppCode ?? null,
        requesterOriginStreamId: params.requesterOriginStreamId ?? null,
        originalEventId: params.offerEventId ?? null,
      },
    },
    deps: params.deps,
  });
  return { ok: r.ok, response: r };
}

/**
 * POST a `consent/refuse-cmc` event into the requester's responses stream via
 * the capability connection. No data-grant created on the recipient side.
 */
async function deliverRefuseViaCapability (params: {
  capabilityUrl: string;
  capabilityId: string;
  counterparty: { username: string; host: string };
  reason?: unknown;
  deps: CapabilityDeps;
}): Promise<{ ok: boolean; response: unknown }> {
  const responsesStreamId = C.responsesStreamIdFor(params.capabilityId);
  const r = await outbound.postToPeer({
    apiEndpoint: params.capabilityUrl,
    path: 'events',
    body: {
      streamIds: [responsesStreamId],
      type: C.ET_REFUSE,
      content: {
        from: params.counterparty,
        // See deliverAcceptViaCapability above — same rationale for
        // stamping capabilityId so the requester-side handler can
        // transition the capability state on refuse.
        capabilityId: params.capabilityId,
        reason: params.reason ?? null,
      },
    },
    deps: params.deps,
  });
  return { ok: r.ok, response: r };
}

async function safeJson (res: FetchResponse): Promise<unknown> {
  try { return await res.json(); } catch (_e) { return null; }
}

export {
  readOfferViaCapability,
  permissionsFromOffer,
  allowsUserChoice,
  buildDataGrantPayload,
  deliverAcceptViaCapability,
  deliverRefuseViaCapability,
};
