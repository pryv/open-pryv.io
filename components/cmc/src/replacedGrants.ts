/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin: a second accept on a live relationship REPLACES the first.
 *
 * One relationship is one (counterparty, scope) pair. The requester holds a
 * single access for it, healed in place when the same account accepts again
 * (handleIncomingAccept); the accepter mints a new grant on every accept. The
 * latest accept wins and ends what it replaces, on both sides:
 *
 *   - accepter (`endReplacedGrants`, called by handleIncomingBackChannel once
 *     the requester's back-channel for the newer grant is stamped, which is
 *     the proof that the requester took that accept): every OLDER grant of
 *     the same role, counterparty and scope is deleted through the mall (the
 *     route's deletion: deletion record, the accesses it manages with it, so
 *     a member access made through it dies too) and the person's accept event
 *     that made it is marked withdrawn, `by: 'replaced'`, naming the newer
 *     accept and grant. No revoke notice is sent: the requester has already
 *     re-paired, and an older requester core would tear the new relationship
 *     down on a notice. A replaced membership (role `member`, on a group
 *     account) is also offboarded: its member accesses are swept.
 *   - requester (`closeOutFormerPairing`, called by handleIncomingAccept when
 *     an accept re-pairs a relationship to another grant of the same
 *     account): the member accesses made through the FORMER grant are swept
 *     through it, the only moment this side still holds its endpoint, and the
 *     former single-use invite is stamped `revoked` with
 *     `replacedBy: { inviteEventId }`.
 *
 * Invariant reached: one live grant per (counterparty, scope, role) on the
 * accepter, one invite `accepted` per relationship on the requester. No wire
 * change: each side works against a peer of an older release, with the
 * other's half missing.
 */

import * as C from './constants.ts';
import * as slugMod from './slug.ts';
import * as relationshipKey from './relationshipKey.ts';
import * as acceptWithdrawal from './acceptWithdrawal.ts';
import * as inviteState from './inviteState.ts';
import * as ledger from './memberLedger.ts';
import type { CmcAccessLike, CmcClientData, CmcLogger, MallLike } from './_types.ts';
import type { MemberSweep } from './memberSweep.ts';

type ReplaceDeps = {
  mall: Pick<MallLike, 'accesses'> & { events?: MallLike['events'] };
  logger?: CmcLogger;
  notifyEventChanged?: (userId: string, event: { id?: string }) => void;
  memberSweep?: Partial<Pick<MemberSweep, 'sweepMembership' | 'sweepRelationship'>>;
};

type ReplaceOutcome = {
  ended: string[];
  failed: Array<{ accessId: string; message: string }>;
};

// Tests that stand for a peer of an older release turn one half off. Module
// state only (no config key or API reaches it): a test that sets it must
// restore it, or the following tests run with a consent rule turned off.
const olderPeer = { accepter: false, requester: false };

/**
 * Tests only: behave like a core without this rule on the accepter side
 * (`accepter: true`: no older grant is ended), the requester side
 * (`requester: true`: no close-out on re-pairing), or both. `null` restores.
 */
function setOlderPeerForTests (sides: { accepter?: boolean; requester?: boolean } | null): void {
  olderPeer.accepter = sides?.accepter === true;
  olderPeer.requester = sides?.requester === true;
}

/**
 * An accepter-side grant: it names the local accept event that made it and
 * has no `capabilityId` key (the requester's back-channel carries that key,
 * null included). A back-channel this account holds toward the same peer is
 * never one.
 */
function isAccepterSideGrant (cmc: CmcClientData | null | undefined): boolean {
  return cmc != null && typeof cmc.acceptEventId === 'string' && cmc.acceptEventId.length > 0 &&
    !Object.prototype.hasOwnProperty.call(cmc, 'capabilityId');
}

function hostSlugOf (host: unknown): string | null {
  if (typeof host !== 'string' || host.length === 0) return null;
  try { return slugMod.slugifyHost(host); } catch (_e) { return null; }
}

function sameCounterparty (a: CmcClientData, b: CmcClientData): boolean {
  const ca = a.counterparty;
  const cb = b.counterparty;
  if (typeof ca?.username !== 'string' || typeof cb?.username !== 'string') return false;
  if (ca.username.toLowerCase() !== cb.username.toLowerCase()) return false;
  const ha = hostSlugOf(ca.host);
  return ha != null && ha === hostSlugOf(cb.host);
}

/**
 * The accepter-side grants of one relationship among `accesses`: the given
 * role, the given stamped counterparty, the given non-null scope; `excludeId`
 * left out. Only accesses that carry `created` are returned (an access
 * without it can be ordered against nothing, so it is never a target).
 */
function relationshipGrantsOf (params: {
  accesses: CmcAccessLike[];
  role: string;
  counterparty: CmcClientData['counterparty'];
  scopeStreamId: string | null;
  excludeId?: string | null;
}): CmcAccessLike[] {
  const { accesses, role, scopeStreamId, excludeId } = params;
  if (scopeStreamId == null || !C.RELATIONSHIP_ROLES.includes(role)) return [];
  const ref: CmcClientData = { counterparty: params.counterparty };
  return (Array.isArray(accesses) ? accesses : []).filter((s) => {
    if (s == null || s.id === excludeId || typeof s.created !== 'number') return false;
    const c = s.clientData?.cmc;
    if (c == null || c.role !== role || !isAccepterSideGrant(c) || !sameCounterparty(c, ref)) return false;
    return relationshipKey.scopeOfAccess(s) === scopeStreamId;
  });
}

/**
 * The grants `keeper` replaces among `accesses`: same role, both
 * accepter-side, same stamped counterparty, same non-null scope, created
 * strictly before the keeper (a newer grant is never ended: the requester
 * may be pairing an older accept that a retry delivered late).
 */
function replacedBy (keeper: CmcAccessLike, accesses: CmcAccessLike[]): CmcAccessLike[] {
  const k = keeper.clientData?.cmc;
  if (k == null || !isAccepterSideGrant(k) || typeof k.role !== 'string') return [];
  if (typeof keeper.created !== 'number') return [];
  const keeperCreated = keeper.created;
  return relationshipGrantsOf({ accesses, role: k.role, counterparty: k.counterparty, scopeStreamId: relationshipKey.scopeOfAccess(keeper), excludeId: keeper.id })
    .filter((s) => (s.created as number) < keeperCreated);
}

/**
 * Accepter side, before an accept mints or delivers anything: the newest
 * grant of the same relationship (role, counterparty, scope) created after
 * `after` (the accept's own grant, or the accept itself), or null. A retried
 * older accept must never re-mint or re-deliver over a consent the person
 * gave since.
 */
function newerGrantOf (params: {
  accesses: CmcAccessLike[];
  role: string;
  counterparty: CmcClientData['counterparty'];
  scopeStreamId: string | null;
  after: number;
  excludeId?: string | null;
}): CmcAccessLike | null {
  const newer = relationshipGrantsOf(params).filter((s) => (s.created as number) > params.after);
  newer.sort((a, b) => (b.created as number) - (a.created as number));
  return newer[0] ?? null;
}

/**
 * Accepter side: end every grant `keeper` replaces (see the header). A
 * deletion that fails is logged at error and reported in `failed`; the
 * others go on. Best effort for the withdrawal marker and the membership
 * sweep (the periodic pass sweeps a membership found gone).
 */
async function endReplacedGrants (params: {
  userId: string;
  keeper: CmcAccessLike;
  accesses: CmcAccessLike[];
  deps: ReplaceDeps;
}): Promise<ReplaceOutcome> {
  const { userId, keeper, accesses, deps } = params;
  const outcome: ReplaceOutcome = { ended: [], failed: [] };
  if (olderPeer.accepter) return outcome;
  const targets = replacedBy(keeper, accesses);
  if (targets.length === 0) return outcome;
  const del = deps.mall.accesses.delete;
  if (typeof del !== 'function') {
    for (const s of targets) outcome.failed.push({ accessId: s.id, message: 'mall-no-delete' });
    return outcome;
  }
  const keeperCmc = keeper.clientData!.cmc!;
  for (const s of targets) {
    try {
      await del.call(deps.mall.accesses, userId, { id: s.id });
    } catch (err: unknown) {
      // Deleted meanwhile (a concurrent delivery of the same back-channel):
      // ended, as wanted.
      if ((err as { id?: unknown })?.id === 'unknown-resource') {
        outcome.ended.push(s.id);
        continue;
      }
      const message = String((err as Error)?.message || err);
      outcome.failed.push({ accessId: s.id, message });
      deps.logger?.error?.('cmc/replacedGrants: a grant replaced by a newer accept could not be deleted; it stays live', {
        accessId: s.id, keeperAccessId: keeper.id, error: message,
      });
      continue;
    }
    outcome.ended.push(s.id);
    // A membership deleted through the mall is not offboarded by the route's
    // post-hook: its member accesses are swept here.
    if (s.clientData?.cmc?.role === C.ROLE_MEMBER && typeof deps.memberSweep?.sweepMembership === 'function') {
      try {
        await deps.memberSweep.sweepMembership(userId, s, 'revoke');
      } catch (err: unknown) {
        deps.logger?.warn?.('cmc/replacedGrants: the sweep of a replaced membership failed (the periodic pass sweeps it)', {
          accessId: s.id, error: String((err as Error)?.message || err),
        });
      }
    }
    await acceptWithdrawal.stampWithdrawalOnAccept({
      userId,
      relationshipCmc: s.clientData?.cmc,
      by: 'replaced',
      accessId: s.id,
      access: s,
      replacedBy: { acceptEventId: typeof keeperCmc.acceptEventId === 'string' ? keeperCmc.acceptEventId : null, accessId: keeper.id },
      deps: { mall: { events: deps.mall.events }, logger: deps.logger, notifyEventChanged: deps.notifyEventChanged },
    });
  }
  if (outcome.ended.length > 0) {
    deps.logger?.info?.('cmc/replacedGrants: grants replaced by a newer accept were ended', {
      keeperAccessId: keeper.id, endedAccessIds: outcome.ended,
    });
  }
  return outcome;
}

/**
 * Requester side: whether an accept granting `grantedApiEndpoint` re-pairs
 * `former` (the relationship access as read before the heal) to another
 * grant. The same accept delivered again carries the same endpoint, token
 * included: not a re-pairing.
 */
function isRePairing (former: CmcAccessLike | null | undefined, grantedApiEndpoint: string): boolean {
  const recorded = former?.clientData?.cmc?.counterparty?.apiEndpoint;
  if (typeof recorded !== 'string' || recorded.length === 0) return false;
  return ledger.grantKeyOf(recorded) !== ledger.grantKeyOf(grantedApiEndpoint);
}

/**
 * Requester side: close out the pairing an accept replaced (see the header).
 * `former` is the relationship access as it was before the heal: its grant
 * endpoint is where the former grant's member accesses are swept. Best
 * effort: a failure is logged, the accept stands.
 */
async function closeOutFormerPairing (params: {
  userId: string;
  former: CmcAccessLike;
  newInviteEventId: string | null;
  deps: ReplaceDeps;
}): Promise<{ swept: { records: number; residuals: number } | null; inviteRevoked: boolean }> {
  const { userId, former, newInviteEventId, deps } = params;
  const result: { swept: { records: number; residuals: number } | null; inviteRevoked: boolean } = { swept: null, inviteRevoked: false };
  if (olderPeer.requester) return result;
  if (typeof deps.memberSweep?.sweepRelationship === 'function') {
    try {
      result.swept = await deps.memberSweep.sweepRelationship(userId, former);
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/replacedGrants: the sweep of the former grant failed', {
        accessId: former.id, error: String((err as Error)?.message || err),
      });
    }
  }
  const formerInvite = former.clientData?.cmc?.inviteEventId;
  if (typeof formerInvite === 'string' && formerInvite.length > 0 && formerInvite !== newInviteEventId && deps.mall.events != null) {
    const stamp = await inviteState.stampInvite({
      userId,
      inviteEventId: formerInvite,
      transition: 'revoked',
      fields: { revokedAt: Date.now() / 1000, replacedBy: { inviteEventId: newInviteEventId ?? null } },
      deps: { mall: { events: deps.mall.events }, logger: deps.logger, notifyEventChanged: deps.notifyEventChanged },
    });
    result.inviteRevoked = stamp.ok && stamp.written;
  }
  return result;
}

export {
  endReplacedGrants,
  closeOutFormerPairing,
  isRePairing,
  isAccepterSideGrant,
  relationshipGrantsOf,
  newerGrantOf,
  setOlderPeerForTests,
};
export type { ReplaceDeps, ReplaceOutcome };
