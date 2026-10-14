/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin, group accounts: a member asks for an access on a patient's
 * account (`consent/member-access-cmc`).
 *
 * The trigger is written on the group account by a membership access, on a
 * scope stream it holds `contribute` on. The group's core holds, for each
 * patient, the consent grant the patient gave (its endpoint is on the
 * relationship access the group keeps for that patient); when that grant is
 * delegable (`accessType: 'app'` in the group's own invite), the group's
 * core creates a `shared` child access on the patient's core through it,
 * bounded by the grant, short-lived, named and attributed by the server, and
 * hands the child's endpoint back ONCE in the synchronous `events.create`
 * response. Nothing on the group account ever holds the child's token.
 *
 * Two layers judge a trigger. `resolveMintTarget` is the authorisation gate
 * (run at write time by `memberAccessHooks.createMemberAccessGateHook`, so a
 * refused ask is an API error, and again here before anything is minted):
 *   1. the writer is a membership access (`role: 'member'`); personal and
 *      delegate tokens are refused too, a member identity comes from the
 *      membership;
 *   2. the scope asked is the trigger's stream or a descendant of it (the
 *      membership holds the trigger's stream; `:_cmc:apps:*` ids encode
 *      their path and every segment is a slug, so a prefix match on `:`
 *      segments is sound), and a relationship with the patient is held
 *      under that scope with a completed handshake (the grant endpoint);
 *   3. the permissions asked are stream permissions, each on a data stream
 *      the group's invite to the patient offered (never a `:_cmc:*` stream)
 *      at a level not above the offered one. The accepted set may be
 *      narrower than the offer: the grant on the patient core is the real
 *      bound, and its `forbidden` answer maps to the same id;
 *   4. `expireAfter` within the per-core bounds (default when absent).
 * The write-time hook adds the per-membership rate limit and the in-flight
 * lock per (membership, relationship) (memberMintRegistry.ts).
 *
 * The mint itself (`handleMemberAccess`), through the grant endpoint, two
 * calls at most under one timeout overall:
 *   - idempotency keyed by the ledger record of (membership, relationship),
 *     never by name: the recorded child is read BY ID through the grant;
 *     live with the permissions asked and not about to expire, it is reused
 *     and its token re-read; otherwise it is deleted and a new one minted;
 *     gone (deleted by the patient, or expired), a new one is minted;
 *   - `accesses.create` with `clientData.cmc = { role: 'member-child',
 *     member }`, which the patient core completes from the grant. A patient
 *     core of an older release refuses any `clientData.cmc` with
 *     `cmc-clientdata-cmc-forbidden`: when `allowNameOnly` is set the mint
 *     is retried once without the stamp and reported `name-only`; any other
 *     refusal is a failure (a bug on this side must never degrade silently);
 *   - the ledger record is written BEFORE the token is returned, then the
 *     membership is re-read: gone meanwhile (a sweep ran), the child is
 *     deleted and the trigger fails.
 * A duplicate-name refusal from the patient core is reported, never answered
 * with a delete: through the grant every member's children are visible and
 * deletable, and a name is the one thing another member could choose.
 *
 * The success payload travels on the dispatch result only; the stored
 * trigger gets `memberAccess` without the token, `member` and
 * `relationshipAccessId`. A failure detail is at most `{ peerErrorId,
 * httpStatus }`: no peer body is ever persisted on a stream every member can
 * read. The mint is never retried from the queue (a token minted on a retry
 * would reach nobody): the handler refuses to run with a retry context.
 */

import * as C from './constants.ts';
import * as outbound from './outbound.ts';
import * as slugMod from './slug.ts';
import * as relationshipKey from './relationshipKey.ts';
import * as ledger from './memberLedger.ts';
import { CmcErrorIds } from './errorIds.ts';
import { createHash } from 'node:crypto';
import { levelCapabilityExcess } from 'business/src/accesses/permissionSet.ts';
import type { PermissionLevel } from 'business/src/types/public.ts';
import type { CmcAccessLike, CmcLogger, MallLike, OutboundDeps, RetryContext } from './_types.ts';
import type { StoredLedgerRecord } from './memberLedger.ts';

type Identity = { username: string; host: string };
type StreamPermissionLike = { streamId: string; level: string };

/** Per-core settings of the mint (`cmc:memberAccess:*`). */
type MemberAccessOptions = {
  defaultTtl: number;
  minTtl: number;
  maxTtl: number;
  allowNameOnly: boolean;
};

function memberAccessOptionsFromConfig (config: { get: (key: string) => unknown }): MemberAccessOptions {
  const d = C.MEMBER_ACCESS_CONFIG_DEFAULTS;
  const num = (key: keyof typeof d): number => {
    const v = config.get('cmc:memberAccess:' + key);
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : (d[key] as number);
  };
  const allow = config.get('cmc:memberAccess:allowNameOnly');
  return {
    defaultTtl: num('defaultTtl'),
    minTtl: num('minTtl'),
    maxTtl: num('maxTtl'),
    allowNameOnly: typeof allow === 'boolean' ? allow : d.allowNameOnly,
  };
}

type MintContent = {
  counterparty?: Identity;
  scopeStreamId?: string;
  permissions?: StreamPermissionLike[];
  expireAfter?: number;
};

/** What the gate resolved, handed to the mint. */
type MintTarget = {
  membershipAccess: CmcAccessLike;
  member: Identity;
  scopeStreamId: string;
  relationshipAccess: CmcAccessLike;
  grantApiEndpoint: string;
  grantDelegable: boolean;
  permissions: StreamPermissionLike[];
  expireAfter: number;
};

type GateFailure = { ok: false; reason: string; detail?: Record<string, unknown> };
type GateResult = { ok: true; target: MintTarget } | GateFailure;

type GateDeps = {
  mall: MallLike;
  options: MemberAccessOptions;
  logger?: CmcLogger;
};

function isUnder (scope: string, root: string): boolean {
  return scope === root || scope.startsWith(root + ':');
}

/** The scope stream a trigger was written on, or null. */
function triggerScopeOf (streamIds: unknown): string | null {
  if (!Array.isArray(streamIds)) return null;
  for (const id of streamIds) {
    if (typeof id === 'string' && C.isUserCreatableStreamId(id)) return id;
  }
  return null;
}

/**
 * The gate (steps 1 to 4 above). `membershipAccess` is the stored access
 * that wrote the trigger (the hook reads it off the request, the handler
 * off storage by the trigger's `createdBy`).
 */
async function resolveMintTarget (params: {
  userId: string;
  membershipAccess: CmcAccessLike | null | undefined;
  triggerStreamIds: unknown;
  content: MintContent | null | undefined;
  deps: GateDeps;
}): Promise<GateResult> {
  const { userId, membershipAccess, triggerStreamIds, deps } = params;
  const content = params.content ?? {};
  const cmc = membershipAccess?.clientData?.cmc;
  // 1. A membership access, nothing else.
  if (membershipAccess == null || cmc?.role !== C.ROLE_MEMBER || typeof membershipAccess.id !== 'string') {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_NOT_MEMBER };
  }
  const member = cmc.counterparty;
  if (typeof member?.username !== 'string' || typeof member?.host !== 'string') {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_NOT_MEMBER, detail: { reason: 'membership-identity-missing' } };
  }

  // 2. Scope and relationship.
  const triggerScope = triggerScopeOf(triggerStreamIds);
  if (triggerScope == null) {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_SCOPE_OUTSIDE_MEMBERSHIP, detail: { reason: 'not-on-a-scope-stream' } };
  }
  const askedScope = typeof content.scopeStreamId === 'string' ? content.scopeStreamId : null;
  if (askedScope != null && !isUnder(askedScope, triggerScope)) {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_SCOPE_OUTSIDE_MEMBERSHIP, detail: { scopeStreamId: askedScope, triggerStreamId: triggerScope } };
  }
  const patient = content.counterparty;
  if (typeof patient?.username !== 'string' || typeof patient?.host !== 'string') {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_RELATIONSHIP_NOT_FOUND, detail: { reason: 'counterparty-missing' } };
  }
  let patientHostSlug: string;
  try {
    patientHostSlug = slugMod.slugifyHost(patient.host);
  } catch (_e) {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_RELATIONSHIP_NOT_FOUND, detail: { reason: 'counterparty-host-invalid' } };
  }
  const all = await deps.mall.accesses.get(userId, {});
  const candidates = (Array.isArray(all) ? all : []).filter((a) => {
    const c = a?.clientData?.cmc;
    if (c?.role !== C.ROLE_COUNTERPARTY) return false;
    const cp = c.counterparty;
    if (cp?.username !== patient.username || typeof cp.host !== 'string') return false;
    try { if (slugMod.slugifyHost(cp.host) !== patientHostSlug) return false; } catch (_e) { return false; }
    const scope = relationshipKey.scopeOfAccess(a);
    if (scope == null) return false;
    return askedScope != null ? scope === askedScope : isUnder(scope, triggerScope);
  });
  if (candidates.length === 0) {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_RELATIONSHIP_NOT_FOUND, detail: { scopeStreamId: askedScope ?? triggerScope } };
  }
  // The newest relationship whose handshake completed (it knows the grant).
  const withEndpoint = candidates.filter((a) => typeof a.clientData?.cmc?.counterparty?.apiEndpoint === 'string');
  if (withEndpoint.length === 0) {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_RELATIONSHIP_NOT_FOUND, detail: { reason: 'handshake-incomplete', relationshipAccessId: candidates[0].id } };
  }
  withEndpoint.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const relationshipAccess = withEndpoint[0];
  const relCmc = relationshipAccess.clientData!.cmc!;
  const grantApiEndpoint = relCmc.counterparty!.apiEndpoint as string;
  const scopeStreamId = relationshipKey.scopeOfAccess(relationshipAccess) as string;

  // 3. The bound: what the group offered the patient.
  const offer = await readOffer(deps.mall, userId, [relCmc.inviteEventId, relCmc.offerEventId]);
  if (offer == null) {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET, detail: { reason: 'offer-not-found', relationshipAccessId: relationshipAccess.id } };
  }
  const bound = offeredDataPermissions(offer);
  const grantDelegable = (offer.request as { accessType?: unknown } | undefined)?.accessType === 'app';
  const permissions: StreamPermissionLike[] = Array.isArray(content.permissions) && content.permissions.length > 0
    ? content.permissions
    : bound.map((p) => ({ streamId: p.streamId, level: 'read' }));
  if (permissions.length === 0) {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET, detail: { reason: 'offer-has-no-data-stream' } };
  }
  for (const p of permissions) {
    if (typeof p?.streamId !== 'string' || typeof p?.level !== 'string' || C.isCmcStreamId(p.streamId)) {
      return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET, detail: { streamId: (p as { streamId?: unknown })?.streamId } };
    }
    const offered = bound.find((o) => o.streamId === p.streamId);
    if (offered == null || levelCapabilityExcess(p.level as PermissionLevel, offered.level as PermissionLevel).length > 0) {
      return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET, detail: { streamId: p.streamId, level: p.level } };
    }
  }

  // 4. Lifetime.
  const expireAfter = typeof content.expireAfter === 'number' ? content.expireAfter : deps.options.defaultTtl;
  if (!(expireAfter >= deps.options.minTtl && expireAfter <= deps.options.maxTtl)) {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_EXPIRY_OUT_OF_RANGE, detail: { expireAfter, minTtl: deps.options.minTtl, maxTtl: deps.options.maxTtl } };
  }

  return {
    ok: true,
    target: {
      membershipAccess,
      member: { username: member.username, host: member.host },
      scopeStreamId,
      relationshipAccess,
      grantApiEndpoint,
      grantDelegable,
      permissions: permissions.map((p) => ({ streamId: p.streamId, level: p.level })),
      expireAfter,
    },
  };
}

type OfferContent = { request?: { permissions?: unknown; accessType?: unknown } };

/** The group's own invite to the patient, by the ids the relationship access carries. */
async function readOffer (mall: MallLike, userId: string, ids: unknown[]): Promise<OfferContent | null> {
  if (mall.events?.getOne == null) return null;
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) continue;
    try {
      const ev = await mall.events.getOne(userId, id);
      if (ev != null && ev.type === C.ET_REQUEST && ev.content != null && typeof ev.content === 'object') {
        return ev.content as OfferContent;
      }
    } catch (_e) { /* next id */ }
  }
  return null;
}

/** The offer's stream permissions outside the `:_cmc:` namespace. */
function offeredDataPermissions (offer: OfferContent): StreamPermissionLike[] {
  const perms = offer.request?.permissions;
  if (!Array.isArray(perms)) return [];
  const out: StreamPermissionLike[] = [];
  for (const p of perms) {
    if (p == null || typeof p !== 'object') continue;
    const { streamId, level } = p as { streamId?: unknown; level?: unknown };
    if (typeof streamId !== 'string' || typeof level !== 'string' || C.isCmcStreamId(streamId)) continue;
    out.push({ streamId, level });
  }
  return out;
}

// ---------------------------------------------------------------- the mint

/** The server-derived child name: collision-free across groups, teams and re-minted memberships. */
function childNameFor (member: Identity, membershipAccessId: string, relationshipAccessId: string): string {
  const hash = createHash('sha1').update(membershipAccessId + ':' + relationshipAccessId).digest('hex').slice(0, 12);
  return 'cmc-member--' + slugMod.counterpartySlug(member) + '--' + hash;
}

/** The child's own endpoint: the patient core's base with the child's token. */
function childApiEndpoint (grantApiEndpoint: string, token: string): string {
  const { base } = outbound.parseApiEndpoint(grantApiEndpoint);
  const u = new URL(base);
  u.username = token;
  return u.toString();
}

type PeerAccess = { id?: string; token?: string; name?: string; expires?: number | null; permissions?: StreamPermissionLike[]; clientData?: Record<string, unknown> };

function peerErrorIdOf (body: unknown): string | undefined {
  const err = (body as { error?: { id?: unknown; data?: { id?: unknown } } } | null | undefined)?.error;
  const inner = err?.data?.id;
  if (typeof inner === 'string') return inner;
  return typeof err?.id === 'string' ? err.id : undefined;
}

/** The success payload, returned once, and what the trigger records. */
type MemberAccessPayload = {
  apiEndpoint: string;
  accessId: string;
  name: string;
  expires: number;
  attribution: string;
};

type MemberAccessResult =
  | {
      ok: true;
      response: MemberAccessPayload;
      memberAccess: { accessId: string; name: string; expires: number; attribution: string };
      member: Identity;
      relationshipAccessId: string;
    }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

type HandlerDeps = OutboundDeps & {
  mall: MallLike;
  memberAccess: MemberAccessOptions;
  retryContext?: RetryContext;
  // The writing access on a live dispatch (its id names the membership).
  triggerAccess?: { id?: string };
  now?: () => number;
};

function accessIdOf (createdBy: unknown): string | null {
  if (typeof createdBy !== 'string' || createdBy.length === 0) return null;
  const sep = createdBy.indexOf(' ');
  return sep === -1 ? createdBy : createdBy.slice(0, sep);
}

async function findAccessById (mall: MallLike, userId: string, accessId: string): Promise<CmcAccessLike | null> {
  if (mall.accesses.getOne != null) return await mall.accesses.getOne(userId, { id: accessId });
  const list = await mall.accesses.get(userId, {});
  return (Array.isArray(list) ? list : []).find((a) => a?.id === accessId) ?? null;
}

/** True when every permission asked is on the child as stored. */
function childCarries (child: PeerAccess, permissions: StreamPermissionLike[]): boolean {
  const have = new Set((child.permissions ?? []).map((p) => p?.streamId + '|' + p?.level));
  return permissions.every((p) => have.has(p.streamId + '|' + p.level));
}

const REUSE_MIN_REMAINING_S = 300;

async function handleMemberAccess (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: Record<string, unknown>; streamIds?: string[]; createdBy?: string };
  selfIdentity: Identity;
  deps: HandlerDeps;
}): Promise<MemberAccessResult> {
  const { userId, triggerEvent, deps } = params;
  const { mall } = deps;
  const now = deps.now ?? (() => Date.now() / 1000);

  if (triggerEvent.type !== C.ET_MEMBER_ACCESS) {
    return { ok: false, reason: CmcErrorIds.HANDLER_WRONG_TYPE, detail: { type: triggerEvent.type } };
  }
  // Never from the retry queue: the token would reach nobody.
  if (deps.retryContext != null) {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_NOT_RETRYABLE };
  }

  // The membership that wrote the trigger, as stored.
  const membershipAccessId = (typeof deps.triggerAccess?.id === 'string' && deps.triggerAccess.id.length > 0)
    ? deps.triggerAccess.id
    : accessIdOf(triggerEvent.createdBy);
  const membershipAccess = membershipAccessId == null ? null : await findAccessById(mall, userId, membershipAccessId);
  const gate = await resolveMintTarget({
    userId,
    membershipAccess,
    triggerStreamIds: triggerEvent.streamIds,
    content: triggerEvent.content as MintContent,
    deps: { mall, options: deps.memberAccess, logger: deps.logger },
  });
  if (!gate.ok) return gate;
  const t = gate.target;
  const relationshipAccessId = t.relationshipAccess.id;
  const member = t.member;
  if (!t.grantDelegable) {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_GRANT_NOT_DELEGABLE, detail: { relationshipAccessId } };
  }

  // One timeout overall for the (at most) two peer calls.
  const timeoutMs = deps.timeoutMs ?? outbound.DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const peerDeps = (): OutboundDeps => ({
    fetch: deps.fetch,
    logger: deps.logger,
    timeoutMs: Math.max(1, deadline - Date.now()),
  });
  const peerFailure = (r: outbound.DeliverResult): MemberAccessResult => {
    if (r.ok) throw new Error('not a failure');
    if (r.reason === 'http-4xx') {
      const peerErrorId = peerErrorIdOf(r.body);
      // The grant on the patient core is the real bound of the permissions.
      if (r.status === 403 && peerErrorId === 'forbidden') {
        return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_PERMISSIONS_NOT_SUBSET, detail: { peerErrorId, httpStatus: r.status } };
      }
      return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_PEER_REJECTED, detail: { peerErrorId, httpStatus: r.status } };
    }
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_PEER_UNREACHABLE, detail: { httpStatus: r.status || undefined, reason: r.reason } };
  };
  const ledgerDeps = { mall, logger: deps.logger, now };

  // (1) Idempotency: the pair's record, verified by id on the patient core.
  const record: StoredLedgerRecord | null = await ledger.findRecord(ledgerDeps, userId, t.membershipAccess.id, relationshipAccessId);
  if (record != null && record.state === 'live') {
    let read: outbound.DeliverResult;
    try {
      read = await outbound.requestPeer({ apiEndpoint: t.grantApiEndpoint, method: 'GET', path: 'accesses/' + encodeURIComponent(record.childAccessId), deps: peerDeps() });
    } catch (err: unknown) {
      return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_PEER_UNREACHABLE, detail: { reason: String((err as Error)?.message || err) } };
    }
    if (read.ok) {
      const child = ((read.body as { access?: PeerAccess } | null)?.access) ?? null;
      const remaining = typeof child?.expires === 'number' ? child.expires - now() : Infinity;
      if (child?.id != null && typeof child.token === 'string' && remaining > REUSE_MIN_REMAINING_S && childCarries(child, t.permissions)) {
        return await finish({ id: child.id, token: child.token, name: child.name ?? record.childName, expires: typeof child.expires === 'number' ? child.expires : record.expires, attribution: record.attribution });
      }
      // Stale: about to expire, or not the permissions asked. Deleted, then re-minted.
      if (child?.id != null) {
        try {
          await outbound.requestPeer({ apiEndpoint: t.grantApiEndpoint, method: 'DELETE', path: 'accesses/' + encodeURIComponent(child.id), deps: peerDeps() });
        } catch (err: unknown) {
          deps.logger?.debug?.('cmc/handleMemberAccess: stale child delete threw (re-minting anyway)', { error: String((err as Error)?.message || err) });
        }
        await ledger.setState(ledgerDeps, userId, record.eventId, 'deleted');
      }
    } else if (read.reason === 'http-4xx' && read.status === 404) {
      // Deleted by the patient, or expired: a new one is minted while the grant lasts.
      await ledger.setState(ledgerDeps, userId, record.eventId, 'absent');
    } else {
      return peerFailure(read);
    }
  }

  // (2) Mint.
  const name = childNameFor(member, t.membershipAccess.id, relationshipAccessId);
  const body: Record<string, unknown> = {
    type: 'shared',
    name,
    permissions: t.permissions,
    expireAfter: t.expireAfter,
    clientData: { cmc: { role: C.ROLE_MEMBER_CHILD, member: { username: member.username, host: member.host } } },
  };
  let attribution = C.MEMBER_ATTRIBUTION_STAMPED;
  let created: outbound.DeliverResult;
  try {
    created = await outbound.requestPeer({ apiEndpoint: t.grantApiEndpoint, method: 'POST', path: 'accesses', body, deps: peerDeps() });
  } catch (err: unknown) {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_PEER_UNREACHABLE, detail: { reason: String((err as Error)?.message || err) } };
  }
  if (!created.ok && created.reason === 'http-4xx' && peerErrorIdOf(created.body) === CmcErrorIds.CLIENTDATA_CMC_FORBIDDEN) {
    // An older patient core: it refuses every `clientData.cmc`. Exact
    // detection: a new core answers `cmc-member-stamp-invalid` to a bad
    // stamp, which is a failure here.
    if (!deps.memberAccess.allowNameOnly) {
      return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_PEER_REJECTED, detail: { peerErrorId: CmcErrorIds.CLIENTDATA_CMC_FORBIDDEN, httpStatus: created.status } };
    }
    delete body.clientData;
    attribution = C.MEMBER_ATTRIBUTION_NAME_ONLY;
    try {
      created = await outbound.requestPeer({ apiEndpoint: t.grantApiEndpoint, method: 'POST', path: 'accesses', body, deps: peerDeps() });
    } catch (err: unknown) {
      return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_PEER_UNREACHABLE, detail: { reason: String((err as Error)?.message || err) } };
    }
  }
  if (!created.ok) return peerFailure(created);
  const child = ((created.body as { access?: PeerAccess } | null)?.access) ?? null;
  if (child?.id == null || typeof child.token !== 'string') {
    return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_PEER_REJECTED, detail: { reason: 'no-access-in-answer', httpStatus: created.status } };
  }
  const expires = typeof child.expires === 'number' ? child.expires : now() + t.expireAfter;
  return await finish({ id: child.id, token: child.token, name: child.name ?? name, expires, attribution });

  /**
   * The ledger record first, then the membership re-read, then the token.
   */
  async function finish (child: { id: string; token: string; name: string; expires: number; attribution: string }): Promise<MemberAccessResult> {
    await ledger.writeRecord(ledgerDeps, userId, {
      membershipAccessId: t.membershipAccess.id,
      member,
      relationshipAccessId,
      counterparty: { username: t.relationshipAccess.clientData!.cmc!.counterparty!.username as string, host: t.relationshipAccess.clientData!.cmc!.counterparty!.host as string },
      scopeStreamId: t.scopeStreamId,
      childAccessId: child.id,
      childName: child.name,
      expires: child.expires,
      attribution: child.attribution,
      state: 'live',
      stateChangedAt: now(),
    }, record);
    // A sweep that ran meanwhile deleted the membership: the child goes too.
    const still = await findAccessById(mall, userId, t.membershipAccess.id);
    if (still == null) {
      try {
        await outbound.requestPeer({ apiEndpoint: t.grantApiEndpoint, method: 'DELETE', path: 'accesses/' + encodeURIComponent(child.id), deps: peerDeps() });
        const rec = await ledger.findRecord(ledgerDeps, userId, t.membershipAccess.id, relationshipAccessId);
        if (rec != null) await ledger.setState(ledgerDeps, userId, rec.eventId, 'deleted');
      } catch (err: unknown) {
        deps.logger?.warn?.('cmc/handleMemberAccess: the membership ended during the mint and the child could not be deleted; the sweep will', {
          childAccessId: child.id, error: String((err as Error)?.message || err),
        });
      }
      return { ok: false, reason: CmcErrorIds.MEMBER_ACCESS_MEMBERSHIP_GONE, detail: { membershipAccessId: t.membershipAccess.id } };
    }
    return {
      ok: true,
      response: { apiEndpoint: childApiEndpoint(t.grantApiEndpoint, child.token), accessId: child.id, name: child.name, expires: child.expires, attribution: child.attribution },
      memberAccess: { accessId: child.id, name: child.name, expires: child.expires, attribution: child.attribution },
      member,
      relationshipAccessId,
    };
  }
}

export {
  handleMemberAccess,
  resolveMintTarget,
  memberAccessOptionsFromConfig,
  childNameFor,
  childApiEndpoint,
  triggerScopeOf,
};
export type { MemberAccessOptions, MintTarget, MemberAccessPayload, MemberAccessResult };
