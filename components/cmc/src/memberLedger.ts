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
 * Lookup by pair: a record lives at an event id derived from its pair
 * (`pairEventIdOf`), so the mint's idempotency is one read by id, not a scan
 * of the ledger. The id is not one a client can create through the API
 * (events.create accepts cuid-shaped ids only), and a create on a taken id
 * fails, so two workers can never both record the same pair. Records written
 * before this lookup existed carry a random id: they are found by a scan of
 * the ledger, skipped once a scan of the account saw none (remembered per
 * process), and moved to their pair id when next written. A record at its
 * pair id is pruned only once its membership is gone or expired (a
 * membership access id is never reused and an expired one cannot ask, so
 * the id is not asked for again): a deleted event
 * keeps its id, and a pair whose record was pruned while its membership
 * still asks would find the id taken.
 *
 * No token is ever written here: the child's token is returned once in the
 * mint's synchronous response and lives nowhere on the group account.
 */

import { createHash } from 'node:crypto';
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
  // Why a record is `absent` without a read-back, when the reason is not the
  // sweep's own verdict: `relationship-ended-by-peer` (the patient ended the
  // relationship; a patient core of this release deleted the children with
  // the grant, an older one leaves them until their expiry, unreachable
  // either way).
  absentReason?: string;
};

/** A record as read back: the stored content plus the event that holds it. */
type StoredLedgerRecord = LedgerRecord & { eventId: string };

type LedgerMall = { events: MallEventsLike; streams?: MallStreamsLike };

type LedgerDeps = { mall: LedgerMall; logger?: CmcLogger; now?: () => number };

// Read in pages: a group of 50 members and 250 patients holds 12,500 records.
const PAGE_SIZE = 1_000;

// Not a shape events.create accepts from a client (cuid-shaped ids only).
const PAIR_ID_PREFIX = 'cmcml_';

function nowSeconds (deps: LedgerDeps): number {
  return (deps.now ?? (() => Date.now() / 1000))();
}

/** The event id of a pair's record. */
function pairEventIdOf (membershipAccessId: string, relationshipAccessId: string): string {
  return PAIR_ID_PREFIX + createHash('sha256').update(membershipAccessId + ':' + relationshipAccessId).digest('hex').slice(0, 24);
}

function isAtPairId (r: StoredLedgerRecord): boolean {
  return r.eventId === pairEventIdOf(r.membershipAccessId, r.relationshipAccessId);
}

/**
 * Accounts (per mall, per process) a scan found without any record at a
 * random id: a pair whose id holds nothing has no record there.
 */
const scannedClean = new WeakMap<object, Set<string>>();

function isScannedClean (deps: LedgerDeps, userId: string): boolean {
  return scannedClean.get(deps.mall)?.has(userId) === true;
}

function setScannedClean (deps: LedgerDeps, userId: string, clean: boolean): void {
  let set = scannedClean.get(deps.mall);
  if (clean) {
    if (set == null) { set = new Set(); scannedClean.set(deps.mall, set); }
    set.add(userId);
  } else {
    set?.delete(userId);
  }
}

/**
 * Forget that the account's ledger was seen clean, so the next lookup scans
 * it (the mint calls it when the patient core says the child's name is
 * taken: a record this process could not see may exist).
 */
function forgetScan (deps: LedgerDeps, userId: string): void {
  setScannedClean(deps, userId, false);
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
  if (event?.type !== C.ET_MEMBER_LEDGER || typeof event.id !== 'string' || event.deleted != null) return null;
  const c = event.content as Partial<LedgerRecord> | null | undefined;
  if (c == null || typeof c !== 'object') return null;
  if (typeof c.membershipAccessId !== 'string' || typeof c.relationshipAccessId !== 'string' ||
      typeof c.childAccessId !== 'string') return null;
  return { ...(c as LedgerRecord), eventId: event.id };
}

/** The pair's record when `event` (read at the pair's id) is one. */
function pairRecordOf (event: Record<string, unknown> | null | undefined, membershipAccessId: string, relationshipAccessId: string): StoredLedgerRecord | null {
  if (event == null || !Array.isArray(event.streamIds) || !event.streamIds.includes(C.NS_INTERNAL_MEMBERS)) return null;
  const r = recordOf(event);
  if (r == null || r.membershipAccessId !== membershipAccessId || r.relationshipAccessId !== relationshipAccessId) return null;
  return r;
}

/**
 * Every record of the account, read page by page until a short page (no
 * ceiling: the sweep and the idempotency both need every record).
 * `complete` is false when a read failed (what was read so far is returned).
 */
async function readAll (deps: LedgerDeps, userId: string): Promise<{ records: StoredLedgerRecord[]; complete: boolean }> {
  const out: StoredLedgerRecord[] = [];
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    let events: Array<Record<string, unknown>>;
    try {
      events = await deps.mall.events.get(userId, {
        streams: [{ any: [C.NS_INTERNAL_MEMBERS] }],
        limit: PAGE_SIZE,
        skip: page * PAGE_SIZE,
      });
    } catch (err: unknown) {
      // A stream that does not exist yet (an older account before its first
      // mint) reads as no record.
      if (page === 0) {
        deps.logger?.debug?.('cmc/memberLedger: ledger read failed, treated as empty', {
          userId, error: String((err as Error)?.message || err),
        });
      } else {
        deps.logger?.warn?.('cmc/memberLedger: ledger read failed part way; the records after it are not seen this time', {
          userId, read: out.length, error: String((err as Error)?.message || err),
        });
      }
      return { records: out, complete: false };
    }
    const list = Array.isArray(events) ? events : [];
    let fresh = 0;
    for (const ev of list) {
      if (typeof ev?.id === 'string' && !seen.has(ev.id)) {
        seen.add(ev.id);
        fresh += 1;
        const r = recordOf(ev);
        if (r != null) out.push(r);
      }
    }
    if (list.length < PAGE_SIZE) break;
    // A full page of rows already seen: the store does not page (or the
    // ledger shifted by a full page while it was read). Stop, said loudly.
    if (fresh === 0) {
      deps.logger?.warn?.('cmc/memberLedger: a ledger page held no new record; reading stopped', { userId, read: out.length });
      return { records: out, complete: false };
    }
  }
  return { records: out, complete: true };
}

/** Every record of the account (filtered by the caller), read page by page. */
async function listRecords (deps: LedgerDeps, userId: string): Promise<StoredLedgerRecord[]> {
  return (await readAll(deps, userId)).records;
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
 * The record of a (membership, relationship) pair, or null: one read by the
 * pair's id. Nothing there, the ledger is scanned for a record at a random
 * id (written before the lookup by id), unless a scan of this account
 * already saw none. Should two records match, a live one wins, then the most
 * recently changed.
 */
async function findRecord (deps: LedgerDeps, userId: string, membershipAccessId: string, relationshipAccessId: string): Promise<StoredLedgerRecord | null> {
  let atPair: Record<string, unknown> | null = null;
  let probed = false;
  if (deps.mall.events.getOne != null) {
    try {
      atPair = await deps.mall.events.getOne(userId, pairEventIdOf(membershipAccessId, relationshipAccessId));
      probed = true;
    } catch (_e) { /* scanned below */ }
  }
  if (probed) {
    const r = pairRecordOf(atPair, membershipAccessId, relationshipAccessId);
    if (r != null) return r;
    if (atPair == null && isScannedClean(deps, userId)) return null;
  }
  const { records, complete } = await readAll(deps, userId);
  if (probed && complete) setScannedClean(deps, userId, records.every(isAtPairId));
  const matches = records.filter((r) => r.membershipAccessId === membershipAccessId && r.relationshipAccessId === relationshipAccessId);
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    if ((a.state === 'live') !== (b.state === 'live')) return a.state === 'live' ? -1 : 1;
    return (b.stateChangedAt ?? 0) - (a.stateChangedAt ?? 0);
  });
  return matches[0];
}

type CreateOutcome = { created: string } | { taken: 'pair'; holder: StoredLedgerRecord } | { taken: 'other' };

/**
 * Create the record event, at `id` when given. A taken id is reported:
 * `pair` when the pair's own record holds it (another worker recorded the
 * pair first; `holder` is that record), `other` otherwise (a deleted record
 * keeps its id).
 */
async function createRecordEvent (deps: LedgerDeps, userId: string, content: LedgerRecord, id?: string): Promise<CreateOutcome> {
  await ensureLedgerStream(deps, userId);
  let created;
  try {
    created = await deps.mall.events.create(userId, {
      ...(id != null ? { id } : {}),
      streamIds: [C.NS_INTERNAL_MEMBERS],
      type: C.ET_MEMBER_LEDGER,
      time: nowSeconds(deps),
      content,
    });
  } catch (err: unknown) {
    if (id == null || !provisioning.isAlreadyExistsError(err)) throw err;
    let holder: Record<string, unknown> | null = null;
    try { holder = deps.mall.events.getOne != null ? await deps.mall.events.getOne(userId, id) : null; } catch (_e) { /* other */ }
    const pairRecord = pairRecordOf(holder, content.membershipAccessId, content.relationshipAccessId);
    return pairRecord != null ? { taken: 'pair', holder: pairRecord } : { taken: 'other' };
  }
  if (typeof created?.id !== 'string') throw new Error('cmc/memberLedger: the ledger write returned no id');
  return { created: created.id };
}

async function updateInPlace (deps: LedgerDeps, userId: string, content: LedgerRecord, existing: StoredLedgerRecord): Promise<string | null> {
  let applied = false;
  await deps.mall.events.updateWithMerge(userId, existing.eventId, (stored) => {
    const current = (stored.content as Partial<LedgerRecord> | null | undefined)?.childAccessId;
    if (current !== existing.childAccessId) return stored;
    applied = true;
    return { ...stored, content, modified: nowSeconds(deps), modifiedBy: C.SYSTEM_ACCESS_ID };
  }, null, { skipVersioning: true });
  return applied ? existing.eventId : null;
}

/**
 * Write a record: in place when `existing` is given (the pair's record is
 * reused for the new child), as a new event at the pair's id otherwise; an
 * `existing` record at a random id moves to the pair's id. Returns the event
 * id, or null when the write did not apply: the stored record no longer
 * names `existing.childAccessId`, or the pair's id holds a record of another
 * child already (another worker recorded the pair meanwhile), so the
 * caller's child is not the pair's and must not be kept. A record there that
 * names the caller's child (two re-asks moving the same record at once) is
 * the write applied.
 */
async function writeRecord (deps: LedgerDeps, userId: string, record: LedgerRecord, existing?: StoredLedgerRecord | null): Promise<string | null> {
  const content: LedgerRecord = { ...record, stateChangedAt: record.stateChangedAt ?? nowSeconds(deps) };
  const pairId = pairEventIdOf(record.membershipAccessId, record.relationshipAccessId);
  if (existing != null && existing.eventId === pairId) return await updateInPlace(deps, userId, content, existing);
  const outcome = await createRecordEvent(deps, userId, content, pairId);
  if ('created' in outcome) {
    if (existing != null) await deleteRecordEvent(deps, userId, existing.eventId);
    return outcome.created;
  }
  if (outcome.taken === 'pair') {
    if (outcome.holder.childAccessId !== record.childAccessId) return null;
    if (existing != null && existing.eventId !== pairId) await deleteRecordEvent(deps, userId, existing.eventId);
    return pairId;
  }
  // The pair's id is held by something else (a record deleted while its
  // membership still asks): kept working at a random id, which a lookup
  // finds by scan (the id read there is not the pair's record).
  deps.logger?.warn?.('cmc/memberLedger: the pair\'s record id is taken; the record is kept at a random id', { userId, eventId: pairId });
  if (existing != null) return await updateInPlace(deps, userId, content, existing);
  forgetScan(deps, userId);
  const displaced = await createRecordEvent(deps, userId, content);
  if (!('created' in displaced)) throw new Error('cmc/memberLedger: the ledger write returned no id');
  return displaced.created;
}

/** Delete one record event; best-effort (a leftover is pruned later). */
async function deleteRecordEvent (deps: LedgerDeps, userId: string, eventId: string): Promise<boolean> {
  const del = deps.mall.events.delete;
  if (del == null) return false;
  try {
    const stored: MallStoredEventLike = { id: eventId, type: C.ET_MEMBER_LEDGER, streamIds: [C.NS_INTERNAL_MEMBERS] };
    await del.call(deps.mall.events, userId, stored);
    return true;
  } catch (err: unknown) {
    deps.logger?.debug?.('cmc/memberLedger: delete failed for a record (kept)', {
      userId, eventId, error: String((err as Error)?.message || err),
    });
    return false;
  }
}

/**
 * Change a record's state (and optionally other fields), only while the
 * stored record still names `expectedChildId` (compare-and-set: a verdict on
 * a child must not land on the child that replaced it meanwhile). Returns
 * whether the change applied.
 */
async function setState (deps: LedgerDeps, userId: string, eventId: string, state: LedgerState, expectedChildId: string, patch: Partial<LedgerRecord> = {}): Promise<boolean> {
  let applied = false;
  await deps.mall.events.updateWithMerge(userId, eventId, (stored) => {
    const content = (stored.content as Record<string, unknown> | null | undefined) ?? {};
    if (content.childAccessId !== expectedChildId) return stored;
    applied = true;
    return {
      ...stored,
      content: { ...content, ...patch, state, stateChangedAt: nowSeconds(deps) },
      modified: nowSeconds(deps),
      modifiedBy: C.SYSTEM_ACCESS_ID,
    };
  }, null, { skipVersioning: true });
  return applied;
}

type PruneOptions = {
  // The records as the caller read them (the periodic pass), instead of a
  // second read of the ledger.
  records?: StoredLedgerRecord[];
  // Whether a membership access can no longer ask (deleted or expired). A
  // record at its pair's id is pruned only then; without it, such records
  // are kept.
  isMembershipGone?: (membershipAccessId: string) => Promise<boolean>;
};

/**
 * Remove the records whose child is gone for good: state not `live` and
 * `expires` in the past, and, for a record at its pair's id, a membership
 * that is gone (see the header). Returns how many were pruned (0 when the
 * mall view has no `delete`).
 */
async function pruneExpired (deps: LedgerDeps, userId: string, options: PruneOptions = {}): Promise<number> {
  if (deps.mall.events.delete == null) return 0;
  const now = nowSeconds(deps);
  let pruned = 0;
  for (const r of options.records ?? await listRecords(deps, userId)) {
    if (r.state === 'live' || !(typeof r.expires === 'number' && r.expires < now)) continue;
    if (isAtPairId(r)) {
      if (options.isMembershipGone == null) continue;
      let gone = false;
      try { gone = await options.isMembershipGone(r.membershipAccessId); } catch (_e) { /* kept */ }
      if (!gone) continue;
    }
    if (await deleteRecordEvent(deps, userId, r.eventId)) pruned += 1;
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
  pairEventIdOf,
  forgetScan,
};
export type { LedgerRecord, StoredLedgerRecord, LedgerState, LedgerDeps, LedgerMall, PruneOptions };
