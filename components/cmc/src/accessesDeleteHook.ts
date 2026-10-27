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
 * Delivery is fire-and-forget: by the time the hook runs the access is
 * already deleted (the authoritative signal); a delivery failure only
 * delays the peer's bookkeeping — mirroring handleRevoke's "local
 * revocation is authoritative" semantics — and a peer still down after
 * the in-request attempts gets the notice queued for the retry loop.
 *
 * What the peer does with the delivery: `handleIncomingRevoke` deletes the
 * access the revoke arrived through, which is our access on their account. So
 * a raw `accesses.delete` here ends both halves of the relationship, each
 * deleted by the server hosting it — as long as delivery succeeds.
 *
 * On the person's own side the delete is recorded too: on the accepter side
 * (the deleted access is the data grant) the `consent/accept-cmc` event the
 * grant was minted from gets `content.withdrawal` with
 * `by: 'accesses.delete'` (acceptWithdrawal.ts), so a lister of the person's
 * consents no longer reads it as given. Written before the peer delivery, so a
 * relationship without a peer endpoint is still recorded.
 */

import * as C from './constants.ts';
import * as outbound from './outbound.ts';
import * as relationshipKey from './relationshipKey.ts';
import * as inviteState from './inviteState.ts';
import * as acceptWithdrawal from './acceptWithdrawal.ts';
import * as retryQueue from './retryQueue.ts';
import type { OutboundDeps, CmcAccessLike, MallLike } from './_types.ts';
import type { MemberSweep } from './memberSweep.ts';

// Outbound delivery deps + an optional mall so the hook can also do local
// invite bookkeeping (marking a single-use invite revoked). mall is optional:
// older unit constructions pass none and just skip it.
// Group accounts (memberSweep.ts): a deleted membership is offboarded
// (`sweepReason` names the path: the route, a delegation detach, the
// account's deletion; `sweepPersist: false` on the latter, whose streams are
// being erased); a deleted patient relationship has its member children swept
// through the grant before the revoke is delivered.
type DeleteHookDeps = OutboundDeps & {
  mall?: MallLike;
  memberSweep?: Pick<MemberSweep, 'sweepMembership' | 'sweepRelationship'>;
  sweepReason?: string;
  sweepPersist?: boolean;
  // A notice the peer could not take is queued for the retry loop (needs
  // `mall`) when this is true: the wiring says so from `cmc.retryLoop.enabled`.
  // Absent or false, nothing is queued (a record carries the peer token, so a
  // wiring that forgets the flag fails safe).
  enqueueRetries?: boolean;
};

type DeleteHookResult = {
  accessId: string;
  attempted: boolean;
  reason?: string;
  peerNotified?: boolean;
  peerDeliveryStatus?: number;
  deliveryQueued?: boolean;
  /** Whether the withdrawal was recorded on the accept event: false when
   * nothing was written (requester side, a skip, a failure), absent when no
   * `mall` dep was wired. */
  withdrawalStamped?: boolean;
};

/** Told when the hook changed an event of the user (the invite stamp, the
 * withdrawal), so a socket client sees it live. Per call: the wiring site
 * knows the username, the factory does not. Best-effort. */
type NotifyEventChanged = (userId: string, event: { id?: string }) => void;

/**
 * Build a post-hook callable. Invocation:
 * `await hook(userId, deletedAccesses, notifyEventChanged?)` where `deletedAccesses` are the
 * full access objects captured BEFORE deletion (the route's target +
 * cascade). `userId` is an interface seam only — every input access is
 * already scoped to that user by the caller; nothing here re-reads by
 * id. Returns one result per input access (asserted by unit tests; the
 * production wiring is fire-and-forget and only surfaces warn logs).
 * Never throws — failures are logged.
 */
function createAccessesDeletePostHook (deps: DeleteHookDeps) {
  return async function accessesDeletePostHook (
    userId: string,
    deletedAccesses: CmcAccessLike[],
    notifyEventChanged?: NotifyEventChanged
  ): Promise<DeleteHookResult[]> {
    const results: DeleteHookResult[] = [];
    if (!Array.isArray(deletedAccesses)) return results;

    for (const access of deletedAccesses) {
      if (access?.id == null) continue;
      const cmc = access.clientData?.cmc;
      // A membership access deleted outright: the member is told like any
      // peer (the sweep of what was minted for them is the caller's job).
      if (cmc == null || !C.RELATIONSHIP_ROLES.includes(cmc.role as string)) {
        // Not a CMC relationship access (plain app/shared token, or a
        // CMC capability access — deleting an unconsumed invite has no
        // counterparty to notify).
        results.push({ accessId: access.id, attempted: false, reason: 'not-a-cmc-relationship-access' });
        continue;
      }

      // Group accounts: the sweep, before the peer is told (a patient
      // relationship's grant must still be live on the patient core for the
      // children to be reachable through it).
      if (deps.memberSweep != null) {
        try {
          if (cmc.role === C.ROLE_MEMBER) {
            await deps.memberSweep.sweepMembership(userId, access, deps.sweepReason ?? 'accesses.delete', { persist: deps.sweepPersist !== false });
          } else {
            await deps.memberSweep.sweepRelationship(userId, access);
          }
        } catch (err: unknown) {
          // A membership: the periodic pass sweeps it as vanished. A
          // relationship: the patient core of this release cascades anyway.
          deps.logger?.warn?.('cmc/accessesDeleteHook: the member sweep failed', {
            accessId: access.id, error: String((err as Error)?.message ?? err),
          });
        }
      }

      // Local bookkeeping, independent of peer delivery: on the requester side,
      // mark the single-use invite this relationship descends from as
      // `revoked`. For an open-link invite the delete itself was the un-join.
      // Best-effort; skipped when no `mall` dep was wired (older unit
      // constructions).
      if (deps.mall != null) {
        const stamp = await inviteState.stampRevokedFromRelationship({
          userId,
          relationshipCmc: cmc,
          deps: { mall: deps.mall, logger: deps.logger, notifyEventChanged },
        });
        if (!stamp.ok) {
          deps.logger?.warn?.('cmc/accessesDeleteHook: invite not stamped revoked (non-fatal)', {
            accessId: access.id,
            reason: stamp.reason,
          });
        }
      }

      // The person's own record: on the accepter side, mark the accept event
      // the deleted data grant was minted from as withdrawn. Best-effort;
      // skipped on the requester side and when no `mall` dep was wired.
      let withdrawalStamped: boolean | undefined;
      if (deps.mall != null) {
        const withdrawal = await acceptWithdrawal.stampWithdrawalOnAccept({
          userId,
          relationshipCmc: cmc,
          by: 'accesses.delete',
          accessId: access.id,
          access,
          deps: { mall: deps.mall, logger: deps.logger, notifyEventChanged },
        });
        withdrawalStamped = withdrawal.ok && withdrawal.written;
      }
      const stampedField = withdrawalStamped !== undefined ? { withdrawalStamped } : {};

      // A self-relationship (an account that accepted its own invite) has no
      // peer: its endpoint is the access just deleted.
      if (acceptWithdrawal.isSelfRelationship(cmc, access)) {
        results.push({ accessId: access.id, attempted: false, reason: 'self-relationship', ...stampedField });
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
        results.push({ accessId: access.id, attempted: false, reason: 'cmc-revoke-no-peer-endpoint', ...stampedField });
        continue;
      }

      // `accessId` is required by the peer's revoke content schema; the
      // event/offer ids let the peer correlate the revocation with the
      // originating invite where they were resolvable at mint time.
      const content: Record<string, unknown> = { accessId: access.id };
      if (typeof cmc.appCode === 'string') content.appCode = cmc.appCode;
      if (typeof cmc.offerEventId === 'string') content.offerEventId = cmc.offerEventId;
      if (typeof cmc.acceptEventId === 'string') content.acceptEventId = cmc.acceptEventId;
      // When the revocation was issued (a notice re-sent hours later must not
      // take a relationship re-established meanwhile).
      content.revokedAt = Date.now() / 1000;
      // Parity with handleRevoke: the invite the relationship descends from,
      // for a peer running a build older than the receiver-side enrichment.
      if (typeof cmc.inviteEventId === 'string') content.inviteEventId = cmc.inviteEventId;
      // Which relationship is being withdrawn — parity with handleRevoke, so
      // a peer holding several relationships with us under one app can tell
      // which one this raw-delete revocation refers to (the sender's
      // accessId is meaningless on their account).
      const revokedScope = relationshipKey.scopeOfAccess(access);
      if (typeof revokedScope === 'string') content.scopeStreamId = revokedScope;

      // Bounded in-request retry, same rationale as handleRevoke: the
      // access is already deleted, so a queued retry of the DELETE could
      // not re-derive the endpoint; a peer still down afterwards gets the
      // notice itself queued (endpoint included) for the retry loop.
      let delivered = false;
      let retryable = true;
      let lastStatus: number | undefined;
      let lastReason = 'cmc-revoke-delivery-failed';
      let lastRetryAfterMs: number | undefined;
      const body = { streamIds: [C.NS_INBOX], type: C.ET_REVOKE, content };
      for (let attempt = 1; attempt <= 3 && !delivered; attempt++) {
        try {
          const delivery = await outbound.postToPeer({ apiEndpoint, path: 'events', body, deps });
          lastStatus = delivery.status;
          if (delivery.ok) { delivered = true; break; }
          lastReason = (delivery as { reason?: string }).reason ?? lastReason;
          if (!outbound.isRetryableFailure(delivery)) { retryable = false; break; }
          // A 408 / 429, or a 503 naming a Retry-After, asks to come back
          // later: stop here, the notice is queued with its Retry-After.
          const hint = outbound.retryAfterOf(delivery);
          if (lastReason === 'http-retry-later' || hint != null) { lastRetryAfterMs = hint; break; }
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
      let deliveryQueued: boolean | undefined;
      if (!delivered && retryable && deps.enqueueRetries === true && deps.mall?.events?.create != null) {
        try {
          await retryQueue.enqueueDelivery({
            userId,
            delivery: { apiEndpoint, path: 'events', body },
            originalEventId: null,
            originalType: C.ET_REVOKE,
            failureReason: lastReason,
            failureDetail: lastRetryAfterMs != null ? { status: lastStatus, retryAfterMs: lastRetryAfterMs } : { status: lastStatus },
            deps: { mall: deps.mall as unknown as Parameters<typeof retryQueue.enqueueDelivery>[0]['deps']['mall'], logger: deps.logger },
          });
          deliveryQueued = true;
        } catch (err: unknown) {
          deps.logger?.error?.('cmc/accessesDeleteHook: the revoke notice could not be queued', {
            accessId: access.id, error: String((err as Error)?.message ?? err),
          });
        }
      }
      if (!delivered && deliveryQueued !== true) {
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
        ...(deliveryQueued === true ? { deliveryQueued } : {}),
        ...stampedField,
      });
    }

    return results;
  };
}

export { createAccessesDeletePostHook };
