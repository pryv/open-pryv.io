/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleIncomingRevoke.
 *
 * Runs on the side that RECEIVES a `consent/revoke-cmc` from its peer (the
 * counterparty withdrew consent). The dispatch middleware classifies such an
 * event as peer-delivered and does no outbound work for it; this handler adds
 * the one piece of LOCAL bookkeeping that must still happen: when the
 * relationship was first established through an open-link capability we
 * published, the withdrawing subject is still listed in that capability's
 * `acceptedBy`, so the link keeps refusing their re-consent. Clear their entry.
 *
 * Local-only: it reads the peer-delivered event's creating access to identify
 * the withdrawing subject (from the SERVER-stamped counterparty identity —
 * never the peer-supplied `content.from`) and the capability to clear, then
 * filters that one accepter entry. It POSTs nothing, so it cannot loop.
 *
 * Legacy bridge: relationships minted before the back-channel access carried
 * `capabilityId` are correlated via the revoke's `content.offerEventId` → the
 * local offer event → its `content.capabilityId` (or the offer stream id
 * `:_cmc:_internal:offer:<capId>`). Unresolvable → no-op success.
 */

const C = require('./constants.ts');
const capabilityMod = require('./capability.ts');

import type { LogFn } from '@pryv/boiler';
import type { MallLike, CmcAccessLike } from './_types.ts';

type LoggerLike = { debug?: LogFn; warn?: LogFn; info?: LogFn; error?: LogFn };
type EventLike = {
  type?: string;
  content?: Record<string, unknown> | null;
  streamIds?: unknown;
  createdBy?: string;
  [k: string]: unknown;
};
type Deps = { mall: MallLike; logger?: LoggerLike; now?: () => number };

async function handleIncomingRevoke (params: {
  userId: string;
  event: EventLike;
  deps: Deps;
}): Promise<{ ok: boolean; cleared?: boolean; reason?: string }> {
  const { userId, event, deps } = params;
  const { mall, logger } = deps;

  // Resolve the access that created this peer-delivered revoke — the
  // relationship access the withdrawing peer holds on our mall. `createdBy`
  // may be `<accessId> <callerId>`; take the access id (same split as
  // dispatch.isPeerDeliveredEvent).
  const createdBy = event.createdBy;
  if (typeof createdBy !== 'string' || createdBy.length === 0) {
    return { ok: true, cleared: false, reason: 'no-created-by' };
  }
  if (mall.accesses?.get == null) {
    return { ok: true, cleared: false, reason: 'mall-unavailable' };
  }
  const sep = createdBy.indexOf(' ');
  const createdByAccessId = sep === -1 ? createdBy : createdBy.slice(0, sep);

  let createdByAccess: CmcAccessLike | null = null;
  try {
    const list = await mall.accesses.get(userId, {});
    createdByAccess = Array.isArray(list)
      ? (list.find((a) => a?.id === createdByAccessId) ?? null)
      : null;
  } catch (err: unknown) {
    logger?.warn?.('cmc/handleIncomingRevoke: access lookup failed', {
      error: String((err as Error)?.message || err),
    });
    return { ok: true, cleared: false, reason: 'access-lookup-failed' };
  }
  const cmcCd = createdByAccess?.clientData?.cmc;
  if (cmcCd?.role !== 'counterparty') {
    return { ok: true, cleared: false, reason: 'not-counterparty-access' };
  }

  // Withdrawing subject — SERVER-stamped identity only, never content.from.
  const accepter = cmcCd.counterparty;
  if (accepter == null || typeof accepter.username !== 'string' ||
      typeof accepter.host !== 'string') {
    return { ok: true, cleared: false, reason: 'no-counterparty-identity' };
  }

  // Correlate to the open-link capability we published.
  let capabilityId: string | null =
    typeof cmcCd.capabilityId === 'string' && cmcCd.capabilityId.length > 0
      ? cmcCd.capabilityId
      : null;
  // Legacy bridge for relationships minted before the stamp.
  if (capabilityId == null) {
    capabilityId = await resolveCapabilityIdFromOffer(userId, event, mall, logger);
  }
  if (capabilityId == null) {
    logger?.debug?.('cmc/handleIncomingRevoke: no capability to clear (non-open-link or unresolvable)', {});
    return { ok: true, cleared: false, reason: 'no-capability' };
  }

  try {
    const res = await capabilityMod.clearAccepter({
      userId,
      capabilityId,
      accepter: { username: accepter.username, host: accepter.host },
      deps: { mall },
    });
    return { ok: true, cleared: res?.cleared === true };
  } catch (err: unknown) {
    logger?.warn?.('cmc/handleIncomingRevoke: clearAccepter failed', {
      capabilityId,
      error: String((err as Error)?.message || err),
    });
    return { ok: true, cleared: false, reason: 'clear-failed' };
  }
}

/**
 * Legacy correlation: read the local offer event named by the revoke's
 * `content.offerEventId` and extract its capabilityId — from the event content
 * (stamped at mint) or, failing that, its offer stream id
 * (`:_cmc:_internal:offer:<capId>`).
 */
async function resolveCapabilityIdFromOffer (
  userId: string,
  event: EventLike,
  mall: MallLike,
  logger?: LoggerLike
): Promise<string | null> {
  const offerEventId = event.content?.offerEventId;
  if (typeof offerEventId !== 'string' || offerEventId.length === 0) return null;
  if (mall.events?.get == null) return null;
  try {
    const list = await mall.events.get(userId, { id: offerEventId });
    const offer = Array.isArray(list) ? list[0] : null;
    if (offer == null) return null;
    // `offerEventId` is peer-supplied. The blast radius is already bounded — the
    // accepter we clear is the SERVER-stamped counterparty of the createdBy
    // access, so a peer can at most clear THEIR OWN entry — but only trust an
    // event that is actually one of our CMC offers, not an arbitrary event id.
    if ((offer as { type?: string }).type !== C.ET_REQUEST) return null;
    const content = (offer as { content?: Record<string, unknown> }).content;
    const fromContent = content?.capabilityId;
    if (typeof fromContent === 'string' && fromContent.length > 0) return fromContent;
    // Fallback: parse the offer stream id.
    const streamIds = (offer as { streamIds?: unknown }).streamIds;
    const prefix = C.NS_INTERNAL + ':offer:';
    if (Array.isArray(streamIds)) {
      for (const sid of streamIds) {
        if (typeof sid === 'string' && sid.startsWith(prefix)) {
          const capId = sid.slice(prefix.length);
          if (capId.length > 0) return capId;
        }
      }
    }
    return null;
  } catch (err: unknown) {
    logger?.warn?.('cmc/handleIncomingRevoke: offer lookup failed (legacy bridge)', {
      error: String((err as Error)?.message || err),
    });
    return null;
  }
}

export { handleIncomingRevoke };
