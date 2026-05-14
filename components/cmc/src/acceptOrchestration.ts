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
 * When an app writes `cmc/accept-v1` to its scope stream on the recipient's
 * platform, the plugin needs to:
 *
 *   1. Open the capability connection (URL is in the trigger's content).
 *   2. Read the offer event via `events.get(:_cmc:_internal:offer)`.
 *   3. Create the local data-grant access on the recipient's account with
 *      permissions from the offer + clientData.cmc.role='counterparty'.
 *   4. Deliver `cmc/accept-v1` to the requester's responses stream via
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

type Permission = { streamId: string; level: string };

type OfferEvent = {
  id: string;
  type: string;
  content: any;
};

type CapabilityDeps = {
  fetch: (url: string, init?: any) => Promise<any>;
  timeoutMs?: number;
  logger?: { debug: Function; warn: Function };
};

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
  const url = base + 'events?streamIds=' + encodeURIComponent(C.NS_INTERNAL + ':offer');

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutMs = deps.timeoutMs ?? outbound.DEFAULT_TIMEOUT_MS;
  let timer: any;
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
      const err: any = new Error('cmc/accept: capability events.get failed: ' + res.status);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    const body = await safeJson(res);
    const events = body?.events ?? [];
    if (events.length === 0) {
      const err: any = new Error('cmc/accept: capability returned no offer events');
      err.id = 'cmc-capability-empty';
      throw err;
    }
    if (events.length > 1) {
      const err: any = new Error(
        'cmc/accept: capability returned ' + events.length + ' offer events; expected 1'
      );
      err.id = 'cmc-capability-multiple-offers';
      throw err;
    }
    return events[0];
  } catch (err: any) {
    if (timer != null) clearTimeout(timer);
    if (err?.name === 'AbortError') {
      const t: any = new Error('cmc/accept: capability events.get timed out');
      t.id = 'cmc-capability-timeout';
      throw t;
    }
    throw err;
  }
}

/**
 * Permissions to grant on the recipient's data-grant access, derived from
 * the offer event's content.request.permissions. Validated against a small
 * sanity contract (streamId + level present); deeper Plan-66 chain rules
 * are checked on the requester's side.
 */
function permissionsFromOffer (offerEvent: OfferEvent): Permission[] {
  const perms = offerEvent?.content?.request?.permissions;
  if (!Array.isArray(perms) || perms.length === 0) {
    const err: any = new Error('cmc/accept: offer has no permissions');
    err.id = 'cmc-offer-empty-permissions';
    throw err;
  }
  // Pass-through; the access-creation API validates further.
  return perms.map((p: any) => ({ streamId: String(p.streamId), level: String(p.level) }));
}

/**
 * Build the access-create payload for the recipient's local data-grant.
 * The access has read/contribute/etc. on the offer's permissions and
 * carries the counterparty identity in clientData.cmc.role='counterparty'.
 *
 * The recipient's plugin will store the requester's back-channel apiEndpoint
 * on this access in a follow-up step (so chats / system messages can be
 * delivered in the reverse direction).
 */
function buildDataGrantPayload (params: {
  offerEvent: OfferEvent;
  counterparty: { username: string; host: string };
  accessName?: string;
  features?: { chat?: boolean; systemMessaging?: boolean };
}): any {
  const { offerEvent, counterparty, accessName, features } = params;
  const meta = offerEvent?.content?.requesterMeta ?? {};
  const computedName = accessName ??
    ('cmc:' + (meta.appId || 'app') + ':' + counterparty.username + '@' + counterparty.host);
  return {
    type: 'shared',
    name: computedName,
    permissions: permissionsFromOffer(offerEvent),
    clientData: {
      cmc: {
        role: 'counterparty',
        counterparty,
        offerEventId: offerEvent.id,
        // The back-channel apiEndpoint is added by the orchestration loop
        // after the requester's plugin returns it.
        backChannelApiEndpoint: null,
        features: features ?? null,
      },
    },
  };
}

/**
 * POST a `cmc/accept-v1` event into the requester's responses stream via
 * the capability connection. Carries the recipient's data-grant apiEndpoint
 * so the requester's plugin can mint the back-channel access pointing at it.
 */
async function deliverAcceptViaCapability (params: {
  capabilityUrl: string;
  dataGrantApiEndpoint: string;
  counterparty: { username: string; host: string };
  features?: { chat?: boolean; systemMessaging?: boolean };
  deps: CapabilityDeps;
}): Promise<{ ok: boolean; response: any }> {
  const r = await outbound.postToPeer({
    apiEndpoint: params.capabilityUrl,
    path: 'events',
    body: {
      streamIds: [C.NS_INTERNAL + ':responses'],
      type: C.ET_ACCEPT,
      content: {
        from: params.counterparty,
        grantedAccess: { apiEndpoint: params.dataGrantApiEndpoint },
        features: params.features ?? null,
      },
    },
    deps: params.deps,
  });
  return { ok: r.ok, response: r };
}

/**
 * POST a `cmc/refuse-v1` event into the requester's responses stream via
 * the capability connection. No data-grant created on the recipient side.
 */
async function deliverRefuseViaCapability (params: {
  capabilityUrl: string;
  counterparty: { username: string; host: string };
  reason?: any;
  deps: CapabilityDeps;
}): Promise<{ ok: boolean; response: any }> {
  const r = await outbound.postToPeer({
    apiEndpoint: params.capabilityUrl,
    path: 'events',
    body: {
      streamIds: [C.NS_INTERNAL + ':responses'],
      type: C.ET_REFUSE,
      content: {
        from: params.counterparty,
        reason: params.reason ?? null,
      },
    },
    deps: params.deps,
  });
  return { ok: r.ok, response: r };
}

async function safeJson (res: any): Promise<any> {
  try { return await res.json(); } catch (_e) { return null; }
}

export {
  readOfferViaCapability,
  permissionsFromOffer,
  buildDataGrantPayload,
  deliverAcceptViaCapability,
  deliverRefuseViaCapability,
};
