/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin: the withdrawal marker on the subject's `consent/accept-cmc`.
 *
 * The accept event in `:_cmc:apps:<app>[:<sub>]` is the person's own record of
 * a consent they gave. When the consent ends, whatever ended it, that record
 * says so: `content.withdrawal = { at, by, accessId, revokeEventId? }`, where
 * `by` names the teardown path:
 *
 *   'accesses.delete'    the data grant was deleted through the API
 *                        (accessesDeleteHook)
 *   'revoke-cmc'         the person wrote a `consent/revoke-cmc` (handleRevoke;
 *                        `revokeEventId` is that trigger)
 *   'peer-revoke'        the requester withdrew (handleIncomingRevoke;
 *                        `revokeEventId` is the inbox arrival)
 *   'delegation-detach'  written by the delegation plugin on detach, with its
 *                        own `relId`; not written here
 *
 * `at` is in seconds. The field is server-owned (`ACCEPT_SERVER_OWNED_FIELDS`):
 * a client cannot write, change or erase it.
 *
 * Rules: accepter side only (the data grant carries the LOCAL accept event id;
 * the requester's back-channel carries the peer's, and a `capabilityId` key);
 * among writers in sequence the first wins, an existing `withdrawal` is never
 * overwritten (detach stamps before the delete hook fires, and a hook that
 * fires twice in sequence writes once); the check is a read then a write, not
 * a compare-and-set, so two concurrent stampers may both write an equivalent
 * record (same `accessId`); callers stamp only once the grant is gone; the
 * write is versioned, so the record's previous state stays
 * demonstrable. Best-effort: never throws, and a caller never fails a
 * teardown on it.
 */

import * as C from './constants.ts';
import type { CmcClientData, CmcLogger, MallEventsLike } from './_types.ts';

type WithdrawalBy = 'accesses.delete' | 'revoke-cmc' | 'peer-revoke';

type Withdrawal = {
  at: number;
  by: WithdrawalBy;
  accessId: string;
  revokeEventId?: string;
};

type StampResult =
  | { ok: true; written: boolean; skipped?: string }
  | { ok: false; reason: string };

// The fields read or written here. The stored event is spread whole into the
// update, so its other fields reach the mall unchanged.
type AcceptEventLike = {
  id?: string;
  type?: string;
  content?: Record<string, unknown> | null;
  modified?: number;
};

async function stampWithdrawalOnAccept (params: {
  userId: string;
  relationshipCmc: Pick<CmcClientData, 'capabilityId' | 'acceptEventId'> | null | undefined;
  by: WithdrawalBy;
  accessId: string;
  revokeEventId?: string | null;
  deps: {
    mall: { events?: Pick<MallEventsLike, 'getOne' | 'update'> };
    logger?: CmcLogger;
    notifyEventChanged?: (userId: string, event: AcceptEventLike) => void;
  };
}): Promise<StampResult> {
  const { userId, relationshipCmc, by, accessId, revokeEventId, deps } = params;
  // The requester's back-channel carries a `capabilityId` KEY (null for a
  // non-open-link relationship, so presence is the signal) and the PEER's
  // accept event id: nothing of ours to mark.
  if (relationshipCmc == null ||
      Object.prototype.hasOwnProperty.call(relationshipCmc, 'capabilityId') ||
      typeof relationshipCmc.acceptEventId !== 'string' || relationshipCmc.acceptEventId.length === 0) {
    return { ok: true, written: false, skipped: 'not-accepter-side' };
  }
  const acceptEventId = relationshipCmc.acceptEventId;
  const events = deps.mall.events;
  if (events?.getOne == null || events?.update == null) {
    return { ok: true, written: false, skipped: 'mall-events-unavailable' };
  }
  try {
    const event = await events.getOne(userId, acceptEventId) as AcceptEventLike | null;
    if (event == null || event.type !== C.ET_ACCEPT) {
      return { ok: true, written: false, skipped: 'not-an-accept' };
    }
    const content = event.content ?? {};
    if (content.withdrawal != null) {
      return { ok: true, written: false, skipped: 'already-withdrawn' };
    }
    const at = Date.now() / 1000;
    const withdrawal: Withdrawal = { at, by, accessId };
    if (typeof revokeEventId === 'string' && revokeEventId.length > 0) withdrawal.revokeEventId = revokeEventId;
    const updated: AcceptEventLike = { ...event, content: { ...content, withdrawal }, modified: at };
    // Versioned on purpose (no `skipVersioning`): the previous version of the
    // record is what shows the consent was given before it was withdrawn.
    const stored = await events.update(userId, updated) as AcceptEventLike | null | undefined;
    try { deps.notifyEventChanged?.(userId, stored ?? updated); } catch (_e) { /* notify is best-effort */ }
    return { ok: true, written: true };
  } catch (err: unknown) {
    deps.logger?.warn?.('cmc/acceptWithdrawal: could not record the withdrawal on the accept event', {
      acceptEventId,
      accessId,
      by,
      error: String((err as Error)?.message || err),
    });
    return { ok: false, reason: 'cmc-withdrawal-stamp-failed' };
  }
}

export { stampWithdrawalOnAccept };
export type { Withdrawal, WithdrawalBy };
