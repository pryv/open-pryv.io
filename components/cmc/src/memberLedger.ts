/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin, group accounts: the member ledger.
 *
 * One record per child access the group's core minted on a patient's core
 * for a member, kept as an event of type `cmc-internal/member-cmc` in the
 * hidden stream `:_cmc:_internal:members` of the group account (never
 * published, unreachable through the API read paths like the retry queue).
 *
 * The record keys the mint's idempotency: `(membershipAccessId,
 * relationshipAccessId) -> childAccessId`, verified on the patient core by
 * reading the child by id through the grant. It is never matched by name:
 * through one grant every member's children are visible, so a name match
 * would let one member reach another's child. It also drives the sweep: when
 * a membership ends, the records of that membership name what to delete and
 * where (the relationship access holds the grant endpoint).
 *
 * `state`: `live` (the child was minted and not known to be gone),
 * `deleted` (the sweep deleted it), `absent` (the patient core no longer has
 * it: deleted by the patient, or expired), `residual` (a sweep could not
 * delete it; the child's own expiry bounds its life). A record whose
 * `expires` passed and whose state is not `live` is pruned by the periodic
 * pass.
 *
 * No token is ever written here: the child's token is returned once in the
 * mint's synchronous response and lives nowhere on the group account.
 */

import * as C from './constants.ts';
import * as provisioning from './provisioning.ts';
import type { CmcLogger, MallEventsLike, MallStreamsLike, MallStoredEventLike } from './_types.ts';

type Identity = { username: string; host: string };

type LedgerState = 'live' | 'deleted' | 'absent' | 'residual';

type LedgerRecord = {
  membershipAccessId: string;
  member: Identity;
  relationshipAccessId: string;
  counterparty: Identity;
  scopeStreamId: string;
  childAccessId: string;
  childName: string;
  expires: number;
  attribution: string;
  state: LedgerState;
  stateChangedAt: number;
};

/** A record as read back: the stored content plus the event that holds it. */
type StoredLedgerRecord = LedgerRecord & { eventId: string };

type LedgerMall = { events: MallEventsLike; streams?: MallStreamsLike };

type LedgerDeps = { mall: LedgerMall; logger?: CmcLogger; now?: () => number };

const LIST_LIMIT = 10_000;

function nowSeconds (deps: LedgerDeps): number {
  return (deps.now ?? (() => Date.now() / 1000))();
}

/**
 * Make sure the ledger stream exists on this account: accounts provisioned
 * before it existed never get it from the reserved-parents memo (that probes
 * `:_cmc:` only). Idempotent; a failure is reported by the write that follows.
 */
async function ensureLedgerStream (deps: LedgerDeps, userId: string): Promise<void> {
  const streams = deps.mall.streams;
  if (streams?.create == null) return;
  try {
    await streams.create(userId, {
      id: C.NS_INTERNAL_MEMBERS,
      parentId: C.NS_INTERNAL,
      name: 'CMC group members ledger',
      clientData: { cmc: { kind: 'reserved-parent', autoProvisioned: true } },
    });
  } catch (err: unknown) {
    if (provisioning.isAlreadyExistsError(err)) return;
    deps.logger?.debug?.('cmc/memberLedger: ledger stream create failed (the write will report it)', {
      userId, error: String((err as Error)?.message || err),
    });
  }
}

function recordOf (event: Record<string, unknown>): StoredLedgerRecord | null {
  if (event?.type !== C.ET_MEMBER_LEDGER || typeof event.id !== 'string') return null;
  const c = event.content as Partial<LedgerRecord> | null | undefined;
  if (c == null || typeof c !== 'object') return null;
  if (typeof c.membershipAccessId !== 'string' || typeof c.relationshipAccessId !== 'string' ||
      typeof c.childAccessId !== 'string') return null;
  return { ...(c as LedgerRecord), eventId: event.id };
}

/** Every record of the account (filtered by the caller). */
async function listRecords (deps: LedgerDeps, userId: string): Promise<StoredLedgerRecord[]> {
  let events: Array<Record<string, unknown>>;
  try {
    events = await deps.mall.events.get(userId, {
      streams: [{ any: [C.NS_INTERNAL_MEMBERS] }],
      limit: LIST_LIMIT,
    });
  } catch (err: unknown) {
    // A stream that does not exist yet (an older account before its first
    // mint) reads as no record.
    deps.logger?.debug?.('cmc/memberLedger: ledger read failed, treated as empty', {
      userId, error: String((err as Error)?.message || err),
    });
    return [];
  }
  const out: StoredLedgerRecord[] = [];
  for (const ev of Array.isArray(events) ? events : []) {
    const r = recordOf(ev);
    if (r != null) out.push(r);
  }
  return out;
}

/** The records of one membership. */
async function recordsOfMembership (deps: LedgerDeps, userId: string, membershipAccessId: string): Promise<StoredLedgerRecord[]> {
  return (await listRecords(deps, userId)).filter((r) => r.membershipAccessId === membershipAccessId);
}

/** The records minted through one patient relationship (any member). */
async function recordsOfRelationship (deps: LedgerDeps, userId: string, relationshipAccessId: string): Promise<StoredLedgerRecord[]> {
  return (await listRecords(deps, userId)).filter((r) => r.relationshipAccessId === relationshipAccessId);
}

/**
 * The record of a (membership, relationship) pair, or null. One record per
 * pair is the invariant (`writeRecord` updates in place); should two exist,
 * a live one wins, then the most recently changed.
 */
async function findRecord (deps: LedgerDeps, userId: string, membershipAccessId: string, relationshipAccessId: string): Promise<StoredLedgerRecord | null> {
  const matches = (await listRecords(deps, userId))
    .filter((r) => r.membershipAccessId === membershipAccessId && r.relationshipAccessId === relationshipAccessId);
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    if ((a.state === 'live') !== (b.state === 'live')) return a.state === 'live' ? -1 : 1;
    return (b.stateChangedAt ?? 0) - (a.stateChangedAt ?? 0);
  });
  return matches[0];
}

/**
 * Write a record: in place when `existing` is given (the pair's record is
 * reused for the new child), as a new event otherwise. Returns the event id.
 */
async function writeRecord (deps: LedgerDeps, userId: string, record: LedgerRecord, existing?: StoredLedgerRecord | null): Promise<string> {
  const content: LedgerRecord = { ...record, stateChangedAt: record.stateChangedAt ?? nowSeconds(deps) };
  if (existing != null) {
    await deps.mall.events.updateWithMerge(userId, existing.eventId, (stored) => ({
      ...stored,
      content,
      modified: nowSeconds(deps),
      modifiedBy: C.SYSTEM_ACCESS_ID,
    }), null, { skipVersioning: true });
    return existing.eventId;
  }
  await ensureLedgerStream(deps, userId);
  const created = await deps.mall.events.create(userId, {
    streamIds: [C.NS_INTERNAL_MEMBERS],
    type: C.ET_MEMBER_LEDGER,
    time: nowSeconds(deps),
    content,
  });
  if (typeof created?.id !== 'string') throw new Error('cmc/memberLedger: the ledger write returned no id');
  return created.id;
}

/** Change a record's state (and optionally other fields). */
async function setState (deps: LedgerDeps, userId: string, eventId: string, state: LedgerState, patch: Partial<LedgerRecord> = {}): Promise<void> {
  await deps.mall.events.updateWithMerge(userId, eventId, (stored) => ({
    ...stored,
    content: {
      ...((stored.content as Record<string, unknown> | null | undefined) ?? {}),
      ...patch,
      state,
      stateChangedAt: nowSeconds(deps),
    },
    modified: nowSeconds(deps),
    modifiedBy: C.SYSTEM_ACCESS_ID,
  }), null, { skipVersioning: true });
}

/**
 * Remove the records whose child is gone for good: state not `live` and
 * `expires` in the past. Returns how many were pruned (0 when the mall view
 * has no `delete`).
 */
async function pruneExpired (deps: LedgerDeps, userId: string): Promise<number> {
  const del = deps.mall.events.delete;
  if (del == null) return 0;
  const now = nowSeconds(deps);
  let pruned = 0;
  for (const r of await listRecords(deps, userId)) {
    if (r.state === 'live' || !(typeof r.expires === 'number' && r.expires < now)) continue;
    try {
      const stored: MallStoredEventLike = { id: r.eventId, type: C.ET_MEMBER_LEDGER, streamIds: [C.NS_INTERNAL_MEMBERS] };
      await del.call(deps.mall.events, userId, stored);
      pruned += 1;
    } catch (err: unknown) {
      deps.logger?.debug?.('cmc/memberLedger: prune failed for a record (kept)', {
        userId, eventId: r.eventId, error: String((err as Error)?.message || err),
      });
    }
  }
  return pruned;
}

export {
  ensureLedgerStream,
  listRecords,
  recordsOfMembership,
  recordsOfRelationship,
  findRecord,
  writeRecord,
  setState,
  pruneExpired,
};
export type { LedgerRecord, StoredLedgerRecord, LedgerState, LedgerDeps, LedgerMall };
