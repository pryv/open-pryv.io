/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account-delegation plugin — attach-handshake orchestration.
 *
 * The controlled account (B) requests attachment to a delegate (A); A accepts
 * or refuses. Cross-core within one platform is supported: the ONLY
 * no-prior-credential delivery is the invite (system endpoint, admin-key
 * gated); everything after it rides a plugin-minted, forge-protected marker
 * access used as a bearer credential.
 *
 * Delivery design note (execution ruling): the spec sketches the post-invite
 * exchange as capability writes into a per-relationship "responses" stream that
 * a dispatch-style hook reacts to. That mechanism is incompatible with the
 * blanket write-guard, which rejects EVERY write into `:_delegation:*`
 * (and every `delegation/*`-typed event) by ANY token, capability tokens
 * included. Rather than punch a hole in that guard, the post-invite exchange is
 * modelled as controlled-side METHOD calls authenticated by the marker access
 * (the same shape as the control access authorizes exactly one method): the
 * bearer calls a method, the method authorizes on the forge-protected marker,
 * and it mutates state through the mall — never over the guarded routes. This
 * keeps the write-guards fully intact. Activation is returned synchronously
 * from B to A (A holds the invite capability and calls B), so A learns the
 * control endpoint from the response; the notify channel is still provisioned
 * and its endpoint stored on B for the teardown mirror-sync.
 *
 * Pure module: all storage + cross-core delivery arrives via injected deps, so
 * the whole handshake is unit-testable with a fake mall and a fake peer.
 */

import * as C from './constants.ts';
import { DelegationErrorIds } from './errorIds.ts';
import * as store from './store.ts';
import type { MallLike } from './store.ts';
import type { AnchorContent, MirrorContent, DelegationOrigin } from './model.ts';

// ------------------------------------------------------------------ error type

class DelegationError extends Error {
  id: string;
  httpStatus: number;
  data?: Record<string, unknown>;
  constructor (id: string, message: string, httpStatus: number, data?: Record<string, unknown>) {
    super(message);
    this.id = id;
    this.httpStatus = httpStatus;
    this.data = data;
  }
}

function delegationError (id: string, message: string, httpStatus: number, data?: Record<string, unknown>): DelegationError {
  return new DelegationError(id, message, httpStatus, data);
}

/**
 * True when a storage error signals a uniqueness violation (the control-access
 * name `__deleg-ctl-<relId8>` is unique on (type, name, deviceName), so a
 * concurrent second accept collides here). Used to recover by re-lookup.
 */
function isDuplicateErr (err: unknown): boolean {
  const e = err as { id?: string; data?: { id?: string }; message?: string };
  const id = e?.id || e?.data?.id;
  if (id === 'item-already-exists' || id === 'duplicate') return true;
  const msg = String(e?.message || err).toLowerCase();
  return msg.includes('already exists') || msg.includes('duplicate');
}

// ------------------------------------------------------------------ deps shapes

type Identity = { username: string; host: string; hostSlug: string };

/** Resolution of a target account through the platform layer. */
type TargetResolution = {
  found: boolean;
  isSelf: boolean;      // does the target account live on THIS core?
  userId?: string;      // local user id, when isSelf
  hostSlug: string;
  host: string;
};

type PeerResult = { ok: boolean; status: number; body: unknown };

type DefaultTtl = { inviteTtlSeconds: number };

type RequestAttachDeps = {
  mall: MallLike;
  now: () => number;                 // unix seconds
  idGen: () => string;
  self: Identity;                    // acting (B) core identity for the acting user
  resolveTarget: (username: string) => Promise<TargetResolution>;
  deliverInvite: (target: TargetResolution, payload: InvitePayload) => Promise<PeerResult>;
} & DefaultTtl;

type AcceptRefuseDeps = {
  mall: MallLike;
  now: () => number;
  idGen: () => string;
  self: Identity;                    // acting (A) core identity for the acting user
  callControlledSide: (endpoint: string, action: 'accept-response' | 'refuse-response' | 'accept-complete', body: Record<string, unknown>) => Promise<PeerResult>;
};

type CancelDeps = {
  mall: MallLike;
  now: () => number;
  self: Identity;
  resolveTarget: (username: string) => Promise<TargetResolution>;
  deliverInvite: (target: TargetResolution, payload: InvitePayload) => Promise<PeerResult>;
};

type SystemInviteDeps = {
  mall: MallLike;
  now: () => number;
  resolveLocalUserId: (username: string) => Promise<string | null>;
};

type ControlledSideDeps = {
  mall: MallLike;
  now: () => number;
  /**
   * The host's say on an accept: asked before the control access is minted
   * (or before an interrupted accept is healed), and again once the anchor
   * is active (`activated: true`). A refusal message withdraws the invite
   * (e.g. an account transfer that is no longer open), null lets it proceed.
   */
  acceptCheck?: (input: { bUserId: string; relId: string; delegateUsername: string; purpose?: string; activated?: boolean }) => Promise<string | null>;
  /** Told what was left when undoing a refused or unconfirmed accept failed. */
  logger?: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
};

// ------------------------------------------------------------------- payloads

type InvitePayload = {
  action: 'create' | 'cancel';
  relId: string;
  controlled: { username: string; hostSlug: string };
  delegateUsername: string;
  capabilityUrl?: string;
  expiresAt?: number;
};

// ============================================================ B-side: request

/**
 * requestAttach — B asks to be controlled by delegate A. Atomic: on delivery
 * failure the anchor + capability are rolled back so the request is
 * absent-or-complete from B's view.
 */
async function requestAttach (deps: RequestAttachDeps, params: {
  bUserId: string;
  bUsername: string;
  delegateUsername: string;
  /** Recorded in the anchor (see `AnchorContent.purpose`). */
  purpose?: string;
}): Promise<{ relId: string; delegate: { username: string }; status: string; requestedAt: number; expiresAt: number }> {
  const { mall, now, idGen, self } = deps;
  const delegateUsername = String(params.delegateUsername || '').trim();
  if (delegateUsername.length === 0) {
    throw delegationError(DelegationErrorIds.UNKNOWN_USERNAME, 'A delegate username is required', 400);
  }
  if (delegateUsername.toLowerCase() === params.bUsername.toLowerCase()) {
    throw delegationError(DelegationErrorIds.SELF_NOT_ALLOWED, 'An account may not delegate to itself', 400);
  }

  const target = await deps.resolveTarget(delegateUsername);
  if (!target.found) {
    throw delegationError(DelegationErrorIds.UNKNOWN_USERNAME, 'Unknown delegate account "' + delegateUsername + '"', 404);
  }

  // Duplicate rejection — an existing invite OR active relationship to the same
  // delegate blocks a second request. So does a stale one (its delegate
  // account is gone): one anchor per delegate name, and the stale one still
  // holds what the delegate granted, for the owner to review at detach.
  const existing = await store.findAnchorByDelegate(mall, params.bUserId, delegateUsername);
  if (existing != null) {
    const status = (existing.content as AnchorContent).status;
    if (status === C.STATUS.INVITE || status === C.STATUS.ACTIVE) {
      throw delegationError(DelegationErrorIds.ALREADY_EXISTS,
        'A delegation relationship to "' + delegateUsername + '" already exists', 409);
    }
    if (status === C.STATUS.STALE) {
      throw delegationError(DelegationErrorIds.ALREADY_EXISTS,
        'The delegation relationship to "' + delegateUsername + '" is stale (its delegate account is gone); remove it first', 409,
        { status });
    }
  }

  const relId = idGen();
  const requestedAt = now();
  const expiresAt = requestedAt + deps.inviteTtlSeconds;

  // Same core: the delegate's account id is known now. Cross-core it arrives
  // with the accept.
  const delegateRef: AnchorContent['delegate'] = { username: delegateUsername, hostSlug: target.hostSlug };
  if (target.isSelf && typeof target.userId === 'string' && target.userId.length > 0) delegateRef.userId = target.userId;
  const anchorContent: AnchorContent = {
    relId,
    delegate: delegateRef,
    status: C.STATUS.INVITE,
    origin: C.ORIGIN.ATTACHED,
    requestedAt,
  };
  if (typeof params.purpose === 'string' && params.purpose.length > 0) anchorContent.purpose = params.purpose;
  const anchor = await store.createAnchor(mall, params.bUserId, anchorContent, now);

  // Invite capability — a bearer marker access A uses to reach back into B's
  // controlled-side accept/refuse methods. Single relationship, TTL-bounded.
  let capability;
  try {
    capability = await store.mintMarkerAccess(mall, params.bUserId, {
      name: '__deleg-inv-' + relId.substring(0, 8),
      clientDataDelegation: { kind: C.CLIENTDATA_KIND.INVITE_CAPABILITY, relId },
      expires: expiresAt,
    });
  } catch (err) {
    await store.deleteAnchor(mall, params.bUserId, anchor);
    throw err;
  }
  const capabilityUrl = capability.apiEndpoint;
  if (capabilityUrl == null) {
    await store.deleteAccessById(mall, params.bUserId, capability.id);
    await store.deleteAnchor(mall, params.bUserId, anchor);
    throw delegationError(DelegationErrorIds.DELIVERY_FAILED, 'Invite capability has no reachable endpoint', 503);
  }

  const invitePayload: InvitePayload = {
    action: 'create',
    relId,
    controlled: { username: params.bUsername, hostSlug: self.hostSlug },
    delegateUsername,
    capabilityUrl,
    expiresAt,
  };

  let delivered: PeerResult;
  try {
    delivered = await deps.deliverInvite(target, invitePayload);
  } catch (err) {
    await store.deleteAccessById(mall, params.bUserId, capability.id);
    await store.deleteAnchor(mall, params.bUserId, anchor);
    throw delegationError(DelegationErrorIds.DELIVERY_FAILED,
      'Could not deliver the delegation invite to the delegate core', 503,
      { cause: String((err as Error)?.message || err) });
  }
  if (!delivered.ok) {
    await store.deleteAccessById(mall, params.bUserId, capability.id);
    await store.deleteAnchor(mall, params.bUserId, anchor);
    throw delegationError(DelegationErrorIds.DELIVERY_FAILED,
      'The delegate core rejected the delegation invite', 503, { peerStatus: delivered.status });
  }

  return {
    relId,
    delegate: { username: delegateUsername },
    status: C.STATUS.INVITE,
    requestedAt,
    expiresAt,
  };
}

// =========================================================== A-side: system in

/**
 * handleSystemInvite — runs on A's core when B's core delivers (or cancels) an
 * invite. Admin-key gated at the transport; idempotent per relId.
 */
async function handleSystemInvite (deps: SystemInviteDeps, payload: InvitePayload): Promise<{ ok: boolean }> {
  const { mall, now } = deps;
  const aUserId = await deps.resolveLocalUserId(payload.delegateUsername);
  if (aUserId == null) {
    throw delegationError(DelegationErrorIds.UNKNOWN_USERNAME,
      'Unknown delegate account on this core', 404);
  }

  if (payload.action === 'cancel') {
    const mirror = await store.findMirrorByRelId(mall, aUserId, payload.relId);
    if (mirror != null) {
      await dropNotifyAccess(mall, aUserId, payload.relId);
      await store.deleteMirror(mall, aUserId, mirror);
    }
    return { ok: true };
  }

  // create (idempotent)
  const existing = await store.findMirrorByRelId(mall, aUserId, payload.relId);
  if (existing != null) return { ok: true };

  const mirrorContent: MirrorContent = {
    relId: payload.relId,
    controlled: { username: payload.controlled.username, hostSlug: payload.controlled.hostSlug },
    status: C.STATUS.INVITE,
    origin: C.ORIGIN.ATTACHED,
    capabilityUrl: payload.capabilityUrl,
    requestedAt: now(),
  };
  await store.createMirror(mall, aUserId, mirrorContent, now);
  return { ok: true };
}

// ============================================================ A-side: accept

async function acceptAttach (deps: AcceptRefuseDeps, params: {
  aUserId: string;
  aUsername: string;
  controlledUsername: string;
}): Promise<{ relId: string; controlled: { username: string; hostSlug: string }; status: string; activatedAt: number }> {
  const { mall, now, self } = deps;
  const mirror = await store.findMirrorByControlled(mall, params.aUserId, params.controlledUsername);
  if (mirror == null) {
    throw delegationError(DelegationErrorIds.NOT_FOUND, 'No delegation invite from "' + params.controlledUsername + '"', 404);
  }
  const content = mirror.content as MirrorContent;

  // Idempotent re-accept: already active → return the settled relationship.
  if (content.status === C.STATUS.ACTIVE) {
    return {
      relId: content.relId,
      controlled: content.controlled,
      status: C.STATUS.ACTIVE,
      activatedAt: content.activatedAt ?? now(),
    };
  }
  if (content.status !== C.STATUS.INVITE) {
    throw delegationError(DelegationErrorIds.NOT_FOUND, 'This delegation invite is no longer pending', 404);
  }
  const capabilityUrl = content.capabilityUrl;
  if (capabilityUrl == null) {
    throw delegationError(DelegationErrorIds.INVITE_EXPIRED, 'The delegation invite has expired', 410);
  }

  // Provision the notify access on A (its endpoint is handed to B for the
  // teardown mirror-sync channel). Reused idempotently on re-accept.
  let notifyAccess = await store.findMarkerAccess(mall, params.aUserId, content.relId, C.CLIENTDATA_KIND.NOTIFY);
  if (notifyAccess == null) {
    notifyAccess = await store.mintMarkerAccess(mall, params.aUserId, {
      name: '__deleg-ntf-' + content.relId.substring(0, 8),
      clientDataDelegation: { kind: C.CLIENTDATA_KIND.NOTIFY, relId: content.relId },
      expires: null,
    });
  }
  const notifyApiEndpoint = notifyAccess.apiEndpoint;

  let peer: PeerResult;
  try {
    peer = await deps.callControlledSide(capabilityUrl, 'accept-response', {
      relId: content.relId,
      delegate: { username: params.aUsername, hostSlug: self.hostSlug, userId: params.aUserId },
      notifyApiEndpoint,
    });
  } catch (err) {
    throw delegationError(DelegationErrorIds.DELIVERY_FAILED,
      'Could not reach the controlled account core to accept', 503,
      { cause: String((err as Error)?.message || err) });
  }
  if (!peer.ok) {
    // 4xx here means the invite is gone/expired on B's side.
    if (peer.status >= 400 && peer.status < 500) {
      // 410: B withdrew it for good (expired, refused by its host, stale):
      // the mirror and the notify access minted above have nothing left to serve.
      // Best effort: a failed removal keeps the 410 answer (refuse removes it later).
      if (peer.status === 410) {
        try {
          await dropNotifyAccess(mall, params.aUserId, content.relId);
          await store.deleteMirror(mall, params.aUserId, mirror);
        } catch (_e) { /* the mirror lingers until refused or reconciled */ }
      }
      throw delegationError(DelegationErrorIds.INVITE_EXPIRED,
        'The delegation invite is no longer valid on the controlled account', 410, { peerStatus: peer.status });
    }
    throw delegationError(DelegationErrorIds.DELIVERY_FAILED,
      'The controlled account core did not confirm activation', 503, { peerStatus: peer.status });
  }

  const body = (peer.body ?? {}) as { controlApiEndpoint?: string; activatedAt?: number };
  const activatedAt = body.activatedAt ?? now();

  await store.updateMirrorContent(mall, params.aUserId, mirror, {
    status: C.STATUS.ACTIVE,
    activatedAt,
    controlApiEndpoint: body.controlApiEndpoint,
    capabilityUrl: undefined,
    // An invite recorded before the origin was stored gets it on activation.
    origin: C.ORIGIN.ATTACHED,
  });

  // Best-effort accept-complete: release the invite capability on B now that A's
  // mirror commit has landed. Swallowed on failure — the capability's TTL bounds
  // any lingering, and B's detach sweep GCs it as a backstop. The invite
  // capability MUST survive B's activation commit (recovery via idempotent
  // re-accept) — this call, not the activation, is what retires it.
  try {
    await deps.callControlledSide(capabilityUrl, 'accept-complete', { relId: content.relId });
  } catch (_e) { /* capability TTL / detach sweep bound any lingering */ }

  return {
    relId: content.relId,
    controlled: content.controlled,
    status: C.STATUS.ACTIVE,
    activatedAt,
  };
}

// =================================================== B-side: accept response

/**
 * handleAcceptResponse — runs on B's core, authenticated by the invite
 * capability. Mints the control access (if not already present), flips the
 * anchor to active, and returns the control endpoint SYNCHRONOUSLY.
 *
 * At-most-once invariant: for a relId, at most one control access is
 * ever live; every successful accept returns the SAME controlApiEndpoint; the
 * anchor flips invite→active exactly once. Enforcement:
 *   - D2 control-access-first lookup (idempotency keyed on the control access,
 *     NOT anchor.status — the commit order is mint-then-flip, so a crash
 *     between them leaves `invite` + a minted control that must be healed, not
 *     re-minted);
 *   - D2 duplicate-index catch + re-lookup on mint (concurrent-accept race);
 *   - D5 mint-then-flip with cleanup of the freshly-minted control if the
 *     anchor flip fails (accept racing cancelInvite leaves no orphan credential);
 *   - D3 delegate identity validated against the anchor, and the ANCHOR's
 *     values (not the caller's) are stamped into the control marker;
 *   - D4 invite-capability TTL enforced on the fresh-accept path (the same-core
 *     dispatch never consults the auth layer, so it is checked here);
 *   - D1 the invite capability is NOT GC'd here — it degrades to an activation
 *     receipt so a lost cross-core response can be recovered by re-accept.
 */
async function handleAcceptResponse (deps: ControlledSideDeps, params: {
  bUserId: string;
  relId: string;
  delegate: { username: string; hostSlug: string; userId?: string };
  notifyApiEndpoint?: string;
}): Promise<{ controlApiEndpoint: string; relId: string; activatedAt: number }> {
  const { mall, now } = deps;
  const anchor = await store.findAnchorByRelId(mall, params.bUserId, params.relId);
  if (anchor == null) {
    throw delegationError(DelegationErrorIds.NOT_FOUND, 'No pending delegation for this relationship', 404);
  }
  const content = anchor.content as AnchorContent;

  // D3 — validate the caller-supplied delegate identity against the anchor. The
  // control marker feeds audit attribution + accessInfo, so it must never carry
  // a caller-chosen identity. Compare on username (case-insensitive); stamp the
  // anchor's own values below.
  const anchorDelegate = content.delegate;
  const claimed = String(params.delegate?.username ?? '').toLowerCase();
  if (anchorDelegate?.username == null || claimed.length === 0 ||
      anchorDelegate.username.toLowerCase() !== claimed) {
    throw delegationError(DelegationErrorIds.DELEGATE_MISMATCH,
      'The delegate identity does not match this delegation relationship', 403);
  }
  // The account id too, when both sides know it: a later account holding the
  // invited name is not the invited delegate.
  const claimedUserId = typeof params.delegate?.userId === 'string' && params.delegate.userId.length > 0
    ? params.delegate.userId
    : null;
  if (anchorDelegate.userId != null && claimedUserId != null && anchorDelegate.userId !== claimedUserId) {
    throw delegationError(DelegationErrorIds.DELEGATE_MISMATCH,
      'The delegate identity does not match this delegation relationship', 403);
  }
  // A stale relationship (its delegate account is gone) is never revived.
  if (content.status === C.STATUS.STALE) {
    throw delegationError(DelegationErrorIds.NOT_ACTIVE, 'This delegation relationship is no longer active', 410);
  }
  // Learnt now (a cross-core invite): recorded with the activation below.
  const delegateIdPatch: Partial<AnchorContent> = (anchorDelegate.userId == null && claimedUserId != null)
    ? { delegate: { ...anchorDelegate, userId: claimedUserId } }
    : {};

  // D2 — idempotency keyed on the control access. If one already exists (a
  // completed accept, or a crash between mint and anchor-flip), heal the anchor
  // and return the EXISTING endpoint — never mint a second.
  const existingControl = await store.findMarkerAccess(mall, params.bUserId, params.relId, C.CLIENTDATA_KIND.CONTROL);
  if (existingControl != null) {
    if (existingControl.apiEndpoint == null) {
      throw delegationError(DelegationErrorIds.CREATION_FAILED, 'The control access has no reachable endpoint', 502);
    }
    // An accept interrupted before the flip: the host has its say before the
    // anchor is healed, as on a fresh accept. An anchor already active is a
    // settled re-accept, not asked again; read once more, since a concurrent
    // accept may have flipped it after the read above.
    let current = anchor;
    if (content.status !== C.STATUS.ACTIVE) current = (await store.findAnchorByRelId(mall, params.bUserId, params.relId)) ?? anchor;
    const healing = (current.content as AnchorContent).status !== C.STATUS.ACTIVE;
    if (healing) await askHost(deps, params, current, content, { controlId: existingControl.id, activated: false });
    const activatedAt = await healAnchorToActive(deps, params, current, existingControl.id, delegateIdPatch);
    if (healing) await askHost(deps, params, current, content, { controlId: existingControl.id, activated: true });
    return { controlApiEndpoint: existingControl.apiEndpoint, relId: params.relId, activatedAt };
  }

  // D4 — fresh accept: the invite capability must exist AND be unexpired. Cross
  // core the auth layer enforces this; the same-core direct dispatch does not,
  // and the anchor itself never expires, so check it explicitly here.
  const capability = await store.findMarkerAccess(mall, params.bUserId, params.relId, C.CLIENTDATA_KIND.INVITE_CAPABILITY);
  if (capability == null) {
    throw delegationError(DelegationErrorIds.INVITE_EXPIRED, 'The delegation invite has expired', 410);
  }
  const capExpires = capability.expires;
  if (typeof capExpires === 'number' && capExpires <= now()) {
    throw delegationError(DelegationErrorIds.INVITE_EXPIRED, 'The delegation invite has expired', 410);
  }
  // The host's say (an invite sent on the owner's behalf for a purpose that
  // has ended since): refused, the invite withdrawn.
  await askHost(deps, params, anchor, content, { activated: false });

  // Mint the control access, stamping the ANCHOR's delegate values (D3). Recover
  // from a concurrent-accept unique-index collision by re-looking-up (D2).
  let control;
  try {
    control = await store.mintMarkerAccess(mall, params.bUserId, {
      name: '__deleg-ctl-' + params.relId.substring(0, 8),
      clientDataDelegation: {
        kind: C.CLIENTDATA_KIND.CONTROL,
        relId: params.relId,
        delegate: { username: anchorDelegate.username, hostSlug: anchorDelegate.hostSlug },
      },
      expires: null,
    });
  } catch (err) {
    if (isDuplicateErr(err)) {
      const dup = await store.findMarkerAccess(mall, params.bUserId, params.relId, C.CLIENTDATA_KIND.CONTROL);
      if (dup?.apiEndpoint != null) {
        const activatedAt = await healAnchorToActive(deps, params, anchor, dup.id, delegateIdPatch);
        await askHost(deps, params, anchor, content, { controlId: dup.id, activated: true });
        return { controlApiEndpoint: dup.apiEndpoint, relId: params.relId, activatedAt };
      }
    }
    throw err;
  }
  if (control.apiEndpoint == null) {
    await store.deleteAccessById(mall, params.bUserId, control.id);
    throw delegationError(DelegationErrorIds.CREATION_FAILED, 'Could not provision the control access', 502);
  }

  // D5 — flip the anchor; if the flip fails (e.g. cancelInvite deleted the
  // anchor between the lookup and here), delete the just-minted control access
  // so no orphan credential is left (undeletable via the guarded generic APIs).
  const activatedAt = now();
  try {
    await store.updateAnchorContent(mall, params.bUserId, anchor, {
      status: C.STATUS.ACTIVE,
      activatedAt,
      notifyApiEndpoint: params.notifyApiEndpoint,
      controlAccessId: control.id,
      // An invite recorded before the origin was stored gets it on activation.
      origin: C.ORIGIN.ATTACHED,
      ...delegateIdPatch,
    });
  } catch (err) {
    await store.deleteAccessById(mall, params.bUserId, control.id);
    throw err;
  }
  // Asked again once active: the purpose may have ended between the first
  // ask and the flip (a cancel whose withdraw failed). The control endpoint
  // has not been handed out yet, so a refusal here gives nothing away.
  await askHost(deps, params, anchor, content, { controlId: control.id, activated: true });

  // D1 — the invite capability is NOT GC'd here (recovery via re-accept). It is
  // retired by A's best-effort acceptComplete, its own TTL, or the detach sweep.
  return { controlApiEndpoint: control.apiEndpoint, relId: params.relId, activatedAt };
}

/**
 * The host's say on an accept (`deps.acceptCheck`). On a refusal the invite
 * is withdrawn (`withdrawAccept`), then 410. A check that fails once the
 * anchor is active undoes the activation only (`undoActivation`: the invite
 * stays, a repeated accept is a fresh one), then rethrows; before that, a
 * failure just stops the accept. A failed removal never replaces the answer:
 * it is logged with what was left.
 */
async function askHost (deps: ControlledSideDeps, params: { bUserId: string; relId: string }, anchor: store.EventLike,
  content: AnchorContent, opts: { controlId?: string; activated: boolean }): Promise<void> {
  if (deps.acceptCheck == null) return;
  let refusal: string | null;
  try {
    refusal = await deps.acceptCheck({
      bUserId: params.bUserId,
      relId: params.relId,
      delegateUsername: content.delegate.username,
      purpose: content.purpose,
      activated: opts.activated,
    });
  } catch (err) {
    if (opts.activated) await undoActivation(deps, params, anchor, opts.controlId);
    throw err;
  }
  if (refusal == null) return;
  await withdrawAccept(deps, params, anchor, opts.controlId);
  throw delegationError(DelegationErrorIds.INVITE_EXPIRED, refusal, 410);
}

/**
 * Removes an invite the host refused: the control access first (the
 * credential), then the anchor (nothing reads as active any more), then the
 * capability (inert without its anchor; its TTL ends it).
 */
async function withdrawAccept (deps: ControlledSideDeps, params: { bUserId: string; relId: string }, anchor: store.EventLike, controlId?: string): Promise<void> {
  const { mall } = deps;
  const left: string[] = [];
  if (controlId != null) await attempt(left, 'control access', () => store.deleteAccessById(mall, params.bUserId, controlId));
  await attempt(left, 'anchor', () => store.deleteAnchor(mall, params.bUserId, anchor));
  await attempt(left, 'invite capability', async () => {
    const capability = await store.findMarkerAccess(mall, params.bUserId, params.relId, C.CLIENTDATA_KIND.INVITE_CAPABILITY);
    if (capability != null) await store.deleteAccessById(mall, params.bUserId, capability.id);
  });
  if (left.length > 0) deps.logger?.warn('delegation: a refused invite was not fully removed', { relId: params.relId, left });
}

/** An activation the host could not confirm: the control access removed, the anchor back to `invite`, the capability kept. */
async function undoActivation (deps: ControlledSideDeps, params: { bUserId: string; relId: string }, anchor: store.EventLike, controlId?: string): Promise<void> {
  const { mall } = deps;
  const left: string[] = [];
  if (controlId != null) await attempt(left, 'control access', () => store.deleteAccessById(mall, params.bUserId, controlId));
  await attempt(left, 'anchor still active', () => store.updateAnchorContent(mall, params.bUserId, anchor, {
    status: C.STATUS.INVITE,
    activatedAt: undefined,
    controlAccessId: undefined,
  }));
  if (left.length > 0) deps.logger?.warn('delegation: an unconfirmed activation was not fully undone', { relId: params.relId, left });
}

/** Runs one removal step; a failure is noted in `left` instead of thrown. */
async function attempt (left: string[], what: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (err) {
    left.push(what + ' (' + String((err as Error)?.message || err) + ')');
  }
}

/**
 * healAnchorToActive — idempotently bring the anchor to `active` around an
 * already-minted control access (interrupted commit recovery). Returns the
 * effective activatedAt. A no-op when the anchor is already fully active.
 */
async function healAnchorToActive (deps: ControlledSideDeps, params: {
  bUserId: string;
  relId: string;
  notifyApiEndpoint?: string;
}, anchor: store.EventLike, controlAccessId: string, delegateIdPatch: Partial<AnchorContent> = {}): Promise<number> {
  const { mall, now } = deps;
  const content = anchor.content as AnchorContent;
  const activatedAt = content.activatedAt ?? now();
  if (content.status !== C.STATUS.ACTIVE || content.controlAccessId == null) {
    await store.updateAnchorContent(mall, params.bUserId, anchor, {
      status: C.STATUS.ACTIVE,
      activatedAt,
      notifyApiEndpoint: content.notifyApiEndpoint ?? params.notifyApiEndpoint,
      controlAccessId: content.controlAccessId ?? controlAccessId,
      ...delegateIdPatch,
    });
  } else if (delegateIdPatch.delegate != null) {
    await store.updateAnchorContent(mall, params.bUserId, anchor, delegateIdPatch);
  }
  return activatedAt;
}

/**
 * handleAcceptComplete — runs on B's core, authenticated by the invite
 * capability. GCs the invite capability now that A has committed its mirror.
 * Idempotent: already gone → ok. This is the primary retirement of the
 * capability under the D1 recovery rule (TTL + detach sweep are backstops).
 */
async function handleAcceptComplete (deps: ControlledSideDeps, params: {
  bUserId: string;
  relId: string;
}): Promise<{ ok: boolean }> {
  const { mall } = deps;
  const capability = await store.findMarkerAccess(mall, params.bUserId, params.relId, C.CLIENTDATA_KIND.INVITE_CAPABILITY);
  if (capability != null) await store.deleteAccessById(mall, params.bUserId, capability.id);
  return { ok: true };
}

// ============================================================ A-side: refuse

async function refuseAttach (deps: AcceptRefuseDeps, params: {
  aUserId: string;
  controlledUsername: string;
}): Promise<Record<string, never>> {
  const { mall } = deps;
  const mirror = await store.findMirrorByControlled(mall, params.aUserId, params.controlledUsername);
  if (mirror == null) {
    throw delegationError(DelegationErrorIds.NOT_FOUND, 'No delegation invite from "' + params.controlledUsername + '"', 404);
  }
  const content = mirror.content as MirrorContent;
  const capabilityUrl = content.capabilityUrl;

  // Best-effort: tell B to drop its anchor + capability. A cleans up locally
  // regardless (refuse is A's unilateral decline).
  if (capabilityUrl != null) {
    try {
      await deps.callControlledSide(capabilityUrl, 'refuse-response', { relId: content.relId });
    } catch (_e) { /* local cleanup proceeds */ }
  }
  await dropNotifyAccess(mall, params.aUserId, content.relId);
  await store.deleteMirror(mall, params.aUserId, mirror);
  return {};
}

// ================================================== B-side: refuse response

async function handleRefuseResponse (deps: ControlledSideDeps, params: {
  bUserId: string;
  relId: string;
}): Promise<{ ok: boolean }> {
  const { mall } = deps;
  const anchor = await store.findAnchorByRelId(mall, params.bUserId, params.relId);
  if (anchor == null) return { ok: true };
  const content = anchor.content as AnchorContent;
  // Only a pending invite is refusable. An active relationship is untouched
  // (its removal is a genuine-login detach, owned by a later phase).
  if (content.status !== C.STATUS.INVITE) return { ok: true };
  const capability = await store.findMarkerAccess(mall, params.bUserId, params.relId, C.CLIENTDATA_KIND.INVITE_CAPABILITY);
  if (capability != null) await store.deleteAccessById(mall, params.bUserId, capability.id);
  await store.deleteAnchor(mall, params.bUserId, anchor);
  return { ok: true };
}

// ========================================================= B-side: cancel

/**
 * cancelInvite — B withdraws its own pending request. Invite-status only;
 * removing an ACTIVE relationship is a genuine-login detach (owned by a later
 * phase) and is refused here.
 */
async function cancelInvite (deps: CancelDeps, params: {
  bUserId: string;
  bUsername: string;
  delegateUsername: string;
}): Promise<Record<string, never>> {
  const { mall } = deps;
  const anchor = await store.findAnchorByDelegate(mall, params.bUserId, params.delegateUsername);
  if (anchor == null) {
    throw delegationError(DelegationErrorIds.NOT_FOUND, 'No pending delegation request to "' + params.delegateUsername + '"', 404);
  }
  const content = anchor.content as AnchorContent;
  if (content.status !== C.STATUS.INVITE) {
    throw delegationError(DelegationErrorIds.NOT_ACTIVE,
      'This relationship is active; removing it requires a direct account login', 409);
  }

  const capability = await store.findMarkerAccess(mall, params.bUserId, content.relId, C.CLIENTDATA_KIND.INVITE_CAPABILITY);
  if (capability != null) await store.deleteAccessById(mall, params.bUserId, capability.id);
  await store.deleteAnchor(mall, params.bUserId, anchor);

  // Tell A's core to drop the mirror (best-effort).
  try {
    const target = await deps.resolveTarget(params.delegateUsername);
    if (target.found) {
      await deps.deliverInvite(target, {
        action: 'cancel',
        relId: content.relId,
        controlled: { username: params.bUsername, hostSlug: deps.self.hostSlug },
        delegateUsername: params.delegateUsername,
      });
    }
  } catch (_e) { /* mirror lingers until lazy reconciliation */ }

  return {};
}

// ================================================================== lists

/**
 * How a relationship was made: the stored `origin`, else, for a record written
 * before it was stored, the rule those records follow: the create path
 * requests and activates at the same instant, the invite path never does
 * (requested at the invite, activated at the accept, if ever).
 */
function originOf (c: { origin?: unknown; requestedAt?: number; activatedAt?: number }): DelegationOrigin {
  if (c.origin === C.ORIGIN.CREATED || c.origin === C.ORIGIN.ATTACHED) return c.origin;
  return (c.requestedAt != null && c.requestedAt === c.activatedAt) ? C.ORIGIN.CREATED : C.ORIGIN.ATTACHED;
}

async function listDelegates (mall: MallLike, bUserId: string): Promise<{ delegates: Array<Record<string, unknown>> }> {
  const anchors = await store.listAnchors(mall, bUserId);
  const delegates = anchors.map((a) => {
    const c = a.content as AnchorContent;
    return {
      relId: c.relId,
      delegate: { username: c.delegate.username, hostSlug: c.delegate.hostSlug },
      status: c.status,
      origin: originOf(c),
      requestedAt: c.requestedAt,
      activatedAt: c.activatedAt,
      lastTokenIssuedAt: c.lastTokenIssuedAt,
    };
  });
  return { delegates };
}

async function listControlled (mall: MallLike, aUserId: string): Promise<{ controlled: Array<Record<string, unknown>> }> {
  const mirrors = await store.listMirrors(mall, aUserId);
  const controlled = mirrors.map((m) => {
    const c = m.content as MirrorContent;
    return {
      relId: c.relId,
      controlled: { username: c.controlled.username, hostSlug: c.controlled.hostSlug },
      status: c.status,
      origin: originOf(c),
      requestedAt: c.requestedAt,
      activatedAt: c.activatedAt,
    };
  });
  return { controlled };
}

// ------------------------------------------------------------------ helpers

async function dropNotifyAccess (mall: MallLike, userId: string, relId: string): Promise<void> {
  const notify = await store.findMarkerAccess(mall, userId, relId, C.CLIENTDATA_KIND.NOTIFY);
  if (notify != null) await store.deleteAccessById(mall, userId, notify.id);
}

export {
  DelegationError,
  delegationError,
  requestAttach,
  handleSystemInvite,
  acceptAttach,
  handleAcceptResponse,
  handleAcceptComplete,
  refuseAttach,
  handleRefuseResponse,
  cancelInvite,
  listDelegates,
  listControlled,
  originOf,
};
export type {
  Identity,
  TargetResolution,
  PeerResult,
  InvitePayload,
  RequestAttachDeps,
  AcceptRefuseDeps,
  CancelDeps,
  SystemInviteDeps,
  ControlledSideDeps,
};
