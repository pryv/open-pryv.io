/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin, group accounts: the sweep, one entry point for every way a
 * membership ends.
 *
 * `sweepMembership(userId, membershipAccess, reason)` is called from:
 *   - the accesses.delete route (post-hook, `accesses.delete`),
 *   - `handleRevoke` when the group revokes the membership (`revoke`),
 *   - `handleIncomingRevoke` when the member leaves (`revoke`),
 *   - the delegation detach, for a membership a detached administrator
 *     approved (`detach`),
 *   - the account-deletion teardown of the group account (`account-deleted`,
 *     without a trigger: the account's streams are being erased),
 *   - accesses.update of a membership whose permissions no longer cover a
 *     relationship's scope (`narrowed`, those records only),
 *   - the periodic ledger pass, for a membership that expired or is gone
 *     (`expired`).
 * It writes the server-side `consent/member-revoke-cmc` on the group's scope
 * stream (naming the member and the records, for the group's audit) and
 * dispatches it through the injected dispatch, so the outcome, the status and
 * the retry of a failed sweep are the dispatch loop's as for any trigger.
 *
 * `sweepRelationship(userId, relationshipAccess)` runs when a PATIENT
 * relationship ends on the group side (the group revokes it, deletes it,
 * detaches it or deletes the account): the relationship's records are swept
 * through the grant BEFORE the revoke is delivered and the grant endpoint is
 * lost, so children die even against a patient core that does not cascade.
 * No trigger is written for it (the relationship's own revoke is the
 * record); residuals are logged and bounded by the children's expiry.
 *
 * `relationshipEnded(userId, relationshipAccessId)` marks the records of a
 * relationship the PATIENT ended as absent: its grant is gone on the patient
 * core, which took the children with it.
 *
 * `runLedgerPass(userId)` is the periodic pass: memberships that expired or
 * no longer exist are swept, live records past their own expiry are marked
 * absent, settled records past expiry are pruned.
 */

import * as C from './constants.ts';
import * as ledger from './memberLedger.ts';
import { revokeRecords } from './handleMemberRevoke.ts';
import type { CmcAccessLike, CmcLogger, MallLike, OutboundDeps } from './_types.ts';
import type { StoredLedgerRecord } from './memberLedger.ts';

type Identity = { username: string; host: string };

type DispatchFn = (params: { userId: string; event: Record<string, unknown>; deps: unknown }) => Promise<{ status: string; reason?: string; detail?: unknown }>;

type SweepDeps = OutboundDeps & {
  mall: MallLike;
  dispatch: DispatchFn;
  // The dispatch deps the sweep trigger is dispatched with (mall, fetch,
  // logger, selfIdentityFor, ...); `enqueueRetries` is forced off for a sweep
  // written without a trigger.
  dispatchDeps: Record<string, unknown>;
  now?: () => number;
};

type SweepOutcome = {
  triggerEventId: string | null;
  status: string;
  reason?: string;
  records: number;
};

type SweepOptions = {
  // Only these records (the narrowed case). Default: every live or residual
  // record of the membership.
  recordFilter?: (record: StoredLedgerRecord) => boolean;
  // Write no trigger (the account is being erased); the sweep still runs.
  persist?: boolean;
};

function identityOf (access: CmcAccessLike | null | undefined): Identity {
  const cp = access?.clientData?.cmc?.counterparty;
  return { username: typeof cp?.username === 'string' ? cp.username : 'unknown', host: typeof cp?.host === 'string' ? cp.host : 'unknown' };
}

/** The stream the sweep record is written on: the membership's scope. */
function sweepStreamOf (access: CmcAccessLike | null | undefined): string {
  const cmc = access?.clientData?.cmc;
  if (typeof cmc?.scopeStreamId === 'string' && C.isUserCreatableStreamId(cmc.scopeStreamId)) return cmc.scopeStreamId;
  for (const p of access?.permissions ?? []) {
    const sid = (p as { streamId?: unknown })?.streamId;
    if (typeof sid === 'string' && C.isUserCreatableStreamId(sid)) return sid;
  }
  if (typeof cmc?.appCode === 'string' && cmc.appCode.length > 0) return C.NS_APPS + ':' + cmc.appCode;
  return C.NS_APPS;
}

function createMemberSweep (deps: SweepDeps) {
  const now = deps.now ?? (() => Date.now() / 1000);
  const ledgerDeps = { mall: deps.mall, logger: deps.logger, now };
  const revokeDeps = { mall: deps.mall, fetch: deps.fetch, timeoutMs: deps.timeoutMs, logger: deps.logger, now };

  async function sweepMembership (userId: string, membershipAccess: CmcAccessLike, reason: string, options: SweepOptions = {}): Promise<SweepOutcome> {
    const membershipAccessId = membershipAccess.id;
    let records = (await ledger.recordsOfMembership(ledgerDeps, userId, membershipAccessId))
      .filter((r) => r.state === 'live' || r.state === 'residual');
    if (options.recordFilter != null) records = records.filter(options.recordFilter);
    if (records.length === 0) {
      return { triggerEventId: null, status: 'skipped', reason: 'nothing-to-sweep', records: 0 };
    }
    const content: Record<string, unknown> = {
      member: identityOf(membershipAccess),
      membershipAccessId,
      reason: C.MEMBER_REVOKE_REASONS.includes(reason) ? reason : 'revoke',
      records: records.map((r) => ({
        relationshipAccessId: r.relationshipAccessId,
        counterparty: r.counterparty,
        childAccessId: r.childAccessId,
        expires: r.expires,
      })),
      status: 'pending',
    };
    let event: Record<string, unknown> = { type: C.ET_MEMBER_REVOKE, streamIds: [sweepStreamOf(membershipAccess)], content };
    const persist = options.persist !== false;
    if (persist) {
      try {
        const created = await deps.mall.events.create(userId, { ...event, time: now() });
        event = { ...event, id: created?.id };
      } catch (err: unknown) {
        deps.logger?.warn?.('cmc/memberSweep: could not write the sweep record; sweeping without one', {
          userId, membershipAccessId, error: String((err as Error)?.message || err),
        });
      }
    }
    const dispatched = await deps.dispatch({
      userId,
      event,
      deps: { ...deps.dispatchDeps, ...(event.id == null ? { enqueueRetries: false } : {}) },
    });
    deps.logger?.info?.('cmc/memberSweep: membership swept', {
      userId, membershipAccessId, reason, records: records.length, status: dispatched.status, failure: dispatched.reason,
    });
    return { triggerEventId: typeof event.id === 'string' ? event.id : null, status: dispatched.status, reason: dispatched.reason, records: records.length };
  }

  async function sweepRelationship (userId: string, relationshipAccess: CmcAccessLike): Promise<{ records: number; residuals: number }> {
    const records = (await ledger.recordsOfRelationship(ledgerDeps, userId, relationshipAccess.id))
      .filter((r) => r.state === 'live' || r.state === 'residual');
    if (records.length === 0) return { records: 0, residuals: 0 };
    // The grant endpoint from the access as handed over (it may be deleted
    // from storage already, on the route's post-hook).
    const mall: MallLike = {
      ...deps.mall,
      accesses: {
        ...deps.mall.accesses,
        getOne: async (u: string, p: { id: string }) => (p.id === relationshipAccess.id ? relationshipAccess : (deps.mall.accesses.getOne != null ? await deps.mall.accesses.getOne(u, p) : null)),
      },
    };
    const r = await revokeRecords({ userId, records, deps: { ...revokeDeps, mall } });
    if (r.residuals.length > 0) {
      deps.logger?.warn?.('cmc/memberSweep: the relationship ended with residual member accesses on the patient core', {
        userId, relationshipAccessId: relationshipAccess.id, residuals: r.residuals.map((x) => x.childAccessId),
      });
    }
    return { records: records.length, residuals: r.residuals.length };
  }

  async function relationshipEnded (userId: string, relationshipAccessId: string): Promise<number> {
    const records = (await ledger.recordsOfRelationship(ledgerDeps, userId, relationshipAccessId))
      .filter((r) => r.state === 'live' || r.state === 'residual');
    for (const r of records) {
      try { await ledger.setState(ledgerDeps, userId, r.eventId, 'absent', r.childAccessId); } catch (_e) { /* best-effort */ }
    }
    return records.length;
  }

  async function runLedgerPass (userId: string): Promise<{ swept: number; expired: number; pruned: number }> {
    const records = await ledger.listRecords(ledgerDeps, userId);
    const t = now();
    let expired = 0;
    const byMembership = new Map<string, StoredLedgerRecord[]>();
    for (const r of records) {
      if (r.state !== 'live') continue;
      if (typeof r.expires === 'number' && r.expires < t) {
        try { await ledger.setState(ledgerDeps, userId, r.eventId, 'absent', r.childAccessId); expired += 1; } catch (_e) { /* best-effort */ }
        continue;
      }
      const list = byMembership.get(r.membershipAccessId) ?? [];
      list.push(r);
      byMembership.set(r.membershipAccessId, list);
    }
    let swept = 0;
    for (const [membershipAccessId, list] of byMembership) {
      let membership: CmcAccessLike | null = null;
      try {
        membership = deps.mall.accesses.getOne != null
          ? await deps.mall.accesses.getOne(userId, { id: membershipAccessId })
          : (await deps.mall.accesses.get(userId, {})).find((a) => a?.id === membershipAccessId) ?? null;
      } catch (_e) {
        continue;
      }
      const gone = membership == null || (typeof membership.expires === 'number' && membership.expires < t);
      if (!gone) continue;
      const stub: CmcAccessLike = membership ?? {
        id: membershipAccessId,
        clientData: { cmc: { role: C.ROLE_MEMBER, counterparty: list[0].member, scopeStreamId: list[0].scopeStreamId } },
      };
      await sweepMembership(userId, stub, 'expired');
      swept += 1;
    }
    const pruned = await ledger.pruneExpired(ledgerDeps, userId);
    return { swept, expired, pruned };
  }

  return { sweepMembership, sweepRelationship, relationshipEnded, runLedgerPass };
}

type MemberSweep = ReturnType<typeof createMemberSweep>;

export { createMemberSweep, sweepStreamOf };
export type { MemberSweep, SweepDeps, SweepOutcome, SweepOptions, CmcLogger };
