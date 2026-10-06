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
 * the requester's back-channel carries the peer's, and a `capabilityId` key),
 * except for a self-relationship (an account that accepted its own invite),
 * whose single access is both: its accept is found by `dataGrantAccessId`;
 * among writers in sequence the first wins, an existing `withdrawal` is never
 * overwritten (detach stamps before the delete hook fires, and a hook that
 * fires twice in sequence writes once); the check runs on the event as
 * stored at write time, so of two concurrent stampers one writes, and an
 * update landed since the read is kept; callers stamp only once the grant is
 * gone; the write is versioned, so the record's previous state stays
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

// The fields read or written here. The event as stored at write time is
// spread whole into the update, so its other fields reach the mall unchanged.
type AcceptEventLike = {
  id?: string;
  type?: string;
  content?: Record<string, unknown> | null;
  modified?: number;
};

type RelationshipCmc = Pick<CmcClientData, 'capabilityId' | 'acceptEventId'> & { counterparty?: { apiEndpoint?: string | null } | null };
type StampEvents = Pick<MallEventsLike, 'getOne' | 'updateWithMerge'> & Partial<Pick<MallEventsLike, 'get'>>;

/**
 * An account that accepted its own invite (refused since, but such
 * relationships may exist) holds ONE relationship access: the data grant,
 * which the incoming-accept handler then reused as the back-channel. It
 * carries the `capabilityId` key and no `acceptEventId`, and its peer
 * endpoint is its own token.
 */
function isSelfRelationship (relationshipCmc: RelationshipCmc, access: { token?: string } | null | undefined): boolean {
  const endpoint = relationshipCmc.counterparty?.apiEndpoint;
  if (typeof access?.token !== 'string' || access.token.length === 0 || typeof endpoint !== 'string') return false;
  try {
    return new URL(endpoint).username === access.token;
  } catch (_e) {
    return false;
  }
}

/** The accept trigger that recorded this access as its data grant (`content.dataGrantAccessId`). */
async function findAcceptOfDataGrant (userId: string, accessId: string, events: StampEvents): Promise<string | null> {
  if (events.get == null) return null;
  const accepts = await events.get(userId, { types: [C.ET_ACCEPT] }) as AcceptEventLike[];
  const hit = accepts.find((e) => e?.content?.dataGrantAccessId === accessId);
  return typeof hit?.id === 'string' ? hit.id : null;
}

async function stampWithdrawalOnAccept (params: {
  userId: string;
  relationshipCmc: RelationshipCmc | null | undefined;
  by: WithdrawalBy;
  accessId: string;
  revokeEventId?: string | null;
  /** The relationship access itself, to recognise a self-relationship by its token. */
  access?: { token?: string } | null;
  deps: {
    mall: { events?: StampEvents };
    logger?: CmcLogger;
    notifyEventChanged?: (userId: string, event: AcceptEventLike) => void;
  };
}): Promise<StampResult> {
  const { userId, relationshipCmc, by, accessId, revokeEventId, deps } = params;
  if (relationshipCmc == null) return { ok: true, written: false, skipped: 'not-accepter-side' };
  const events = deps.mall.events;
  // The requester's back-channel carries a `capabilityId` KEY (null for a
  // non-open-link relationship, so presence is the signal) and the PEER's
  // accept event id: nothing of ours to mark, unless the peer is this account.
  const requesterSide = Object.prototype.hasOwnProperty.call(relationshipCmc, 'capabilityId');
  let acceptEventId: string | null = !requesterSide && typeof relationshipCmc.acceptEventId === 'string' &&
    relationshipCmc.acceptEventId.length > 0
    ? relationshipCmc.acceptEventId
    : null;
  const selfRelationship = acceptEventId == null && isSelfRelationship(relationshipCmc, params.access);
  if (acceptEventId == null && !selfRelationship) {
    return { ok: true, written: false, skipped: 'not-accepter-side' };
  }
  if (events?.getOne == null || events?.updateWithMerge == null) {
    return { ok: true, written: false, skipped: 'mall-events-unavailable' };
  }
  try {
    if (acceptEventId == null) {
      acceptEventId = await findAcceptOfDataGrant(userId, accessId, events);
      if (acceptEventId == null) return { ok: true, written: false, skipped: 'not-an-accept' };
    }
    const event = await events.getOne(userId, acceptEventId) as AcceptEventLike | null;
    if (event == null || event.type !== C.ET_ACCEPT) {
      return { ok: true, written: false, skipped: 'not-an-accept' };
    }
    if (event.content?.withdrawal != null) {
      return { ok: true, written: false, skipped: 'already-withdrawn' };
    }
    const at = Date.now() / 1000;
    const withdrawal: Withdrawal = { at, by, accessId };
    if (typeof revokeEventId === 'string' && revokeEventId.length > 0) withdrawal.revokeEventId = revokeEventId;
    // Both checks run again on the event as stored at write time: a
    // withdrawal another writer recorded since the read above is kept, and so
    // is any update landed meanwhile.
    let skipped = null as string | null;
    // Versioned on purpose (no `skipVersioning`): the previous version of the
    // record is what shows the consent was given before it was withdrawn.
    const written = await events.updateWithMerge(userId, acceptEventId, (storedRow) => {
      const stored = storedRow as AcceptEventLike;
      if (stored.type !== C.ET_ACCEPT) { skipped = 'not-an-accept'; return null; }
      const content = stored.content ?? {};
      if (content.withdrawal != null) { skipped = 'already-withdrawn'; return null; }
      return { ...storedRow, content: { ...content, withdrawal }, modified: at };
    }) as AcceptEventLike | null;
    if (written == null) return { ok: true, written: false, skipped: skipped ?? 'already-withdrawn' };
    try { deps.notifyEventChanged?.(userId, written); } catch (_e) { /* notify is best-effort */ }
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

export { stampWithdrawalOnAccept, isSelfRelationship };
export type { Withdrawal, WithdrawalBy };
