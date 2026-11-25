/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin, group accounts: offboarding a member
 * (`consent/member-revoke-cmc`).
 *
 * The server writes the trigger on the group's scope stream when a
 * membership ends (memberSweep.ts names every path); the trigger carries the
 * ledger records of that membership, and this handler deletes each child on
 * its patient's core through the relationship grant:
 *
 *   - a child the patient core deletes is `deleted`; one it no longer has
 *     (404) is `absent`; anything else (a 5xx, a network error, a timeout, an
 *     unexpected refusal, a grant whose token no longer authenticates) is a
 *     `residual`; a child made through a former grant of the relationship
 *     (its record names another grant) is not tried: `residual`,
 *     `grant-replaced`;
 *   - after the pass the grant's accesses are read back with `includeExpired`
 *     so a deletion the patient core did not apply is caught, and a residual
 *     this grant is known to have made and no longer lists is `absent`;
 *   - the ledger is re-read at the end and records added meanwhile (a mint
 *     that raced the revoke) are swept in the same run;
 *   - the outcome per child and the residuals are stamped on the trigger;
 *     with a residual the trigger fails with `cmc-member-revoke-residual`
 *     (retryable: the queue re-dispatches the snapshot, and records already
 *     settled in the ledger are skipped), and the child's own expiry bounds
 *     the residual's life when a patient core stays down.
 *
 * No peer body is ever persisted: a failure detail is at most
 * `{ childAccessId, peerErrorId, httpStatus }`.
 */

import * as C from './constants.ts';
import * as outbound from './outbound.ts';
import * as ledger from './memberLedger.ts';
import { coveredScopesOf } from './accessesUpdateHook.ts';
import { CmcErrorIds } from './errorIds.ts';
import type { CmcLogger, MallLike, OutboundDeps } from './_types.ts';
import type { StoredLedgerRecord } from './memberLedger.ts';

type Identity = { username: string; host: string };

type SweepRecordInput = { relationshipAccessId: string; counterparty: Identity; childAccessId: string; expires: number };

type Outcome = { childAccessId: string; result: 'deleted' | 'absent' | 'residual'; reason?: string };
type Residual = { counterparty: Identity; childAccessId: string; expires: number; reason: string };

type RevokeDeps = OutboundDeps & { mall: MallLike; now?: () => number };

/** How the patient core answered one child's deletion. */
type ChildVerdict = { result: 'deleted' | 'absent' | 'residual'; reason?: string; peerErrorId?: string; httpStatus?: number; retryAfterMs?: number };

function peerErrorIdOf (body: unknown): string | undefined {
  const err = (body as { error?: { id?: unknown; data?: { id?: unknown } } } | null | undefined)?.error;
  const inner = err?.data?.id;
  if (typeof inner === 'string') return inner;
  return typeof err?.id === 'string' ? err.id : undefined;
}

/** Delete one child through the grant and classify the answer. */
async function deleteChildThroughGrant (grantApiEndpoint: string, childAccessId: string, deps: OutboundDeps): Promise<ChildVerdict> {
  let r: outbound.DeliverResult;
  try {
    r = await outbound.requestPeer({ apiEndpoint: grantApiEndpoint, method: 'DELETE', path: 'accesses/' + encodeURIComponent(childAccessId), deps });
  } catch (_e) {
    // Only the endpoint parser can throw here (requestPeer catches its own
    // errors); no message is recorded: `peerErrorId` names a peer's answer.
    return { result: 'residual', reason: 'network' };
  }
  if (r.ok) return { result: 'deleted' };
  if (r.reason === 'http-4xx') {
    const peerErrorId = peerErrorIdOf(r.body);
    if (r.status === 404 || peerErrorId === 'unknown-resource') return { result: 'absent', reason: 'not-found' };
    // The grant no longer authenticates. A patient core of this release took
    // the children with the grant; one without that cascade leaves them until
    // their own expiry, and nothing on this side can tell the two apart (no
    // call reaches the child any more). Not settled as gone: a residual,
    // bounded by the child's expiry.
    if (r.status === 401 || (r.status === 403 && peerErrorId === 'invalid-access-token')) {
      return { result: 'residual', reason: 'grant-gone', peerErrorId, httpStatus: r.status };
    }
    return { result: 'residual', reason: 'peer-rejected', peerErrorId, httpStatus: r.status };
  }
  // A 408 / 429 keeps its Retry-After: the queued retry of the trigger waits for it.
  const retryAfterMs = outbound.retryAfterOf(r);
  return { result: 'residual', reason: r.reason, httpStatus: r.status || undefined, ...(retryAfterMs != null ? { retryAfterMs } : {}) };
}

/**
 * The ids of the accesses the grant still lists (expired included), or null
 * when the read failed (nothing can be concluded).
 */
async function childrenStillOnGrant (grantApiEndpoint: string, deps: OutboundDeps): Promise<Set<string> | null> {
  try {
    const r = await outbound.requestPeer({ apiEndpoint: grantApiEndpoint, method: 'GET', path: 'accesses?includeExpired=true', deps });
    if (!r.ok) return null;
    const list = (r.body as { accesses?: Array<{ id?: unknown }> } | null)?.accesses;
    if (!Array.isArray(list)) return null;
    return new Set(list.map((a) => a?.id).filter((id): id is string => typeof id === 'string'));
  } catch (_e) {
    return null;
  }
}

/**
 * Sweep a set of ledger records through their grants and settle each one's
 * state. Shared by the membership sweep (this handler) and the relationship
 * end (memberSweep.sweepRelationship). Records already settled (`deleted` or
 * `absent`) are skipped.
 *
 * A record names the grant that made its child (`grantKey`). A record of
 * another grant than the relationship's current one is not sent to the
 * patient's core at all (the current grant can neither see nor delete that
 * child): it stays `residual` / `grant-replaced` until its expiry. A record
 * without a key (written before the key existed) is tried through the
 * current grant, and only a definite answer settles it.
 *
 * Rule for the read-back (the grant's own list): "not listed" is evidence of
 * a deletion only for a child this grant is known to have made, and never
 * overturns a refusal (`peer-rejected`: the patient's core said the child
 * exists and is not this grant's).
 *
 * `track: false` (records the ledger no longer holds, from a sweep
 * trigger's snapshot): the same verdicts, nothing written to the ledger.
 */
async function revokeRecords (params: {
  userId: string;
  records: StoredLedgerRecord[];
  deps: RevokeDeps;
  track?: boolean;
}): Promise<{ outcome: Outcome[]; residuals: Residual[]; firstResidual?: ChildVerdict & { childAccessId: string }; retryAfterMs?: number }> {
  const { userId, records, deps } = params;
  const track = params.track !== false;
  const now = deps.now ?? (() => Date.now() / 1000);
  const ledgerDeps = { mall: deps.mall, logger: deps.logger, now };
  const peerDeps: OutboundDeps = { fetch: deps.fetch, timeoutMs: deps.timeoutMs, logger: deps.logger };
  const outcome: Outcome[] = [];
  const residuals: Residual[] = [];
  let firstResidual: (ChildVerdict & { childAccessId: string }) | undefined;

  // The grant of each relationship, read once. Three outcomes: the endpoint;
  // `gone` (no such live access, or one without an endpoint); `unreadable`
  // (the read failed: nothing can be concluded, the record stays residual
  // and is retried).
  type GrantLookup = { endpoint: string } | { endpoint: null; why: 'gone' | 'unreadable' };
  const grants = new Map<string, GrantLookup>();
  async function grantOf (relationshipAccessId: string): Promise<GrantLookup> {
    const cached = grants.get(relationshipAccessId);
    if (cached != null) return cached;
    let lookup: GrantLookup;
    try {
      const rel = deps.mall.accesses.getOne != null
        ? await deps.mall.accesses.getOne(userId, { id: relationshipAccessId })
        : (await deps.mall.accesses.get(userId, {})).find((a) => a?.id === relationshipAccessId) ?? null;
      const ep = rel?.clientData?.cmc?.counterparty?.apiEndpoint;
      lookup = typeof ep === 'string' && ep.length > 0 ? { endpoint: ep } : { endpoint: null, why: 'gone' };
    } catch (_e) {
      lookup = { endpoint: null, why: 'unreadable' };
    }
    grants.set(relationshipAccessId, lookup);
    return lookup;
  }

  // `known`: the child is known to be the current grant's (its record carries
  // that grant's key), so the grant's own list is evidence about it.
  const verdicts = new Map<string, { record: StoredLedgerRecord; verdict: ChildVerdict; grant: string | null; known: boolean }>();
  for (const record of records) {
    if (record.state === 'deleted' || record.state === 'absent') continue;
    const lookup = await grantOf(record.relationshipAccessId);
    const grant = lookup.endpoint;
    const key = grant != null ? ledger.grantKeyOf(grant) : null;
    let verdict: ChildVerdict;
    if (grant == null && lookup.why === 'unreadable') {
      verdict = { result: 'residual', reason: 'relationship-unreadable' };
    } else if (typeof record.expires === 'number' && record.expires < now()) {
      verdict = { result: 'absent', reason: 'expired' };
    } else if (ledger.isUnreachableResidual(record)) {
      // Already known to be a child of a former grant, or of an unknown grant
      // of a relationship the patient ended (whatever became of the
      // relationship since): the end of the relationship's current grant says
      // nothing about it. No call; its expiry bounds it.
      verdict = { result: 'residual', reason: record.residualReason };
    } else if (grant == null) {
      // The relationship ended on this side: its grant was revoked and the
      // patient core took the children with it (a core of an older release
      // leaves them until their own expiry; nothing can reach them any more).
      verdict = { result: 'absent', reason: 'relationship-gone' };
    } else if (ledger.isOfOtherGrant(record, key)) {
      // Made through a former grant of the relationship: the current one can
      // neither see nor delete it. No call; its expiry bounds it.
      verdict = { result: 'residual', reason: ledger.GRANT_REPLACED };
    } else {
      verdict = await deleteChildThroughGrant(grant!, record.childAccessId, peerDeps);
    }
    verdicts.set(track ? record.eventId : 'untracked:' + record.childAccessId, { record, verdict, grant, known: key != null && record.grantKey === key });
  }

  // Read-back per grant: a deletion the core did not apply is a residual; a
  // residual the grant no longer lists is absent, for a child this grant is
  // known to have made only, and never after a refusal.
  const readBacks = new Map<string, Set<string> | null>();
  for (const [, v] of verdicts) {
    if (v.grant == null || v.verdict.result === 'absent' || UNREACHABLE_REASONS.has(v.verdict.reason ?? '')) continue;
    if (!readBacks.has(v.grant)) readBacks.set(v.grant, await childrenStillOnGrant(v.grant, peerDeps));
    const still = readBacks.get(v.grant);
    if (still == null) continue;
    if (!still.has(v.record.childAccessId)) {
      if (v.verdict.result === 'residual' && v.known && v.verdict.reason !== 'peer-rejected' && v.verdict.reason !== 'grant-gone') {
        v.verdict = { result: 'absent', reason: 'not-listed' };
      }
    } else if (v.verdict.result === 'deleted') {
      v.verdict = { result: 'residual', reason: 'still-listed' };
    }
  }

  for (const [, v] of verdicts) {
    const { record, verdict } = v;
    outcome.push({ childAccessId: record.childAccessId, result: verdict.result, ...(verdict.reason != null ? { reason: verdict.reason } : {}) });
    if (verdict.result === 'residual') {
      residuals.push({ counterparty: record.counterparty, childAccessId: record.childAccessId, expires: record.expires, reason: verdict.reason ?? 'unknown' });
      if (firstResidual == null) firstResidual = { ...verdict, childAccessId: record.childAccessId };
    }
    if (!track) continue;
    const unreachable = verdict.result === 'residual' && UNREACHABLE_REASONS.has(verdict.reason ?? '');
    // Nothing changed: not written again (a write moves `stateChangedAt`).
    if (unreachable && record.state === 'residual' && record.residualReason === verdict.reason) continue;
    try {
      const patch = unreachable ? { residualReason: verdict.reason } : {};
      const applied = await ledger.setState(ledgerDeps, userId, record.eventId, verdict.result, record.childAccessId, patch);
      if (!applied) {
        deps.logger?.info?.('cmc/handleMemberRevoke: the record was taken by a newer child meanwhile; verdict not applied', {
          eventId: record.eventId, childAccessId: record.childAccessId,
        });
      }
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/handleMemberRevoke: ledger state write failed', {
        eventId: record.eventId, error: String((err as Error)?.message || err),
      });
    }
  }
  // The longest Retry-After any residual's peer asked for.
  let retryAfterMs: number | undefined;
  for (const [, v] of verdicts) {
    if (v.verdict.result === 'residual' && v.verdict.retryAfterMs != null) retryAfterMs = Math.max(retryAfterMs ?? 0, v.verdict.retryAfterMs);
  }
  return { outcome, residuals, firstResidual, ...(retryAfterMs != null ? { retryAfterMs } : {}) };
}

type MemberRevokeResult =
  | { ok: true; outcome: Outcome[]; residuals: Residual[] }
  | { ok: false; reason: string; detail?: { childAccessId?: string; peerErrorId?: string; httpStatus?: number; retryAfterMs?: number }; outcome: Outcome[]; residuals: Residual[] };

const MAX_PASSES = 3;

// Residual reasons no call can settle (memberLedger.isUnreachableResidual).
const UNREACHABLE_REASONS: ReadonlySet<string> = new Set([ledger.GRANT_REPLACED, ledger.GRANT_UNKNOWN]);

/** A sweep snapshot entry the ledger no longer holds, in the shape `revokeRecords` takes (never written). */
function untrackedRecordOf (s: SweepRecordInput, membershipAccessId: string | null): StoredLedgerRecord {
  return {
    eventId: '',
    membershipAccessId: membershipAccessId ?? '',
    member: { username: 'unknown', host: 'unknown' },
    relationshipAccessId: s.relationshipAccessId,
    counterparty: s.counterparty,
    scopeStreamId: '',
    childAccessId: s.childAccessId,
    childName: '',
    expires: s.expires,
    attribution: '',
    state: 'live',
    stateChangedAt: 0,
  };
}

async function handleMemberRevoke (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: Record<string, unknown>; streamIds?: string[] };
  deps: RevokeDeps & { logger?: CmcLogger };
}): Promise<MemberRevokeResult> {
  const { userId, triggerEvent, deps } = params;
  if (triggerEvent.type !== C.ET_MEMBER_REVOKE) {
    return { ok: false, reason: CmcErrorIds.HANDLER_WRONG_TYPE, outcome: [], residuals: [] };
  }
  const content = triggerEvent.content ?? {};
  const membershipAccessId = typeof content.membershipAccessId === 'string' ? content.membershipAccessId : null;
  const snapshot = Array.isArray(content.records) ? content.records as SweepRecordInput[] : [];
  const ledgerDeps = { mall: deps.mall, logger: deps.logger, now: deps.now };

  // The records to sweep: the trigger's snapshot resolved against the ledger
  // (its state is the truth), plus whatever the ledger holds live for this
  // membership that the snapshot missed (a mint that raced the revoke);
  // re-read after each pass. A `narrowed` sweep ends the membership for the
  // relationships its snapshot names only: a record under a scope the
  // membership still covers is not its business.
  const limitTo = content.reason === 'narrowed'
    ? new Set(snapshot.map((s) => s.relationshipAccessId))
    : null;
  // A narrowed membership judged at handling time, not only from the
  // snapshot: a membership widened again since (or a mint that passed the
  // gate after the narrowing) keeps what the live membership still covers.
  let stillCovered: string[] | null = null;
  if (limitTo != null && membershipAccessId != null) {
    try {
      const membership = deps.mall.accesses.getOne != null
        ? await deps.mall.accesses.getOne(userId, { id: membershipAccessId })
        : (await deps.mall.accesses.get(userId, {})).find((a) => a?.id === membershipAccessId) ?? null;
      if (membership != null && Array.isArray(membership.permissions)) stillCovered = coveredScopesOf(membership);
    } catch (_e) { /* judged from the snapshot */ }
  }
  // Scopes the trigger says are gone whatever the membership still names
  // (a team stream deleted: the membership's permission still names it).
  const uncovered = Array.isArray(content.uncovered) ? content.uncovered.filter((s): s is string => typeof s === 'string') : [];
  const coveredNow = (scope: unknown): boolean =>
    stillCovered != null && typeof scope === 'string' &&
    !uncovered.some((u) => scope === u || scope.startsWith(u + ':')) &&
    stillCovered.some((s) => scope === s || scope.startsWith(s + ':'));
  const settled = new Set<string>();
  // Children a narrowed sweep keeps: the live membership covers their scope.
  const kept = new Set<string>();
  const outcome: Outcome[] = [];
  const residuals: Residual[] = [];
  let firstResidual: (ChildVerdict & { childAccessId: string }) | undefined;
  let retryAfterMs: number | undefined;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const all = membershipAccessId == null ? [] : await ledger.recordsOfMembership(ledgerDeps, userId, membershipAccessId);
    const wanted = all.filter((r) => {
      if (settled.has(r.eventId) || (r.state !== 'live' && r.state !== 'residual')) return false;
      if (limitTo == null) return true;
      if (!limitTo.has(r.relationshipAccessId)) return false;
      if (coveredNow(r.scopeStreamId)) { kept.add(r.childAccessId); return false; }
      return true;
    });
    if (wanted.length === 0) break;
    const r = await revokeRecords({ userId, records: wanted, deps });
    for (const w of wanted) settled.add(w.eventId);
    outcome.push(...r.outcome);
    residuals.push(...r.residuals);
    if (firstResidual == null) firstResidual = r.firstResidual;
    if (r.retryAfterMs != null) retryAfterMs = Math.max(retryAfterMs ?? 0, r.retryAfterMs);
  }
  // Snapshot records the ledger no longer has, so the trigger's record is
  // complete. Past its expiry the child is gone whatever happened to its
  // record (pruned between the write and a retry): `absent`. Before it, the
  // missing record proves nothing about the child: it is deleted through the
  // relationship's grant like a record without a key, nothing written to the
  // ledger, and only a definite answer settles it.
  const unaccounted = snapshot.filter((s) => !kept.has(s.childAccessId) && !outcome.some((o) => o.childAccessId === s.childAccessId));
  const nowS = (deps.now ?? (() => Date.now() / 1000))();
  const toCheck: StoredLedgerRecord[] = [];
  for (const s of unaccounted) {
    if (typeof s.expires === 'number' && s.expires < nowS) {
      outcome.push({ childAccessId: s.childAccessId, result: 'absent', reason: 'not-in-ledger' });
    } else if (typeof s.relationshipAccessId === 'string' && typeof s.childAccessId === 'string') {
      toCheck.push(untrackedRecordOf(s, membershipAccessId));
    }
  }
  if (toCheck.length > 0) {
    const r = await revokeRecords({ userId, records: toCheck, deps, track: false });
    outcome.push(...r.outcome);
    residuals.push(...r.residuals);
    if (firstResidual == null) firstResidual = r.firstResidual;
    if (r.retryAfterMs != null) retryAfterMs = Math.max(retryAfterMs ?? 0, r.retryAfterMs);
  }

  // The outcome on the trigger, whatever the status the dispatch stamps next.
  if (triggerEvent.id != null && deps.mall.events.updateWithMerge != null) {
    try {
      const now = deps.now ?? (() => Date.now() / 1000);
      await deps.mall.events.updateWithMerge(userId, triggerEvent.id, (stored) => ({
        ...stored,
        content: { ...((stored.content as Record<string, unknown> | null | undefined) ?? {}), outcome, residuals },
        modified: now(),
        modifiedBy: C.SYSTEM_ACCESS_ID,
      }), null, { skipVersioning: true });
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/handleMemberRevoke: could not stamp the outcome on the trigger', {
        eventId: triggerEvent.id, error: String((err as Error)?.message || err),
      });
    }
  }

  if (residuals.length > 0) {
    deps.logger?.warn?.('cmc/handleMemberRevoke: a sweep left residual member accesses on patient cores', {
      membershipAccessId, residuals: residuals.map((r) => r.childAccessId),
    });
    return {
      ok: false,
      reason: CmcErrorIds.MEMBER_REVOKE_RESIDUAL,
      detail: {
        childAccessId: firstResidual?.childAccessId,
        ...(firstResidual?.peerErrorId != null ? { peerErrorId: firstResidual.peerErrorId } : {}),
        ...(firstResidual?.httpStatus != null ? { httpStatus: firstResidual.httpStatus } : {}),
        ...(retryAfterMs != null ? { retryAfterMs } : {}),
      },
      outcome,
      residuals,
    };
  }
  return { ok: true, outcome, residuals };
}

export { handleMemberRevoke, revokeRecords, deleteChildThroughGrant };
export type { Outcome, Residual, MemberRevokeResult, RevokeDeps };
