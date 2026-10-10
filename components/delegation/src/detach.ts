/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account-delegation plugin — authoritative teardown (detach) + mirror
 * reconciliation.
 *
 * Every power a delegation grants lives in accesses stored ON the controlled
 * account (B): the control access authenticates token issuance, and the
 * delegate PAT is the owner-equivalent token itself. Deleting them on B is the
 * AUTHORITATIVE teardown; the delegate's (A's) mirror grants nothing and is
 * advisory. This deliberately differs from the advisory-revoke model some peer
 * relationships use — a full-owner delegation must die authoritatively.
 *
 * The security crux is the genuine-login gate (isGenuineLoginAccess): detach may
 * only be driven by a clean B login — a `type:'personal'` access carrying NO
 * forge-protected `clientData.delegation` marker. A delegate PAT is ALSO
 * `type:'personal'`, so the type check alone discriminates nothing; the ABSENCE
 * of the marker is what proves the token came from B's own login flow. The
 * marker is forge-protected on create AND update for every token class (the
 * plugin's forge hooks), so a clean personal token provably originated from a
 * genuine login. A control access (type `shared`) is rejected by the type check.
 * Consequence: no delegate can remove any delegation relationship — not a
 * co-delegate's, not its own.
 *
 * Pure module: all storage, the session destroy, and cross-core delivery arrive
 * via injected deps, so the whole teardown is unit-testable with fakes.
 */

import * as C from './constants.ts';
import { DelegationErrorIds } from './errorIds.ts';
import * as store from './store.ts';
import type { MallLike, AccessRow } from './store.ts';
import type { AnchorContent, MirrorContent } from './model.ts';
import { delegationError } from './attach.ts';
import type { Identity, TargetResolution, PeerResult, InvitePayload } from './attach.ts';

// ------------------------------------------------------------------ deps shapes

type DetachDeps = {
  mall: MallLike;
  now: () => number;
  self: Identity;                       // acting (B) core identity for the acting user
  /** Destroy a session by its id (the delegate PAT token IS the session id). */
  destroySession: (token: string) => Promise<void>;
  resolveTarget: (username: string) => Promise<TargetResolution>;
  /** Reused for the pending-invite cancel path (admin-key system delivery). */
  deliverInvite: (target: TargetResolution, payload: InvitePayload) => Promise<PeerResult>;
  /** Best-effort A-notify for the active-teardown path (notify-marker channel). */
  notifyDetach: (notifyApiEndpoint: string, relId: string) => Promise<PeerResult>;
  /**
   * Tell the requesters of the consent grants the delegate gave (CMC data
   * grants, `clientData.cmc.role === 'counterparty'`) that their grant is
   * withdrawn: each receives the `consent/revoke-cmc` a consent withdrawal
   * sends. Called with the grants as they were before deletion (the requester's
   * endpoint lives on them). Best-effort, never blocks the teardown; absent →
   * the grants are deleted without notice.
   */
  notifyConsentGrantsRevoked?: (bUserId: string, grants: AccessRow[]) => Promise<void> | void;
  /** Where a consent marker that could not be written is reported. */
  logger?: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
};

// Mirrors cmc/src/constants.ts ACCEPT_SERVER_OWNED_FIELDS (no cross-import);
// [DCH22] and [DCH24] keep them in step.
/** Content key a consent grant's accept event receives when the owner keeps it at detach. */
const OWNER_CONFIRMED_AT = 'ownerConfirmedAt';
/** Content key a consent grant's accept event receives when the grant ends at detach. */
const WITHDRAWAL = 'withdrawal';

type NotifyDeps = {
  mall: MallLike;
  now: () => number;
};

// ------------------------------------------------------------- genuine-login gate

/** The minimal access shape the genuine-login gate inspects. */
type GateAccessLike = {
  type?: string;
  clientData?: { delegation?: unknown } | null;
} | null | undefined;

/**
 * True ONLY for a genuine B login: a `type:'personal'` access carrying no
 * `clientData.delegation` marker. A delegate PAT (also personal, but marked)
 * and a control access (shared) both return false. This is the whole detach
 * authorization rule — the marker's ABSENCE, not the personal type, is the
 * discriminator, and the marker is forge-protected so its absence is provable.
 */
function isGenuineLoginAccess (access: GateAccessLike): boolean {
  if (access == null) return false;
  if (access.type !== 'personal') return false;
  const clientData = access.clientData;
  if (clientData != null && typeof clientData === 'object' && clientData.delegation != null) {
    return false;
  }
  return true;
}

// ========================================================= B-side: detach

/**
 * detachDelegate — authoritative removal of a delegation relationship, driven
 * by a genuine B login (the caller-side gate enforces isGenuineLoginAccess
 * before this runs). Two cases:
 *
 *   - PENDING INVITE → cancel: sweep the invite capability, delete the anchor,
 *     best-effort tell A to drop its mirror (admin-key system cancel — the
 *     notify marker does not exist yet at invite stage).
 *
 *   - ACTIVE → full teardown, ORDER-SENSITIVE so no live credential ever
 *     outlives the anchor: (1) destroy the delegate PAT's backing session AND
 *     delete the PAT access (both required — deleting the access does not kill
 *     the session, and the session alone would let a re-issue resurrect the same
 *     token); (1b) delete every `delegated-child` access of the relationship
 *     (what the delegate granted on B, consent grants included); (1c)
 *     best-effort tell the requester of each consent grant that it is
 *     withdrawn; a consent grant the owner chose to keep (`keepAccessIds`) is
 *     not deleted: it loses its delegation marker and becomes the owner's own;
 *     (2) delete the control access (after this, issueToken can mint no
 *     further PAT); (3) sweep any lingering invite capability; (4) delete the
 *     anchor; then (5) best-effort notify A via the notify-marker channel so A
 *     drops its mirror + notify access. If the notify is lost, A's mirror lingers
 *     until lazy reconciliation (a later getToken 401/403 flips it stale, or the
 *     user dismisses it) — there is NO background sweep.
 *
 * The owner's review: `keepAccessIds` names the consent grants the delegate
 * gave that the owner keeps. Every id must be such a grant of THIS
 * relationship, else the whole call is refused before anything is written.
 * Nothing is kept by default. Each grant's accept event records the outcome:
 * `content.ownerConfirmedAt` for a kept grant, `content.withdrawal` for a
 * dropped one (best-effort; the grant decision itself is authoritative).
 *
 * Absent / already-detached relationship → a clean 404 (not a crash).
 */
async function detachDelegate (deps: DetachDeps, params: {
  bUserId: string;
  bUsername: string;
  delegateUsername: string;
  keepAccessIds?: unknown;
}): Promise<{ revokedChildAccesses?: number; revokedConsentGrants?: number; keptConsentGrants?: number }> {
  const { mall } = deps;
  const delegateUsername = String(params.delegateUsername || '').trim();
  if (delegateUsername.length === 0) {
    throw delegationError(DelegationErrorIds.UNKNOWN_USERNAME, 'A delegate username is required', 400);
  }
  const keepIds = parseKeepList(params.keepAccessIds);

  const anchor = await store.findAnchorByDelegate(mall, params.bUserId, delegateUsername);
  if (anchor == null) {
    throw delegationError(DelegationErrorIds.NOT_FOUND,
      'No delegation relationship with "' + delegateUsername + '"', 404);
  }
  const content = anchor.content as AnchorContent;
  const relId = content.relId;

  // Every access granted through the relationship, read BEFORE any write so a
  // refused review changes nothing. Validation only: the sweep (1b) re-reads
  // after the delegate token is gone.
  const grantsBefore = await store.findMarkerAccesses(mall, params.bUserId, relId, C.CLIENTDATA_KIND.DELEGATED_CHILD);
  if (keepIds.size > 0) {
    const grantIds = new Set(grantsBefore.filter(isConsentGrant).map((a) => a.id));
    for (const id of keepIds) {
      if (!grantIds.has(id)) {
        throw delegationError(DelegationErrorIds.INVALID_KEEP_LIST,
          'keepAccessIds may only name consent grants given through this delegation', 400, { accessId: id });
      }
    }
  }

  return await teardownAnchor(deps, {
    bUserId: params.bUserId, bUsername: params.bUsername, delegateUsername, anchor, keepIds,
  });
}

type TeardownOutcome = { revokedChildAccesses?: number; revokedConsentGrants?: number; keptConsentGrants?: number };

/**
 * The teardown itself, once the relationship is identified and the keep list
 * validated (see detachDelegate for the steps and their order). Shared by the
 * owner's detach and by the release that follows the delegate account's
 * deletion.
 */
async function teardownAnchor (deps: DetachDeps, params: {
  bUserId: string;
  bUsername: string;
  delegateUsername: string;
  anchor: store.EventLike;
  keepIds: Set<string>;
}): Promise<TeardownOutcome> {
  const { mall, now, self } = deps;
  const { anchor, keepIds, delegateUsername } = params;
  const content = anchor.content as AnchorContent;
  const relId = content.relId;

  // -------- pending invite → cancel ----------------------------------------
  if (content.status === C.STATUS.INVITE) {
    const capability = await store.findMarkerAccess(mall, params.bUserId, relId, C.CLIENTDATA_KIND.INVITE_CAPABILITY);
    if (capability != null) await store.deleteAccessById(mall, params.bUserId, capability.id);
    await store.deleteAnchor(mall, params.bUserId, anchor);
    // Best-effort: tell A's core to drop the mirror (admin-key system cancel).
    try {
      const target = await deps.resolveTarget(delegateUsername);
      if (target.found) {
        await deps.deliverInvite(target, {
          action: 'cancel',
          relId,
          controlled: { username: params.bUsername, hostSlug: self.hostSlug },
          delegateUsername,
        });
      }
    } catch (_e) { /* mirror lingers until lazy reconciliation */ }
    return {};
  }

  // -------- active → authoritative teardown (order-sensitive) --------------

  // (1) delegate PAT: destroy the backing session AND delete the access. Both
  // are required and both are best-effort-robust: the access delete is the
  // authoritative kill (the token 401s at access lookup on the next request),
  // the session destroy prevents a resurrected token from a later re-issue.
  const pat = await store.findMarkerAccess(mall, params.bUserId, relId, C.CLIENTDATA_KIND.DELEGATE_PAT);
  if (pat != null) {
    if (pat.token != null) {
      try { await deps.destroySession(pat.token); } catch (_e) { /* access delete below is the authoritative kill */ }
    }
    await store.deleteAccessById(mall, params.bUserId, pat.id);
  }

  // (1b) every access the delegate granted on B through the delegation (app
  // and shared accesses stamped `delegated-child`, grandchildren included,
  // and the consent grants it gave by accepting a consent request):
  // revoking the delegation revokes what it granted. Right after the PAT, so
  // nothing it minted outlives it. Every one is deleted HERE, synchronously:
  // the deletion is the authoritative revocation and never waits on a peer.
  // The exception is a consent grant the owner kept: it stays, without the
  // delegation marker, so it no longer belongs to the relationship.
  // Read AFTER step (1): a grant minted while the token was being removed
  // passed its own post-mint check against a still-present token and is only
  // caught here, by its marker.
  const children = await store.findMarkerAccesses(mall, params.bUserId, relId, C.CLIENTDATA_KIND.DELEGATED_CHILD);
  const consentGrants: AccessRow[] = [];
  let kept = 0;
  for (const child of children) {
    if (keepIds.has(child.id)) {
      // Only the marker: the object form merges one level and `null` removes
      // the key, so `clientData.cmc` is left as stored (a back-channel write
      // since the read above is not overwritten).
      await store.updateAccessFields(mall, params.bUserId, child.id, { clientData: { delegation: null } });
      kept++;
      await markAcceptEvent(deps, params.bUserId, child, { [OWNER_CONFIRMED_AT]: now() });
      continue;
    }
    await store.deleteAccessById(mall, params.bUserId, child.id);
    if (isConsentGrant(child)) {
      consentGrants.push(child);
      await markAcceptEvent(deps, params.bUserId, child, { [WITHDRAWAL]: { at: now(), by: 'delegation-detach', relId } });
    }
  }
  // (1c) a consent grant has a requester on the other side holding its token:
  // tell them it is withdrawn rather than leaving them a dead token.
  if (consentGrants.length > 0 && deps.notifyConsentGrantsRevoked != null) {
    try { await deps.notifyConsentGrantsRevoked(params.bUserId, consentGrants); } catch (_e) { /* best-effort: the grants are already gone */ }
  }

  // (2) control access — after this, issueToken authenticates nothing and can
  // mint no further PAT.
  const control = await store.findMarkerAccess(mall, params.bUserId, relId, C.CLIENTDATA_KIND.CONTROL);
  if (control != null) await store.deleteAccessById(mall, params.bUserId, control.id);

  // (3) sweep any lingering invite capability (the idempotent-re-accept
  // recovery rule leaves it TTL-bounded post-activation; detach is its final GC).
  const capability = await store.findMarkerAccess(mall, params.bUserId, relId, C.CLIENTDATA_KIND.INVITE_CAPABILITY);
  if (capability != null) await store.deleteAccessById(mall, params.bUserId, capability.id);

  // (4) anchor — teardown is now complete + authoritative on B.
  await store.deleteAnchor(mall, params.bUserId, anchor);

  // (5) best-effort A-notify via the notify-marker channel. Swallowed on
  // failure; A reconciles lazily (later getToken 401/403 → stale, or dismiss).
  const notifyEndpoint = content.notifyApiEndpoint;
  if (notifyEndpoint != null) {
    try { await deps.notifyDetach(notifyEndpoint, relId); } catch (_e) { /* lazy reconciliation on A */ }
  }
  return { revokedChildAccesses: children.length - kept, revokedConsentGrants: consentGrants.length, keptConsentGrants: kept };
}

/**
 * releaseRelationship — end ONE relationship, named by its relId, from the
 * delegate's side: the delegate account is being deleted. Runs on the
 * controlled account's core, either called directly (same core) or by the
 * delegate's core through the control access of that very relationship.
 *
 * The teardown is the owner's detach with an empty keep list: what the
 * delegate granted through the relationship is revoked with it, consent
 * grants included (their requesters are told). Nothing else of the
 * controlled account is touched, other delegates' relationships included.
 *
 * The named delegate must be the anchor's (username, and account id when both
 * are known), so a relId alone cannot end someone else's relationship.
 * Already gone → `{ released: false }`, not an error.
 */
async function releaseRelationship (deps: DetachDeps, params: {
  bUserId: string;
  bUsername: string;
  relId: string;
  delegateUsername: string;
  delegateUserId?: string;
}): Promise<{ released: boolean } & TeardownOutcome> {
  const anchor = await store.findAnchorByRelId(deps.mall, params.bUserId, params.relId);
  if (anchor == null) return { released: false };
  const delegate = (anchor.content as AnchorContent).delegate;
  const sameName = delegate?.username != null &&
    delegate.username.toLowerCase() === String(params.delegateUsername ?? '').toLowerCase();
  const sameId = delegate?.userId == null || params.delegateUserId == null || delegate.userId === params.delegateUserId;
  if (!sameName || !sameId) {
    throw delegationError(DelegationErrorIds.DELEGATE_MISMATCH,
      'The delegate identity does not match this delegation relationship', 403);
  }
  const outcome = await teardownAnchor(deps, {
    bUserId: params.bUserId, bUsername: params.bUsername, delegateUsername: delegate.username, anchor, keepIds: new Set(),
  });
  return { released: true, ...outcome };
}

/**
 * The keep list as a set of access ids: absent means keep nothing; anything but
 * an array of non-empty strings is refused before the relationship is read.
 */
function parseKeepList (raw: unknown): Set<string> {
  if (raw == null) return new Set();
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw delegationError(DelegationErrorIds.INVALID_KEEP_LIST,
      'keepAccessIds must be an array of access ids', 400);
  }
  return new Set(raw as string[]);
}

/**
 * Record the owner's decision on the accept event of a consent grant (its id
 * is on the grant, `clientData.cmc.acceptEventId`). Best-effort: the grant was
 * already kept or deleted, which is the authoritative outcome; a missing event
 * or a failed write is reported, never thrown.
 */
async function markAcceptEvent (deps: DetachDeps, bUserId: string, grant: AccessRow, patch: Record<string, unknown>): Promise<void> {
  const acceptEventId = (grant.clientData as { cmc?: { acceptEventId?: unknown } } | null | undefined)?.cmc?.acceptEventId;
  if (typeof acceptEventId !== 'string' || acceptEventId.length === 0) return;
  try {
    const written = await store.patchEventContent(deps.mall, bUserId, acceptEventId, patch, deps.now());
    if (!written) {
      deps.logger?.warn('detach: consent accept event not found, decision not recorded on it', { accessId: grant.id, acceptEventId });
    }
  } catch (err) {
    deps.logger?.warn('detach: could not record the decision on the consent accept event', {
      accessId: grant.id, acceptEventId, error: String((err as Error)?.message ?? err),
    });
  }
}

/**
 * True for a CMC data grant: the access a consent accept mints, held by the
 * requester (`clientData.cmc.role === 'counterparty'`). Read structurally so
 * this plugin does not import the CMC plugin.
 */
function isConsentGrant (access: AccessRow): boolean {
  const cmc = (access?.clientData as { cmc?: { role?: unknown } } | null | undefined)?.cmc;
  return cmc != null && typeof cmc === 'object' && cmc.role === 'counterparty';
}

// =================================================== A-side: detach notify

/**
 * handleDetachNotify — runs on A's core, authenticated by the notify marker
 * access. Drops the mirror + the notify access for the relationship. Idempotent:
 * already gone → ok. Deletes regardless of the mirror's current status (it may
 * already have been flipped to `stale` by a prior getToken reconciliation).
 */
async function handleDetachNotify (deps: NotifyDeps, params: {
  aUserId: string;
  relId: string;
}): Promise<{ ok: boolean }> {
  const { mall } = deps;
  const mirror = await store.findMirrorByRelId(mall, params.aUserId, params.relId);
  if (mirror != null) await store.deleteMirror(mall, params.aUserId, mirror);
  const notify = await store.findMarkerAccess(mall, params.aUserId, params.relId, C.CLIENTDATA_KIND.NOTIFY);
  if (notify != null) await store.deleteAccessById(mall, params.aUserId, notify.id);
  return { ok: true };
}

// ============================================ A-side: local stale dismissal

/**
 * dismissControlledMirror — A locally removes a `stale` mirror row (lazy
 * reconciliation housekeeping, as in the list UI's Dismiss action). This is NOT a
 * detach: it removes no authority (all authority lives on B) and touches B not
 * at all. Only a `stale` mirror may be dismissed; an `invite`/`active` mirror is
 * refused so a live relationship is never silently dropped from A's view.
 */
async function dismissControlledMirror (mall: MallLike, aUserId: string, controlledUsername: string): Promise<Record<string, never>> {
  const mirror = await store.findMirrorByControlled(mall, aUserId, controlledUsername);
  if (mirror == null) {
    throw delegationError(DelegationErrorIds.NOT_FOUND,
      'No delegation relationship with "' + controlledUsername + '"', 404);
  }
  const content = mirror.content as MirrorContent;
  if (content.status !== C.STATUS.STALE) {
    throw delegationError(DelegationErrorIds.MIRROR_NOT_STALE,
      'Only a stale delegation can be dismissed; this relationship is still ' + content.status, 409);
  }
  const notify = await store.findMarkerAccess(mall, aUserId, content.relId, C.CLIENTDATA_KIND.NOTIFY);
  if (notify != null) await store.deleteAccessById(mall, aUserId, notify.id);
  await store.deleteMirror(mall, aUserId, mirror);
  return {};
}

export {
  isGenuineLoginAccess,
  detachDelegate,
  releaseRelationship,
  handleDetachNotify,
  dismissControlledMirror,
};
export type { DetachDeps, NotifyDeps, GateAccessLike, TeardownOutcome };
