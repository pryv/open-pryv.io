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
import type { MallLike } from './store.ts';
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
};

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
 *     token); (2) delete the control access (after this, issueToken can mint no
 *     further PAT); (3) sweep any lingering invite capability; (4) delete the
 *     anchor; then (5) best-effort notify A via the notify-marker channel so A
 *     drops its mirror + notify access. If the notify is lost, A's mirror lingers
 *     until lazy reconciliation (a later getToken 401/403 flips it stale, or the
 *     user dismisses it) — there is NO background sweep.
 *
 * Absent / already-detached relationship → a clean 404 (not a crash).
 */
async function detachDelegate (deps: DetachDeps, params: {
  bUserId: string;
  bUsername: string;
  delegateUsername: string;
}): Promise<Record<string, never>> {
  const { mall, now, self } = deps;
  const delegateUsername = String(params.delegateUsername || '').trim();
  if (delegateUsername.length === 0) {
    throw delegationError(DelegationErrorIds.UNKNOWN_USERNAME, 'A delegate username is required', 400);
  }

  const anchor = await store.findAnchorByDelegate(mall, params.bUserId, delegateUsername);
  if (anchor == null) {
    throw delegationError(DelegationErrorIds.NOT_FOUND,
      'No delegation relationship with "' + delegateUsername + '"', 404);
  }
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
  void now;
  return {};
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
  handleDetachNotify,
  dismissControlledMirror,
};
export type { DetachDeps, NotifyDeps, GateAccessLike };
