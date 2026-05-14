/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleAccept / handleRefuse entry points.
 *
 * These are the orchestration loop's response to `cmc/accept-v1` and
 * `cmc/refuse-v1` triggers. They wire the primitives in
 * acceptOrchestration.ts together with the local mall + status updates
 * on the trigger event.
 *
 * Each handler returns a result object (no exceptions for orchestration
 * failure modes — the dispatch loop turns these into trigger-event status
 * updates). All side effects go through deps so the handlers are
 * unit-testable with fakes.
 */

const C = require('./constants.ts');
const ao = require('./acceptOrchestration.ts');

type MallLike = {
  accesses: {
    create: (userId: string, params: any) => Promise<any>;
    delete?: (userId: string, params: any) => Promise<any>;
  };
  events: { update: (userId: string, params: any) => Promise<any> };
};

type OutboundDeps = {
  fetch: (url: string, init?: any) => Promise<any>;
  timeoutMs?: number;
  logger?: { debug: Function; warn: Function };
};

type AcceptHandlerResult =
  | {
      ok: true;
      capabilityId: string | null;
      dataGrantAccessId: string;
      dataGrantApiEndpoint: string;
      offerEventId: string;
      backChannelApiEndpoint: string | null; // filled later when requester returns it
    }
  | {
      ok: false;
      reason: string;
      detail?: any;
    };

/**
 * Handle a `cmc/accept-v1` trigger event.
 *
 * Steps (matching INTERNALS.md flow 3):
 *   1. Read offer via the capability connection.
 *   2. Build the data-grant payload.
 *   3. Create the local data-grant access via mall.accesses.create.
 *   4. Deliver `cmc/accept-v1` to the requester's responses stream via
 *      the capability connection, carrying data-grant.apiEndpoint.
 *   5. On 4xx delivery failure, roll back the data-grant access (so we
 *      don't leak a half-formed access pair).
 *
 * Status updates on the trigger event are the dispatch loop's job; this
 * handler returns the result for the loop to apply.
 */
async function handleAccept (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: any };
  selfIdentity: { username: string; host: string };
  deps: { mall: MallLike } & OutboundDeps;
}): Promise<AcceptHandlerResult> {
  const { userId, triggerEvent, selfIdentity, deps } = params;
  const { mall } = deps;

  if (triggerEvent.type !== C.ET_ACCEPT) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: triggerEvent.type } };
  }
  const capabilityUrl: string = triggerEvent.content?.capabilityUrl;
  if (typeof capabilityUrl !== 'string' || capabilityUrl.length === 0) {
    return { ok: false, reason: 'cmc-handler-missing-capability-url' };
  }
  const accessName: string | undefined = triggerEvent.content?.accessName;
  const features: any = triggerEvent.content?.extra ?? null;

  // 1. Read the offer.
  let offer: any;
  try {
    offer = await ao.readOfferViaCapability({ capabilityUrl, deps });
  } catch (err: any) {
    return {
      ok: false,
      reason: err?.id || 'cmc-handler-offer-read-failed',
      detail: { message: String(err?.message || err) },
    };
  }

  // The counterparty (requester) identity needs to be derivable. We use
  // the offer's `requesterMeta` if present, falling back to the capability
  // URL's host. The actual `username` lives on the offer event's
  // `createdBy` / `requesterMeta.appId` ... — for now keep it minimal:
  // require requesterMeta.username, and parse the URL host as fallback.
  const counterparty = inferCounterparty(offer, capabilityUrl);
  if (counterparty == null) {
    return { ok: false, reason: 'cmc-handler-counterparty-unknown' };
  }

  // 2. Build the data-grant payload.
  let dataGrantPayload: any;
  try {
    dataGrantPayload = ao.buildDataGrantPayload({
      offerEvent: offer,
      counterparty,
      accessName,
      features,
    });
  } catch (err: any) {
    return {
      ok: false,
      reason: err?.id || 'cmc-handler-build-data-grant-failed',
      detail: { message: String(err?.message || err) },
    };
  }

  // 3. Create the local data-grant access.
  let dataGrantAccess: any;
  try {
    dataGrantAccess = await mall.accesses.create(userId, dataGrantPayload);
  } catch (err: any) {
    return {
      ok: false,
      reason: 'cmc-handler-data-grant-create-failed',
      detail: { message: String(err?.message || err) },
    };
  }
  if (dataGrantAccess?.apiEndpoint == null) {
    return {
      ok: false,
      reason: 'cmc-handler-data-grant-no-apiendpoint',
    };
  }

  // 4. Deliver the accept response back to the requester via capability.
  let delivery: any;
  try {
    delivery = await ao.deliverAcceptViaCapability({
      capabilityUrl,
      dataGrantApiEndpoint: dataGrantAccess.apiEndpoint,
      counterparty: selfIdentity,
      features,
      deps,
    });
  } catch (err: any) {
    // Network / unexpected — leave the data-grant in place so a retry
    // can re-deliver. Return retryable-flagged failure.
    return {
      ok: false,
      reason: 'cmc-handler-delivery-threw',
      detail: { message: String(err?.message || err), dataGrantAccessId: dataGrantAccess.id },
    };
  }

  if (!delivery.ok) {
    // 5. 4xx (non-retryable) → roll back the data-grant access so we don't
    // leak a half-formed access pair. 5xx / network → leave the access
    // in place; the outbound retry queue will re-attempt delivery.
    if (delivery.response?.reason === 'http-4xx') {
      try {
        if (mall.accesses.delete != null) {
          await mall.accesses.delete(userId, { id: dataGrantAccess.id });
        }
      } catch (_e) {
        // Best-effort rollback. If the rollback fails, operator cleanup
        // will catch the orphan via the standard "access without paired
        // back-channel" pruning script (planned in Phase J).
      }
      return {
        ok: false,
        reason: 'cmc-handler-delivery-rejected',
        detail: { status: delivery.response?.status, body: delivery.response?.body },
      };
    }
    return {
      ok: false,
      reason: 'cmc-handler-delivery-failed',
      detail: { status: delivery.response?.status, reason: delivery.response?.reason },
    };
  }

  return {
    ok: true,
    capabilityId: offer?.content?.capabilityId ?? null,
    dataGrantAccessId: dataGrantAccess.id,
    dataGrantApiEndpoint: dataGrantAccess.apiEndpoint,
    offerEventId: offer.id,
    backChannelApiEndpoint: null, // filled in by a follow-up pass when the requester returns it
  };
}

/**
 * Handle a `cmc/refuse-v1` trigger event. No data-grant created; just
 * deliver the refusal to the requester via the capability connection.
 */
async function handleRefuse (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: any };
  selfIdentity: { username: string; host: string };
  deps: OutboundDeps;
}): Promise<{ ok: boolean; reason?: string; detail?: any }> {
  const { triggerEvent, selfIdentity, deps } = params;

  if (triggerEvent.type !== C.ET_REFUSE) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: triggerEvent.type } };
  }
  const capabilityUrl: string = triggerEvent.content?.capabilityUrl;
  if (typeof capabilityUrl !== 'string' || capabilityUrl.length === 0) {
    return { ok: false, reason: 'cmc-handler-missing-capability-url' };
  }

  let delivery: any;
  try {
    delivery = await ao.deliverRefuseViaCapability({
      capabilityUrl,
      counterparty: selfIdentity,
      reason: triggerEvent.content?.reason,
      deps,
    });
  } catch (err: any) {
    return { ok: false, reason: 'cmc-handler-delivery-threw', detail: { message: String(err?.message || err) } };
  }

  if (!delivery.ok) {
    return {
      ok: false,
      reason: 'cmc-handler-delivery-failed',
      detail: { status: delivery.response?.status, reason: delivery.response?.reason },
    };
  }

  return { ok: true };
}

/**
 * Best-effort inference of the requester's identity from the offer event
 * + the capability URL's host. Returns null if we can't determine a
 * username (which means the offer schema is malformed — caller surfaces
 * cmc-handler-counterparty-unknown).
 *
 * Heuristic (in priority order):
 *   1. offer.content.requesterMeta.username (if app sets it)
 *   2. offer.content.requesterMeta.from.username (alternate shape)
 *   3. null — operator-side schema enforcement should ensure one of the
 *      above. Future Phase E may stamp the username server-side as the
 *      access's owner.
 *
 * The host comes from the capability URL.
 */
function inferCounterparty (offer: any, capabilityUrl: string): { username: string; host: string } | null {
  const meta = offer?.content?.requesterMeta;
  let username: string | null = null;
  if (typeof meta?.username === 'string' && meta.username.length > 0) {
    username = meta.username;
  } else if (typeof meta?.from?.username === 'string') {
    username = meta.from.username;
  }
  if (username == null) return null;

  let host: string;
  try {
    const u = new URL(capabilityUrl);
    host = u.hostname;
    if (u.port) host += ':' + u.port;
  } catch (_e) {
    return null;
  }
  return { username, host };
}

export {
  handleAccept,
  handleRefuse,
  inferCounterparty,
};
