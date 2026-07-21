/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin — accesses.delete post-hook.
 *
 * After a successful `accesses.delete` on the api-server route, examine
 * every access removed by the call (the addressed access + its cascade
 * of related deletions). For each one that is a CMC relationship access
 * (`clientData.cmc.role === 'counterparty'` — the single access each
 * side of a relationship holds for the other party), deliver a
 * `consent/revoke-cmc` lifecycle event to the counterparty's
 * `:_cmc:inbox` via the stored peer apiEndpoint.
 *
 * Why: a data subject who withdraws consent will often do it from a
 * generic account / "connected apps" screen, which calls plain
 * `accesses.delete` — not the CMC revoke helpers. Without this hook the
 * peer is never notified: nothing lands in its inbox, its bookkeeping
 * goes stale, and the loss is only discovered when the dead token fails
 * on use. With it, a raw delete is indistinguishable, from the
 * counterparty's point of view, from a helper-driven revoke.
 *
 * No suppression mechanism is needed (cf. accessesUpdateHook's
 * AsyncLocalStorage flag): CMC's own teardown (handleRevoke) deletes
 * via `mall.accesses.delete`, which does NOT pass through the
 * api-server route chain, so this hook never double-fires for
 * helper-driven revokes. Idempotency across mixed orderings holds
 * structurally: an access can only be deleted once, so at most one
 * revoke delivery is ever attempted per access.
 *
 * Delivery is best-effort + fire-and-forget: by the time the hook runs
 * the access is already deleted (the authoritative signal); a delivery
 * failure only delays the peer's bookkeeping — mirroring handleRevoke's
 * "local revocation is authoritative" semantics.
 */

import * as C from './constants.ts';
import * as outbound from './outbound.ts';
import type { OutboundDeps, CmcAccessLike } from './_types.ts';

type DeleteHookResult = {
  accessId: string;
  attempted: boolean;
  reason?: string;
  peerNotified?: boolean;
  peerDeliveryStatus?: number;
};

/**
 * Build a post-hook callable. Invocation:
 * `await hook(userId, deletedAccesses)` where `deletedAccesses` are the
 * full access objects captured BEFORE deletion (the route's target +
 * cascade). `userId` is an interface seam only — every input access is
 * already scoped to that user by the caller; nothing here re-reads by
 * id. Returns one result per input access (asserted by unit tests; the
 * production wiring is fire-and-forget and only surfaces warn logs).
 * Never throws — failures are logged.
 */
function createAccessesDeletePostHook (deps: OutboundDeps) {
  return async function accessesDeletePostHook (
    userId: string,
    deletedAccesses: CmcAccessLike[]
  ): Promise<DeleteHookResult[]> {
    const results: DeleteHookResult[] = [];
    if (!Array.isArray(deletedAccesses)) return results;

    for (const access of deletedAccesses) {
      if (access?.id == null) continue;
      const cmc = access.clientData?.cmc;
      if (cmc?.role !== 'counterparty') {
        // Not a CMC relationship access (plain app/shared token, or a
        // CMC capability access — deleting an unconsumed invite has no
        // counterparty to notify).
        results.push({ accessId: access.id, attempted: false, reason: 'not-a-cmc-relationship-access' });
        continue;
      }

      // Peer delivery path. Requester side stores it on
      // `counterparty.apiEndpoint` (stamped by handleIncomingAccept);
      // the accepter side mirrors it there too once the back-channel
      // lands (handleIncomingBackChannel), which also keeps the
      // original `backChannelApiEndpoint` field — accept either.
      const apiEndpoint = cmc.counterparty?.apiEndpoint ?? cmc.backChannelApiEndpoint;
      if (typeof apiEndpoint !== 'string' || apiEndpoint.length === 0) {
        // The back-channel handshake never completed for this
        // relationship, so this side has no endpoint for the peer and
        // the revocation cannot be forwarded — not now, and not by
        // retrying: the missing precondition is the handshake, not the
        // network. Unlike the helper flow there is no trigger event to
        // report on here (this hook is fire-and-forget off the delete
        // route), so the log IS the only signal — hence `error`, not a
        // debug-level shrug: a consent withdrawal silently failing to
        // reach the counterparty is exactly what an operator needs to
        // see.
        deps.logger?.error?.('cmc/accessesDeleteHook: counterparty NOT notified of revocation — no peer endpoint on the deleted relationship access (back-channel handshake never completed)', {
          accessId: access.id,
          reason: 'cmc-revoke-no-peer-endpoint',
        });
        results.push({ accessId: access.id, attempted: false, reason: 'cmc-revoke-no-peer-endpoint' });
        continue;
      }

      // `accessId` is required by the peer's revoke content schema; the
      // event/offer ids let the peer correlate the revocation with the
      // originating invite where they were resolvable at mint time.
      const content: Record<string, unknown> = { accessId: access.id };
      if (typeof cmc.appCode === 'string') content.appCode = cmc.appCode;
      if (typeof cmc.offerEventId === 'string') content.offerEventId = cmc.offerEventId;
      if (typeof cmc.acceptEventId === 'string') content.acceptEventId = cmc.acceptEventId;

      // Bounded in-request retry, same rationale as handleRevoke: the
      // access is already deleted, so a queued retry could not re-derive
      // the endpoint without persisting a peer token in user data.
      let delivered = false;
      let lastStatus: number | undefined;
      let lastReason = 'cmc-revoke-delivery-failed';
      for (let attempt = 1; attempt <= 3 && !delivered; attempt++) {
        try {
          const delivery = await outbound.postToPeer({
            apiEndpoint,
            path: 'events',
            body: { streamIds: [C.NS_INBOX], type: C.ET_REVOKE, content },
            deps,
          });
          lastStatus = delivery.status;
          if (delivery.ok) { delivered = true; break; }
          lastReason = (delivery as { reason?: string }).reason ?? lastReason;
          if (!outbound.isRetryableFailure(delivery)) break;
        } catch (err: unknown) {
          lastReason = 'cmc-revoke-delivery-threw';
          deps.logger?.warn?.('cmc/accessesDeleteHook: peer delivery threw', {
            accessId: access.id,
            attempt,
            error: String((err as Error)?.message ?? err),
          });
        }
        if (attempt < 3 && !delivered) {
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        }
      }
      if (!delivered) {
        // Same reasoning as the no-endpoint branch: no trigger event
        // exists to carry this, so the log is the only place a lost
        // consent-withdrawal notification can surface.
        deps.logger?.error?.('cmc/accessesDeleteHook: counterparty NOT notified of revocation after retries', {
          accessId: access.id,
          status: lastStatus,
          reason: lastReason,
        });
      }
      results.push({
        accessId: access.id,
        attempted: true,
        peerNotified: delivered,
        peerDeliveryStatus: lastStatus,
        ...(delivered ? {} : { reason: lastReason }),
      });
    }

    return results;
  };
}

export { createAccessesDeletePostHook };
