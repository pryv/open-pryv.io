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
 * counterparty withdrew consent). It does two things, in this order:
 *
 *   1. ENFORCE — delete the relationship access the revoke arrived through.
 *      That access is the credential the withdrawing peer holds against THIS
 *      account, so deleting it is what makes the revocation real on our side.
 *      Without it the peer withdrew, both sides consider the relationship
 *      over, and their token kept reading our data until their own app got
 *      around to removing it.
 *   2. BOOKKEEP — when the relationship was established through an open-link
 *      capability we published, the withdrawing subject is still listed in
 *      that capability's `acceptedBy`, so the link keeps refusing their
 *      re-consent. Clear their entry.
 *
 * Enforcement runs FIRST because the failure modes are not symmetric: a crash
 * between the two leaves a stale `acceptedBy` (re-consent refused until it is
 * cleared, recoverable) whereas the opposite order would leave a live token.
 *
 * Identity is taken from the creating access's SERVER-stamped counterparty,
 * never from the peer-supplied `content.from` / `content.accessId` /
 * `content.scopeStreamId`. A peer can therefore only ever destroy what it
 * already holds on this account. The deletes go through the mall rather than
 * the api-server route, so they do not fire the accesses-delete hook: this
 * handler still POSTs nothing and cannot loop.
 *
 * Sibling sweep: the accepter mints a NEW data-grant on every accept while the
 * requester heals its single access in place, so one relationship can be served
 * by several grants, each of which handed the peer a live token. Every access
 * with the same server-stamped counterparty AND the same non-null scope stream
 * is the same relationship, and all of them die together. Scope-less (ancient)
 * accesses are never swept: without a scope one relationship with a peer cannot
 * be told from another under the same app, and a wrong sweep would tear down a
 * live sibling relationship.
 *
 * Legacy bridge: relationships minted before the back-channel access carried
 * `capabilityId` are correlated via the revoke's `content.offerEventId` → the
 * local offer event → its `content.capabilityId` (or the offer stream id
 * `:_cmc:_internal:offer:<capId>`). Unresolvable → no capability to clear,
 * which is a no-op for step 2 and never blocks step 1.
 */

const C = require('./constants.ts');
const capabilityMod = require('./capability.ts');
const relationshipKey = require('./relationshipKey.ts');
const slugMod = require('./slug.ts');

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
}): Promise<{
  ok: boolean;
  cleared?: boolean;
  deletedAccessIds?: string[];
  reason?: string;
}> {
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

  let accessList: CmcAccessLike[] = [];
  let createdByAccess: CmcAccessLike | null = null;
  try {
    const list = await mall.accesses.get(userId, {});
    accessList = Array.isArray(list) ? list : [];
    createdByAccess = accessList.find((a) => a?.id === createdByAccessId) ?? null;
  } catch (err: unknown) {
    logger?.warn?.('cmc/handleIncomingRevoke: access lookup failed', {
      error: String((err as Error)?.message || err),
    });
    return { ok: true, cleared: false, deletedAccessIds: [], reason: 'access-lookup-failed' };
  }
  if (createdByAccess == null) {
    // Already deleted, or the receiving user raw-deleted it between the inbox
    // write and dispatch. Nothing to enforce and nothing reliable to correlate.
    return { ok: true, cleared: false, deletedAccessIds: [], reason: 'created-by-access-gone' };
  }
  const cmcCd = createdByAccess.clientData?.cmc;
  if (cmcCd?.role !== 'counterparty') {
    return { ok: true, cleared: false, deletedAccessIds: [], reason: 'not-counterparty-access' };
  }

  // Withdrawing subject — SERVER-stamped identity only, never content.from.
  const accepter = cmcCd.counterparty;

  // Step 1 — ENFORCE. Everything the later steps need has been read off the
  // access above, so the teardown can run before them.
  const scopeStreamId: string | null = relationshipKey.scopeOfAccess(createdByAccess);
  const peerScope = (event.content as { scopeStreamId?: unknown } | null | undefined)?.scopeStreamId;
  if (typeof peerScope === 'string' && peerScope.length > 0 &&
      scopeStreamId != null && peerScope !== scopeStreamId) {
    // Version skew, or a delivery that reached the wrong relationship. Worth an
    // operator's eye, but we act on OUR scope: peer content never selects a
    // deletion target.
    logger?.warn?.('cmc/handleIncomingRevoke: peer-supplied scope differs from the ' +
      'scope of the access the revoke arrived through; proceeding on ours', {
      peerScopeStreamId: peerScope,
      scopeStreamId,
      accessId: createdByAccess.id,
    });
  }
  const deletedAccessIds = await tearDownRelationship({
    userId,
    createdByAccess,
    accessList,
    scopeStreamId,
    counterparty: accepter,
    mall,
    logger,
  });

  // Step 2 — BOOKKEEP. From here on a failure only costs a stale `acceptedBy`.
  if (accepter == null || typeof accepter.username !== 'string' ||
      typeof accepter.host !== 'string') {
    return { ok: true, cleared: false, deletedAccessIds, reason: 'no-counterparty-identity' };
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
    return { ok: true, cleared: false, deletedAccessIds, reason: 'no-capability' };
  }

  try {
    const res = await capabilityMod.clearAccepter({
      userId,
      capabilityId,
      accepter: { username: accepter.username, host: accepter.host },
      deps: { mall },
    });
    return { ok: true, cleared: res?.cleared === true, deletedAccessIds };
  } catch (err: unknown) {
    logger?.warn?.('cmc/handleIncomingRevoke: clearAccepter failed', {
      capabilityId,
      error: String((err as Error)?.message || err),
    });
    return { ok: true, cleared: false, deletedAccessIds, reason: 'clear-failed' };
  }
}

/**
 * Delete the access the revoke arrived through, plus every other access
 * serving the SAME relationship, and return the ids actually deleted.
 *
 * "Same relationship" = same server-stamped counterparty (username +
 * `slugifyHost`, the identity key `recordAccepter` / `selectRelationshipAccess`
 * use) AND the same scope stream, which must be non-null on both sides. A
 * scope-less access is never swept: it cannot be told apart from another
 * relationship with the same peer under the same app code, and tearing down the
 * wrong one is precisely the defect class this component already paid for once.
 *
 * Every delete is best-effort and independent: a "unknown resource" race with a
 * local delete is expected and tolerated per item, and a failure here never
 * prevents the `acceptedBy` bookkeeping that follows.
 */
async function tearDownRelationship (params: {
  userId: string;
  createdByAccess: CmcAccessLike;
  accessList: CmcAccessLike[];
  scopeStreamId: string | null;
  counterparty?: { username?: string; host?: string } | null;
  mall: MallLike;
  logger?: LoggerLike;
}): Promise<string[]> {
  const { userId, createdByAccess, accessList, scopeStreamId, counterparty, mall, logger } = params;
  const deleted: string[] = [];
  if (mall.accesses?.delete == null) {
    // `_types.ts` declares `delete` required, so this is a unit fake, not
    // production. Say so rather than silently reporting a teardown that did
    // not happen.
    logger?.warn?.('cmc/handleIncomingRevoke: mall has no accesses.delete; ' +
      'the peer-held access was NOT torn down', { accessId: createdByAccess.id });
    return deleted;
  }

  const targets: CmcAccessLike[] = [createdByAccess];
  if (scopeStreamId != null && counterparty != null &&
      typeof counterparty.username === 'string' && typeof counterparty.host === 'string') {
    const hostSlug = slugMod.slugifyHost(counterparty.host);
    for (const acc of accessList) {
      if (acc == null || acc.id === createdByAccess.id) continue;
      const cmc = acc.clientData?.cmc;
      if (cmc?.role !== 'counterparty') continue;
      const cp = cmc.counterparty;
      if (cp == null || cp.username !== counterparty.username) continue;
      if (typeof cp.host !== 'string' || slugMod.slugifyHost(cp.host) !== hostSlug) continue;
      if (relationshipKey.scopeOfAccess(acc) !== scopeStreamId) continue;
      targets.push(acc);
    }
  }

  for (const target of targets) {
    if (typeof target.id !== 'string' || target.id.length === 0) continue;
    try {
      await mall.accesses.delete(userId, { id: target.id });
      deleted.push(target.id);
    } catch (err: unknown) {
      // Raced with a local delete, or the row is already gone: the end state we
      // wanted is the end state we have.
      logger?.debug?.('cmc/handleIncomingRevoke: access delete failed (tolerated)', {
        accessId: target.id,
        error: String((err as Error)?.message || err),
      });
    }
  }
  if (deleted.length > 0) {
    logger?.info?.('cmc/handleIncomingRevoke: tore down the peer-held relationship access(es)', {
      deletedAccessIds: deleted,
      scopeStreamId,
    });
  }
  return deleted;
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
