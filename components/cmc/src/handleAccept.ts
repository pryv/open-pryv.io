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
 * CMC plugin — handleAccept / handleRefuse entry points.
 *
 * These are the orchestration loop's response to `consent/accept-cmc` and
 * `consent/refuse-cmc` triggers. They wire the primitives in
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
const slugMod = require('./slug.ts');
const anchors = require('./anchorStreams.ts');
const { CmcErrorIds } = require('./errorIds.ts');

type OfferShape = {
  id?: string;
  type?: string;
  streamIds?: string[];
  content?: {
    features?: Record<string, unknown> | null;
    reason?: string;
    requesterMeta?: { username?: string; from?: { username?: string; host?: string }; host?: string; [k: string]: unknown };
    requesterUsername?: string;
    requesterHost?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

import type { CmcAccessLike, MallAccessesLike, MallEventsLike, MallStreamsLike } from './_types.ts';
type MallLike = { accesses: MallAccessesLike; events: MallEventsLike; streams?: MallStreamsLike };


type AcceptHandlerResult =
  | {
      ok: true;
      capabilityId: string | null;
      dataGrantAccessId: string;
      dataGrantApiEndpoint: string;
      offerEventId: string;
      backChannelApiEndpoint: string | null; // filled later when requester returns it
      anchorStreamIds: string[];             // chats/collectors anchors created on this side
      requesterIdentity: { username: string; host: string }; // stamped onto trigger.content.from by dispatch
    }
  | {
      ok: false;
      reason: string;
      detail?: unknown;
    };

/**
 * Handle a `consent/accept-cmc` trigger event.
 *
 * Steps (matching INTERNALS.md flow 3):
 *   1. Read offer via the capability connection.
 *   2. Build the data-grant payload.
 *   3. Create the local data-grant access via mall.accesses.create.
 *   4. Deliver `consent/accept-cmc` to the requester's responses stream via
 *      the capability connection, carrying data-grant.apiEndpoint.
 *   5. On 4xx delivery failure, roll back the data-grant access (so we
 *      don't leak a half-formed access pair).
 *
 * Status updates on the trigger event are the dispatch loop's job; this
 * handler returns the result for the loop to apply.
 */
async function handleAccept (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: Record<string, unknown>; streamIds?: string[] };
  selfIdentity: { username: string; host: string };
  deps: { mall: MallLike } & OutboundDeps;
}): Promise<AcceptHandlerResult> {
  const { userId, triggerEvent, selfIdentity, deps } = params;
  const { mall } = deps;

  if (triggerEvent.type !== C.ET_ACCEPT) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: triggerEvent.type } };
  }
  const capabilityUrl = (triggerEvent.content as { capabilityUrl?: string })?.capabilityUrl;
  if (typeof capabilityUrl !== 'string' || capabilityUrl.length === 0) {
    return { ok: false, reason: 'cmc-handler-missing-capability-url' };
  }
  const accessName = (triggerEvent.content as { accessName?: string })?.accessName;
  const features: Record<string, unknown> | null = ((triggerEvent.content as { features?: Record<string, unknown> | null })?.features ?? null) as Record<string, unknown> | null;

  // 1. Read the offer.
  let offer: OfferShape | undefined;
  try {
    offer = (await ao.readOfferViaCapability({ capabilityUrl, deps })) as OfferShape | undefined;
  } catch (err: unknown) {
    const e = err as { id?: string; message?: string };
    return {
      ok: false,
      reason: e?.id || 'cmc-handler-offer-read-failed',
      detail: { message: String(e?.message || err) },
    };
  }

  if (offer == null) {
    return { ok: false, reason: 'cmc-handler-offer-read-failed' };
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

  // 2a. Provision our anchor streams BEFORE creating the data-grant
  // access — the access carries contribute permissions on those streams
  // (so the counterparty can POST chat / system messages to us via the
  // same data-grant apiEndpoint), and access creation requires the
  // referenced streams to exist.
  const anchorScope = pickScopeFromOfferOrTrigger(offer, triggerEvent);
  let preCreatedAnchorIds: string[] = [];
  let chatStream: string | null = null;
  let collectorStream: string | null = null;
  if (anchorScope != null && mall.streams?.create != null) {
    const peerSlug = slugMod.counterpartySlug({
      username: counterparty.username,
      host: counterparty.host,
    });
    const provisioned = await anchors.provisionAnchorStreams({
      userId,
      scopeStreamId: anchorScope,
      peerSlug,
      mall,
    });
    if (provisioned.ok) {
      preCreatedAnchorIds = provisioned.created;
      chatStream = C.chatStreamUnder(anchorScope, peerSlug);
      collectorStream = C.collectorStreamUnder(anchorScope, peerSlug);
    } else {
      deps.logger?.warn?.('cmc/handleAccept: anchor-stream creation failed (non-fatal)', {
        streamId: provisioned.failedStreamId,
        error: provisioned.failureMessage,
      });
    }
  }

  // 2b. Build the data-grant payload — include contribute on our anchor
  // streams so the peer can deliver chats / system events back to us,
  // PLUS create-only on :_cmc:inbox so the peer can POST a follow-up
  // `consent/back-channel-cmc` event carrying their back-channel apiEndpoint
  // (handleIncomingAccept on the peer side does this right after they
  // mint the back-channel access; without inbox-create here, that
  // delivery 403s and we never learn the peer's apiEndpoint).
  let dataGrantPayload: Record<string, unknown> | undefined;
  try {
    const extraPermissions: Array<Record<string, unknown>> = [
      { streamId: C.NS_INBOX, level: 'create-only' },
    ];
    if (chatStream != null) extraPermissions.push({ streamId: chatStream, level: 'contribute' });
    if (collectorStream != null) extraPermissions.push({ streamId: collectorStream, level: 'contribute' });
    const grantedPermissions = (triggerEvent.content as { grantedPermissions?: Array<Record<string, unknown>> })?.grantedPermissions;
    dataGrantPayload = ao.buildDataGrantPayload({
      offerEvent: offer,
      counterparty,
      accessName,
      features,
      extraPermissions: extraPermissions.length > 0 ? extraPermissions : undefined,
      grantedPermissions,
      acceptEventId: triggerEvent?.id,
    });
  } catch (err: unknown) {
    const e = err as { id?: string; message?: string };
    return {
      ok: false,
      reason: e?.id || 'cmc-handler-build-data-grant-failed',
      detail: { message: String(e?.message || err) },
    };
  }

  // 3. Chain check (defense in depth) — the api-server's accesses.create
  // route runs `context.access.canCreateAccess(payload)` in
  // applyPrerequisitesForCreation before insertOne. mall.accesses.create
  // (storage-layer) bypasses that check. The primary protection is
  // cmcAcceptAccessGateHook (events.create middleware) which rejects
  // non-personal tokens before dispatch runs; this re-check closes the
  // mall bypass for any path that reaches here without the gate. Reuses
  // AccessLogic.canCreateAccess — no parallel implementation. If
  // triggerAccess isn't provided (unit-test dispatch with mocked deps),
  // skip the check; the gate is the primary guard.
  const triggerAccess = (deps as { triggerAccess?: { canCreateAccess?: (payload: unknown) => boolean | Promise<boolean> } })?.triggerAccess;
  if (triggerAccess?.canCreateAccess != null) {
    let canCreate = true;
    try {
      canCreate = await triggerAccess.canCreateAccess(dataGrantPayload!);
    } catch (err: unknown) {
      return {
        ok: false,
        reason: CmcErrorIds.INSUFFICIENT_PERMISSIONS,
        detail: { message: 'canCreateAccess threw: ' + String((err as Error)?.message || err) },
      };
    }
    if (!canCreate) {
      return {
        ok: false,
        reason: CmcErrorIds.INSUFFICIENT_PERMISSIONS,
        detail: { message: 'trigger-writing access lacks permissions to mint the data-grant access' },
      };
    }
  }

  // 4. Create the local data-grant access. Accesses are unique on
  // (name, type, deviceName), so a fixed client-side accessName (typical
  // for apps passing their own app name on every accept) collides with
  // the access minted by a PREVIOUS accept — and a re-dispatch of THIS
  // accept (retry after a delivery failure) collides with its own prior
  // data-grant. Neither may surface as a permanent raw-DB failure:
  //   - own prior data-grant (matched via clientData.cmc.acceptEventId)
  //     → reuse it, making re-dispatch idempotent;
  //   - unrelated access → retry once with a deterministic per-accept
  //     suffix so distinct accepts never fight over one name;
  //   - still colliding → typed permanent failure (no retry, no raw
  //     constraint message echoed to the client).
  let dataGrantAccess: CmcAccessLike | undefined | null;
  dataGrantAccess = await findDataGrantByAcceptEventId({ mall, userId, acceptEventId: triggerEvent?.id });
  if (dataGrantAccess == null) {
    try {
      // Invariant: dataGrantPayload is assigned in the build step above; the
      // earlier catch returns before reaching this call.
      dataGrantAccess = await mall.accesses.create(userId, dataGrantPayload!);
    } catch (err: unknown) {
      if (!isDuplicateNameError(err)) {
        return {
          ok: false,
          reason: 'cmc-handler-data-grant-create-failed',
          detail: { message: String((err as Error)?.message || err) },
        };
      }
      const baseName = String(dataGrantPayload!.name ?? '');
      const suffixSource = triggerEvent?.id;
      if (typeof suffixSource !== 'string' || suffixSource.length === 0) {
        return {
          ok: false,
          reason: CmcErrorIds.HANDLER_DATA_GRANT_NAME_CONFLICT,
          detail: { name: baseName, message: 'data-grant access name is already in use' },
        };
      }
      // Deterministic across re-dispatches of the same accept event, so a
      // later retry converges on the same name instead of minting another.
      dataGrantPayload!.name = baseName + ' (' + suffixSource.slice(-8) + ')';
      try {
        dataGrantAccess = await mall.accesses.create(userId, dataGrantPayload!);
      } catch (err2: unknown) {
        if (isDuplicateNameError(err2)) {
          return {
            ok: false,
            reason: CmcErrorIds.HANDLER_DATA_GRANT_NAME_CONFLICT,
            detail: {
              name: baseName,
              message: 'data-grant access name is already in use (uniquified retry collided too)',
            },
          };
        }
        return {
          ok: false,
          reason: 'cmc-handler-data-grant-create-failed',
          detail: { message: String((err2 as Error)?.message || err2) },
        };
      }
    }
  }
  if (dataGrantAccess?.apiEndpoint == null) {
    return {
      ok: false,
      reason: 'cmc-handler-data-grant-no-apiendpoint',
    };
  }

  // 4. Deliver the accept response back to the requester via capability.
  const capabilityId: string | null = ((offer?.content as { capabilityId?: string } | undefined)?.capabilityId ?? null) as string | null;
  if (typeof capabilityId !== 'string' || capabilityId.length === 0) {
    return {
      ok: false,
      reason: 'cmc-handler-offer-missing-capability-id',
      detail: { offerEventId: offer?.id },
    };
  }
  // Include the requester's appCode + their original trigger
  // streamId in the delivered accept so the requester's
  // handleIncomingAccept can mint the back-channel access scoped
  // exactly under their per-request stream — preserving any user-
  // chosen sub-path (e.g. :_cmc:apps:my-app:study-1 vs the bare app
  // root). Without this, the back-channel anchors at the bare
  // :_cmc:apps:<app-code> and chat/system handlers can't match the
  // per-request scope the app uses.
  const requesterAppCode = (offer?.content?.requesterMeta as { appId?: string } | undefined)?.appId;
  const originStreamId = (offer?.content as { originStreamId?: string } | undefined)?.originStreamId;
  let delivery: { ok?: boolean; response?: { status?: number; reason?: string; body?: unknown }; [k: string]: unknown } | undefined;
  try {
    delivery = await ao.deliverAcceptViaCapability({
      capabilityUrl,
      capabilityId,
      dataGrantApiEndpoint: dataGrantAccess.apiEndpoint,
      counterparty: selfIdentity,
      features,
      requesterAppCode,
      requesterOriginStreamId: originStreamId,
      offerEventId: offer?.id,
      deps,
    });
  } catch (err: unknown) {
    // Network / unexpected — leave the data-grant in place so a retry
    // can re-deliver. Return retryable-flagged failure.
    return {
      ok: false,
      reason: 'cmc-handler-delivery-threw',
      detail: { message: String((err as Error)?.message || err), dataGrantAccessId: dataGrantAccess!.id },
    };
  }

  if (!delivery?.ok) {
    // 5. 4xx (non-retryable) → roll back the data-grant access so we don't
    // leak a half-formed access pair. 5xx / network → leave the access
    // in place; the outbound retry queue will re-attempt delivery.
    if (delivery?.response?.reason === 'http-4xx') {
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
      detail: { status: delivery?.response?.status, reason: delivery?.response?.reason },
    };
  }

  // Anchor streams already provisioned at step 2a (so they could be
  // referenced in the data-grant access permissions).

  return {
    ok: true,
    capabilityId: ((offer?.content as { capabilityId?: string } | undefined)?.capabilityId ?? null) as string | null,
    dataGrantAccessId: dataGrantAccess!.id!,
    dataGrantApiEndpoint: dataGrantAccess!.apiEndpoint!,
    offerEventId: offer!.id!,
    backChannelApiEndpoint: null, // filled in by a follow-up pass when the requester returns it
    anchorStreamIds: preCreatedAnchorIds,
    // Return the resolved counterparty (the REQUESTER's identity) so the
    // dispatcher can stamp `content.from = {username, host}` on the
    // accept trigger event. Without this, listAcceptedRelationships's
    // mapper falls back to `content.acceptedBy` (which carries the
    // accepter's own data-grant apiEndpoint, not the requester identity),
    // and the patient app can't discover WHICH doctor each relationship
    // belongs to.
    requesterIdentity: counterparty,
  };
}

/**
 * True when an accesses.create rejection is the (name, type, deviceName)
 * uniqueness violation. Both storage engines decorate the error with
 * `isDuplicate`; the id / message checks mirror handleIncomingAccept's
 * back-channel duplicate detection for robustness across layers.
 */
function isDuplicateNameError (err: unknown): boolean {
  const e = err as { isDuplicate?: boolean; id?: string; message?: string };
  if (e?.isDuplicate === true) return true;
  if (e?.id === 'item-already-exists' || e?.id === 'duplicate-key') return true;
  return /duplicate key|already exists|item-already-exists/i.test(String(e?.message || err));
}

/**
 * Find the data-grant access a PREVIOUS dispatch of the same accept event
 * already minted (`clientData.cmc.acceptEventId` is stamped at build time).
 * Reusing it makes accept re-dispatch idempotent: a retry after a delivery
 * failure must not fail on its own prior access's name, nor mint a second
 * data-grant. Returns null when no acceptEventId or no match.
 */
async function findDataGrantByAcceptEventId (params: {
  mall: MallLike;
  userId: string;
  acceptEventId?: string;
}): Promise<CmcAccessLike | null> {
  const { mall, userId, acceptEventId } = params;
  if (typeof acceptEventId !== 'string' || acceptEventId.length === 0) return null;
  if (typeof mall.accesses?.get !== 'function') return null;
  const list = await mall.accesses.get(userId, {});
  for (const a of (Array.isArray(list) ? list : [])) {
    const cmcMeta = a?.clientData?.cmc;
    if (cmcMeta?.role === 'counterparty' && cmcMeta?.acceptEventId === acceptEventId) {
      return a;
    }
  }
  return null;
}

/**
 * Pick the FIRST :_cmc:apps:* scope stream-id from the trigger's
 * streamIds (skipping :_cmc:inbox + other non-scope ids). Returns null
 * if none can be found.
 */
function pickScopeFromTrigger (trigger: { streamIds?: string[] }): string | null {
  const ids = Array.isArray(trigger.streamIds) ? trigger.streamIds : [];
  for (const sid of ids) {
    if (typeof sid === 'string' && sid.startsWith(C.NS_APPS + ':')) {
      // Strip any chats/collectors/<slug> suffix — we want the app-scope
      // PARENT, not the per-counterparty leaf.
      const m = sid.match(/^(:_cmc:apps:[^:]+(?::[^:]+)*?)(?::(?:chats|collectors)(?::[^:]+)?)?$/);
      if (m != null) return m[1];
      return sid;
    }
  }
  return null;
}

/**
 * Pick the anchor scope, preferring the requester's per-request streamId
 * stamped on the offer (`offer.content.originStreamId` set by capability
 * mint). Falls back to the local trigger streamId via pickScopeFromTrigger.
 *
 * Why: the accepter typically writes their `consent/accept-cmc` on the bare
 * `:_cmc:apps:<app>` parent (they don't know the requester's per-request
 * sub-path). The anchor streams must mirror the REQUESTER's per-request
 * scope (e.g. `:_cmc:apps:my-app:study-1`) so chat / system deliveries
 * land in matching streams on both sides — the dispatcher resolves the
 * counterparty access by walking the trigger streamId, and that
 * resolution requires the local provisioned streams to share the
 * remote's path structure.
 */
function pickScopeFromOfferOrTrigger (offer: OfferShape | undefined, trigger: { streamIds?: string[] }): string | null {
  const fromOffer = offer?.content?.originStreamId;
  if (typeof fromOffer === 'string' && fromOffer.startsWith(C.NS_APPS + ':')) {
    return fromOffer;
  }
  return pickScopeFromTrigger(trigger);
}

/**
 * Handle a `consent/refuse-cmc` trigger event. No data-grant created; just
 * deliver the refusal to the requester via the capability connection.
 */
async function handleRefuse (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: Record<string, unknown> };
  selfIdentity: { username: string; host: string };
  deps: OutboundDeps;
}): Promise<{ ok: boolean; reason?: string; detail?: unknown }> {
  const { triggerEvent, selfIdentity, deps } = params;

  if (triggerEvent.type !== C.ET_REFUSE) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: triggerEvent.type } };
  }
  const capabilityUrl = (triggerEvent.content as { capabilityUrl?: string })?.capabilityUrl;
  if (typeof capabilityUrl !== 'string' || capabilityUrl.length === 0) {
    return { ok: false, reason: 'cmc-handler-missing-capability-url' };
  }

  // Read the offer first to recover capabilityId (we need it to build
  // the responses streamId — the capability access has create-only on
  // :_cmc:_internal:responses:<capId>, not the parent).
  let capabilityId: string;
  try {
    const offer = await ao.readOfferViaCapability({ capabilityUrl, deps }) as OfferShape | undefined;
    const cid = (offer?.content as { capabilityId?: string } | undefined)?.capabilityId;
    if (typeof cid !== 'string' || cid.length === 0) {
      return {
        ok: false,
        reason: 'cmc-handler-offer-missing-capability-id',
        detail: { offerEventId: offer?.id },
      };
    }
    capabilityId = cid;
  } catch (err: unknown) {
    const e = err as { id?: string; message?: string };
    return {
      ok: false,
      reason: e?.id || 'cmc-handler-offer-read-failed',
      detail: { message: String(e?.message || err) },
    };
  }

  type DeliveryResult = { ok?: boolean; response?: { status?: number; reason?: string }; [k: string]: unknown };
  let delivery: DeliveryResult | undefined;
  try {
    delivery = await ao.deliverRefuseViaCapability({
      capabilityUrl,
      capabilityId,
      counterparty: selfIdentity,
      reason: (triggerEvent.content as { reason?: string })?.reason,
      deps,
    });
  } catch (err: unknown) {
    return { ok: false, reason: 'cmc-handler-delivery-threw', detail: { message: String((err as Error)?.message || err) } };
  }

  if (!delivery?.ok) {
    return {
      ok: false,
      reason: 'cmc-handler-delivery-failed',
      detail: { status: delivery?.response?.status, reason: delivery?.response?.reason },
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
function inferCounterparty (offer: OfferShape, capabilityUrl: string): { username: string; host: string } | null {
  const meta = offer?.content?.requesterMeta;
  let username: string | null = null;
  // Prefer the canonical username stamped by the requester's plugin
  // at capability mint (offer.content.requesterUsername). Fall back to
  // app-supplied requesterMeta.username, then meta.from.username.
  const stampedUsername = offer?.content?.requesterUsername;
  if (typeof stampedUsername === 'string' && stampedUsername.length > 0) {
    username = stampedUsername;
  } else if (typeof meta?.username === 'string' && meta.username.length > 0) {
    username = meta.username;
  } else if (typeof meta?.from?.username === 'string') {
    username = meta.from.username;
  }
  if (username == null) return null;

  // Prefer the canonical requester host stamped by the requester's
  // plugin at capability mint (offer.content.requesterHost). Falling
  // back to the capability URL's hostname is wrong in subdomain-style
  // deployments: e.g. https://<token>@<username>.pryv.me/ → hostname
  // = '<username>.pryv.me', which produces a slug different from the
  // requester's selfIdentity slug (`pryv.me`). Both sides must agree
  // on the same slug for chat / system delivery to land in matching
  // streams.
  let host: string | null = null;
  const stampedHost = offer?.content?.requesterHost;
  if (typeof stampedHost === 'string' && stampedHost.length > 0) {
    host = stampedHost;
  } else {
    try {
      const u = new URL(capabilityUrl);
      host = u.hostname;
      if (u.port) host += ':' + u.port;
    } catch (_e) {
      return null;
    }
  }
  if (host == null) return null;
  return { username, host };
}

export {
  handleAccept,
  handleRefuse,
  inferCounterparty,
  pickScopeFromTrigger,
  pickScopeFromOfferOrTrigger,
};
