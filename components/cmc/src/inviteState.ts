/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin — invite state on the `consent/request-cmc` trigger.
 *
 * The trigger event is the state record the requester's app watches, so the
 * outcome of an invite is written there, one write per transition:
 *
 *   single-use  pending    -> accepted | refused | revoked
 *               refused    -> accepted   (the subject changed their mind; a
 *                                         refusal does not consume the link)
 *               accepted   -> revoked
 *   open-link   pending    -> invalidated
 *
 * An open-link invite has many counterparties, so one subject's answer never
 * changes it: who joined is read from the relationship accesses the requester
 * holds (`clientData.cmc.role === 'counterparty'` with the invite's
 * `capabilityId`). A transition outside this table writes nothing, which is
 * what keeps a late write from overturning a final state.
 *
 * `delivered` counts as `pending`: the dispatch loop stamps it on every CMC
 * trigger it picks up, requests included.
 *
 * Best-effort: callers log the outcome and never fail a handshake on it.
 */

import * as C from './constants.ts';
import type { CmcLogger, MallEventsLike } from './_types.ts';

type InviteTransition = 'accepted' | 'refused' | 'revoked' | 'invalidated';

type StampResult =
  | { ok: true; written: boolean; skipped?: string }
  | { ok: false; reason: string };

type TriggerLike = {
  id?: string;
  type?: string;
  content?: Record<string, unknown> & { capability?: { mode?: string }; status?: string };
};

const PENDING = [undefined, 'pending', 'delivered'];

const SINGLE_USE_FROM: Record<InviteTransition, Array<string | undefined>> = {
  accepted: [...PENDING, 'refused'],
  refused: PENDING,
  revoked: [...PENDING, 'accepted'],
  invalidated: [],
};

const OPEN_LINK_FROM: Record<InviteTransition, Array<string | undefined>> = {
  accepted: [],
  refused: [],
  revoked: [],
  invalidated: PENDING,
};

function isTransitionAllowed (mode: string | undefined, from: string | undefined, to: InviteTransition): boolean {
  const table = mode === 'open-link' ? OPEN_LINK_FROM : SINGLE_USE_FROM;
  return table[to].includes(from);
}

async function stampInvite (params: {
  userId: string;
  inviteEventId: string | null | undefined;
  transition: InviteTransition;
  fields?: Record<string, unknown>;
  deps: {
    mall: { events?: Pick<MallEventsLike, 'getOne' | 'update'> };
    logger?: CmcLogger;
    notifyEventChanged?: (userId: string, event: TriggerLike) => void;
  };
}): Promise<StampResult> {
  const { userId, inviteEventId, transition, deps } = params;
  if (typeof inviteEventId !== 'string' || inviteEventId.length === 0) {
    return { ok: true, written: false, skipped: 'no-invite-event-id' };
  }
  const events = deps.mall?.events;
  if (events?.getOne == null || events?.update == null) {
    return { ok: true, written: false, skipped: 'mall-events-unavailable' };
  }
  try {
    const trigger = await events.getOne(userId, inviteEventId) as TriggerLike | null;
    if (trigger == null || trigger.type !== C.ET_REQUEST) {
      return { ok: true, written: false, skipped: 'not-a-request' };
    }
    const content = trigger.content ?? {};
    if (!isTransitionAllowed(content.capability?.mode, content.status, transition)) {
      return { ok: true, written: false, skipped: 'transition-not-allowed' };
    }
    const base: Record<string, unknown> = { ...content };
    if (transition === 'accepted') {
      // A refused single-use invite accepted later: the refusal no longer holds.
      for (const k of ['refusedBy', 'refusedAt', 'reason']) delete base[k];
    }
    const updated: TriggerLike = {
      ...trigger,
      content: { ...base, status: transition, ...(params.fields ?? {}) },
    };
    await events.update(userId, updated);
    try { deps.notifyEventChanged?.(userId, updated); } catch (_e) { /* notify is best-effort */ }
    return { ok: true, written: true };
  } catch (err: unknown) {
    deps.logger?.warn?.('cmc/inviteState: could not stamp the invite', {
      inviteEventId,
      transition,
      error: String((err as Error)?.message || err),
    });
    return { ok: false, reason: 'cmc-invite-stamp-failed' };
  }
}

/**
 * Mark the invite a deleted relationship descends from as `revoked`.
 *
 * Only on the requester side, where the relationship access (the back-channel)
 * carries the `capabilityId` key and `inviteEventId` names a local trigger. On
 * the accepter side `inviteEventId` is the peer's id, meaningless here. A
 * relationship minted before `inviteEventId` was stamped has nothing to mark.
 * The transition table leaves open-link invites untouched.
 */
async function stampRevokedFromRelationship (params: {
  userId: string;
  relationshipCmc: { capabilityId?: string | null; inviteEventId?: string | null } | null | undefined;
  deps: Parameters<typeof stampInvite>[0]['deps'];
}): Promise<StampResult> {
  const { userId, relationshipCmc, deps } = params;
  if (relationshipCmc == null ||
      !Object.prototype.hasOwnProperty.call(relationshipCmc, 'capabilityId')) {
    return { ok: true, written: false, skipped: 'not-requester-side' };
  }
  return stampInvite({
    userId,
    inviteEventId: relationshipCmc.inviteEventId,
    transition: 'revoked',
    fields: { revokedAt: Date.now() / 1000 },
    deps,
  });
}

export { stampInvite, stampRevokedFromRelationship, isTransitionAllowed };
export type { InviteTransition };
