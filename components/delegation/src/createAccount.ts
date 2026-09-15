/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account-delegation plugin — create-from-delegate orchestration.
 *
 * A brand-new controlled account (B) is created directly by a delegate (A),
 * active at birth with no consent handshake (the immediate/no-consent path,
 * distinct from the B-initiated attach handshake). Two functions, one per side
 * of the same-platform relationship:
 *
 *   createAccount — runs on the DELEGATE's core (A), gated on A's personal
 *     token. It validates the requested username, picks the target core (the
 *     `core` param, validated against the platform core list; default = A's own
 *     core), pre-provisions the A-side notify access (its endpoint is the
 *     Phase-4 teardown mirror-sync channel), then calls the target core's system
 *     endpoint. On success it writes A's immediately-active mirror. The relId is
 *     minted on A and echoed by the target — the same discipline the invite path
 *     uses (B mints the relId there), so the notify marker can carry it before
 *     the round trip.
 *
 *   handleSystemCreateAccount — runs on the TARGET core (B's core), reached
 *     cross-core behind the admin-key `/system/*` gate (or in-process on the
 *     same-core fast path). It claims the username platform-wide, creates the
 *     user through the business repository path (optional email, optional
 *     password → random unguessable hash), writes the immediately-active anchor,
 *     mints the control access, and returns the control endpoint. Any failure
 *     AFTER the username claim rolls the whole account back (release the claim +
 *     delete the partial user) so a half-created account never lingers.
 *
 * Pure module: the account provisioning (platform claim + repository insert), its
 * rollback, all storage, and the cross-core delivery arrive via injected deps, so
 * the whole flow is unit-testable with fakes and no api-server / business imports.
 */

import * as C from './constants.ts';
import { DelegationErrorIds } from './errorIds.ts';
import * as store from './store.ts';
import type { MallLike } from './store.ts';
import type { AnchorContent, MirrorContent } from './model.ts';
import { DelegationError, delegationError } from './attach.ts';

// ------------------------------------------------------------------ deps shapes

type Identity = { host: string; hostSlug: string };
type PeerResult = { ok: boolean; status: number; body: unknown };

/** Resolution of the target core for a create-from-delegate request. */
type CoreResolution = {
  isSelf: boolean;       // does the target core host on THIS core?
  hostSlug: string;      // target core host slug (stamped into the mirror)
  host: string;
  coreBaseUrl?: string;  // set when cross-core
};

/** The account-provisioning result on the target core. */
type ProvisionResult = { userId: string };

/** Params the target core needs to claim + create the account. */
type ProvisionParams = {
  username: string;
  email?: string;
  password?: string;
  language?: string;
};

type CreateAccountDeps = {
  mall: MallLike;
  now: () => number;
  idGen: () => string;
  self: Identity;        // acting (A) core identity
  /**
   * Validate the requested `core` param against the platform core registry and
   * resolve it to a target. `undefined`/empty → A's own core. Unknown core →
   * throws DelegationError(delegation-unknown-core, 400).
   */
  resolveTargetCore: (core: string | undefined) => Promise<CoreResolution>;
  /**
   * Deliver the create-account request to the target core: same-core dispatches
   * directly to handleSystemCreateAccount; cross-core posts to
   * `/system/delegation/create-account` with the admin key.
   */
  callCreateAccount: (target: CoreResolution, payload: CreateAccountPayload) => Promise<PeerResult>;
};

type SystemCreateAccountDeps = {
  mall: MallLike;
  now: () => number;
  self: Identity;        // acting (B) core identity — its hostSlug is echoed to A
  /**
   * Claim the username platform-wide and create the user through the business
   * repository path. Throws DelegationError(delegation-username-taken, 409) on a
   * name conflict, or DelegationError(delegation-creation-failed, 502) on any
   * other creation failure (releasing its own claim first).
   */
  provisionAccount: (params: ProvisionParams) => Promise<ProvisionResult>;
  /**
   * Roll a just-created account fully back — release the platform username claim
   * AND delete the user's data — when a post-creation step (anchor/control mint)
   * fails. Best-effort; never throws through the caller's error.
   */
  rollbackAccount: (username: string, userId: string) => Promise<void>;
};

// ------------------------------------------------------------------- payloads

type CreateAccountPayload = {
  relId: string;
  username: string;
  email?: string;
  password?: string;
  language?: string;
  delegate: { username: string; hostSlug: string };
  notifyApiEndpoint?: string;
};

type CreateAccountResponse = {
  controlApiEndpoint: string;
  relId: string;
  controlledHostSlug: string;
};

// ------------------------------------------------------------------ error type

/** Duck-typed guard for a DelegationError crossing the injected-dep boundary. */
function isDelegationErr (e: unknown): e is DelegationError {
  return e != null && typeof (e as { id?: unknown }).id === 'string' &&
    typeof (e as { httpStatus?: unknown }).httpStatus === 'number';
}

// ============================================================ A-side: create

/**
 * createAccount — A creates a brand-new controlled account, active at birth.
 * Atomic from A's view: on any delivery/creation failure the pre-provisioned
 * notify access is swept so A is left with no dangling half-relationship.
 */
async function createAccount (deps: CreateAccountDeps, params: {
  aUserId: string;
  aUsername: string;
  username: string;
  email?: string;
  password?: string;
  core?: string;
  language?: string;
}): Promise<{ delegation: Record<string, unknown>; apiEndpoint?: string }> {
  const { mall, now, idGen, self } = deps;
  const username = String(params.username || '').trim();
  if (username.length === 0) {
    throw delegationError(DelegationErrorIds.UNKNOWN_USERNAME, 'A username for the new account is required', 400);
  }
  if (username.toLowerCase() === params.aUsername.toLowerCase()) {
    throw delegationError(DelegationErrorIds.SELF_NOT_ALLOWED, 'An account may not delegate to itself', 400);
  }

  // Validate + resolve the target core (throws delegation-unknown-core on a bad
  // `core` param). Default = A's own core.
  const target = await deps.resolveTargetCore(params.core);

  const relId = idGen();

  // Pre-provision the A-side notify access — its endpoint is handed to the target
  // core and stored on B's anchor for the Phase-4 teardown mirror-sync channel.
  await store.ensureParents(mall, params.aUserId);
  const notify = await store.mintMarkerAccess(mall, params.aUserId, {
    name: '__deleg-ntf-' + relId.substring(0, 8),
    clientDataDelegation: { kind: C.CLIENTDATA_KIND.NOTIFY, relId },
    expires: null,
  });
  const notifyApiEndpoint = notify.apiEndpoint;

  const payload: CreateAccountPayload = {
    relId,
    username,
    email: params.email,
    password: params.password,
    language: params.language,
    delegate: { username: params.aUsername, hostSlug: self.hostSlug },
    notifyApiEndpoint,
  };

  let peer: PeerResult;
  try {
    peer = await deps.callCreateAccount(target, payload);
  } catch (err) {
    await sweepNotify(mall, params.aUserId, relId);
    throw delegationError(DelegationErrorIds.CREATION_FAILED,
      'Could not reach the target core to create the delegated account', 502,
      { cause: String((err as Error)?.message || err) });
  }
  if (!peer.ok) {
    await sweepNotify(mall, params.aUserId, relId);
    throw mapCreateFailure(peer);
  }

  const body = (peer.body ?? {}) as Partial<CreateAccountResponse>;
  if (body.controlApiEndpoint == null) {
    await sweepNotify(mall, params.aUserId, relId);
    throw delegationError(DelegationErrorIds.CREATION_FAILED,
      'The target core returned an incomplete create response', 502);
  }
  const controlledHostSlug = body.controlledHostSlug ?? target.hostSlug;
  const activatedAt = now();

  const mirrorContent: MirrorContent = {
    relId,
    controlled: { username, hostSlug: controlledHostSlug },
    status: C.STATUS.ACTIVE,
    controlApiEndpoint: body.controlApiEndpoint,
    requestedAt: activatedAt,
    activatedAt,
  };
  await store.createMirror(mall, params.aUserId, mirrorContent, now);

  return {
    delegation: {
      relId,
      controlled: { username, hostSlug: controlledHostSlug },
      status: C.STATUS.ACTIVE,
      activatedAt,
    },
  };
}

/** Map a non-ok create-account peer response to the right DelegationError. */
function mapCreateFailure (peer: PeerResult): DelegationError {
  const body = (peer.body ?? {}) as { id?: string; error?: { id?: string } };
  const bodyId = body?.error?.id || body?.id;
  if (peer.status === 409 || bodyId === DelegationErrorIds.USERNAME_TAKEN) {
    return delegationError(DelegationErrorIds.USERNAME_TAKEN,
      'The requested username is already taken', 409);
  }
  if (bodyId === DelegationErrorIds.UNKNOWN_CORE) {
    return delegationError(DelegationErrorIds.UNKNOWN_CORE,
      'The target core is unknown to this platform', 400);
  }
  return delegationError(DelegationErrorIds.CREATION_FAILED,
    'The target core could not create the delegated account', 502, { peerStatus: peer.status });
}

async function sweepNotify (mall: MallLike, aUserId: string, relId: string): Promise<void> {
  const notify = await store.findMarkerAccess(mall, aUserId, relId, C.CLIENTDATA_KIND.NOTIFY);
  if (notify != null) await store.deleteAccessById(mall, aUserId, notify.id);
}

// ==================================================== target core: provision

/**
 * handleSystemCreateAccount — runs on B's core. Claims + creates the account,
 * then writes the immediately-active anchor and mints the control access. On any
 * failure AFTER the account exists, the whole account is rolled back (claim +
 * user data) so no orphaned account survives.
 *
 * The relId is A-minted and carried in the payload; it is echoed back so A can
 * confirm the relationship it opened. The delegate identity stamped into the
 * control marker and the anchor comes from the payload's `delegate` (A's own
 * verified identity on A's core), never re-derived here.
 */
async function handleSystemCreateAccount (deps: SystemCreateAccountDeps, payload: CreateAccountPayload): Promise<CreateAccountResponse> {
  const { mall, now, self } = deps;
  const relId = String(payload.relId || '').trim();
  if (relId.length === 0) {
    throw delegationError(DelegationErrorIds.CREATION_FAILED, 'A relationship id is required', 400);
  }
  const delegate = payload.delegate;
  if (delegate?.username == null) {
    throw delegationError(DelegationErrorIds.CREATION_FAILED, 'A delegate identity is required', 400);
  }

  // 1. Claim the username platform-wide + create the user (optional email,
  //    optional password → random hash). Throws username-taken / creation-failed.
  const { userId } = await deps.provisionAccount({
    username: payload.username,
    email: payload.email,
    password: payload.password,
    language: payload.language,
  });

  // 2. Provision the delegation substrate on B: control access + active anchor.
  //    Any failure here rolls the freshly-created account fully back.
  try {
    await store.ensureParents(mall, userId);

    const control = await store.mintMarkerAccess(mall, userId, {
      name: '__deleg-ctl-' + relId.substring(0, 8),
      clientDataDelegation: {
        kind: C.CLIENTDATA_KIND.CONTROL,
        relId,
        delegate: { username: delegate.username, hostSlug: delegate.hostSlug },
      },
      expires: null,
    });
    if (control.apiEndpoint == null) {
      throw delegationError(DelegationErrorIds.CREATION_FAILED, 'The control access has no reachable endpoint', 502);
    }

    const activatedAt = now();
    const anchorContent: AnchorContent = {
      relId,
      delegate: { username: delegate.username, hostSlug: delegate.hostSlug },
      status: C.STATUS.ACTIVE,
      requestedAt: activatedAt,
      activatedAt,
      notifyApiEndpoint: payload.notifyApiEndpoint,
      controlAccessId: control.id,
    };
    await store.createAnchor(mall, userId, anchorContent, now);

    return { controlApiEndpoint: control.apiEndpoint, relId, controlledHostSlug: self.hostSlug };
  } catch (err) {
    // Roll the whole account back: release the platform claim + delete the user
    // data. Best-effort — the original failure must surface.
    try { await deps.rollbackAccount(payload.username, userId); } catch (_e) { /* surface original */ }
    if (isDelegationErr(err)) throw err;
    throw delegationError(DelegationErrorIds.CREATION_FAILED,
      'Could not provision the delegation relationship for the new account', 502,
      { cause: String((err as Error)?.message || err) });
  }
}

export { createAccount, handleSystemCreateAccount };
export type {
  CreateAccountDeps,
  SystemCreateAccountDeps,
  CreateAccountPayload,
  CreateAccountResponse,
  CoreResolution,
  ProvisionParams,
  ProvisionResult,
};
