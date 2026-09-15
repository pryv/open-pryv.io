/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account-delegation plugin — delegate PAT (personal access token) mint.
 *
 * Two functions, one per side of the same-platform relationship:
 *
 *   handleIssueToken — runs on the CONTROLLED account's core (B), authenticated
 *     by the forge-protected `control` marker access. It mints a session-backed
 *     personal-class access exactly the way the login flow does: reuse (or
 *     generate) a session keyed on the login appId, then create-or-update the
 *     `type:'personal'` access whose token IS that session id. The only
 *     difference from a genuine login is the forge-protected
 *     `clientData.delegation` stamp that marks the token as a delegate PAT — the
 *     token is otherwise a full owner-equivalent personal token. Idempotent:
 *     re-issue reuses the same session + the same access (create-or-update keyed
 *     on {name, type:personal}), never a second.
 *
 *   getToken — runs on the DELEGATE's core (A), gated on A's personal token. It
 *     loads the mirror's control endpoint SERVER-SIDE (the control token never
 *     reaches A's client) and calls handleIssueToken on B (same-core direct
 *     dispatch or cross-core postToPeer). It returns the PAT + B's apiEndpoint to
 *     A's client — the product: A's client then talks to B's core directly.
 *
 * Pure module: the session mint and all storage arrive via injected deps, so the
 * whole mint is unit-testable with a fake mall and a fake session generator.
 */

import * as C from './constants.ts';
import { DelegationErrorIds } from './errorIds.ts';
import * as store from './store.ts';
import type { MallLike } from './store.ts';
import type { AnchorContent, MirrorContent } from './model.ts';
import { DelegationError } from './attach.ts';

function delegationError (id: string, message: string, httpStatus: number, data?: Record<string, unknown>): DelegationError {
  return new DelegationError(id, message, httpStatus, data);
}

// ------------------------------------------------------------------ deps shapes

type IssueTokenDeps = {
  mall: MallLike;
  now: () => number;
  /**
   * Reuse-or-generate a session for {username, appId} and return its id — the
   * exact login-flow `sessionsStorage.getMatching(...) else generate(...)`
   * behaviour, injected so this module stays free of storage-layer imports. The
   * returned id becomes the PAT token.
   */
  mintSession: (username: string, appId: string) => Promise<string>;
};

type PeerResult = { ok: boolean; status: number; body: unknown };

type GetTokenDeps = {
  mall: MallLike;
  now: () => number;
  /**
   * Call the controlled-side `issueToken` for a relationship. The api-server
   * wires this to a same-core direct dispatch or a cross-core `postToPeer` to
   * the control endpoint; either way it returns `{ token, apiEndpoint }` on
   * success (peer 401/403 → the mirror is stale).
   */
  callControl: (controlApiEndpoint: string, relId: string) => Promise<PeerResult>;
};

// ============================================================ B-side: mint

/**
 * The login appId that names both the session and the personal access for a
 * delegate. Deterministic per (delegate username, delegate hostSlug) so
 * re-issue always resolves the SAME session + access.
 */
function delegateAppId (delegate: { username: string; hostSlug: string }): string {
  return 'delegation:' + delegate.username + '@' + delegate.hostSlug;
}

/**
 * handleIssueToken — mint (or refresh) the delegate PAT on the controlled
 * account. See the module header. Authorization (kind `control` marker + relId)
 * is enforced by the calling method's marker gate; here we additionally require
 * the anchor to be present and active, and — when the caller can name the
 * delegate it authenticated as — that it matches the anchor's recorded delegate.
 */
async function handleIssueToken (deps: IssueTokenDeps, params: {
  bUserId: string;
  bUsername: string;
  relId: string;
  /** The delegate username the caller authenticated as (control marker on the
   * cross-core path; A's own identity on the same-core path). Verified against
   * the anchor when provided. */
  expectDelegateUsername?: string;
}): Promise<{ token: string; apiEndpoint: string }> {
  const { mall, now } = deps;

  const anchor = await store.findAnchorByRelId(mall, params.bUserId, params.relId);
  if (anchor == null) {
    throw delegationError(DelegationErrorIds.NOT_ACTIVE,
      'This delegation relationship is not active', 410);
  }
  const content = anchor.content as AnchorContent;
  if (content.status !== C.STATUS.ACTIVE) {
    throw delegationError(DelegationErrorIds.NOT_ACTIVE,
      'This delegation relationship is not active', 410);
  }

  // The delegate identity is taken from the forge-protected anchor — never from
  // caller input — so the PAT's appId + marker can never carry a caller-chosen
  // identity. When the caller names the delegate it authenticated as, verify it.
  const delegate = content.delegate;
  if (params.expectDelegateUsername != null &&
      delegate?.username?.toLowerCase() !== params.expectDelegateUsername.toLowerCase()) {
    throw delegationError(DelegationErrorIds.DELEGATE_MISMATCH,
      'The delegate identity does not match this delegation relationship', 403);
  }

  const appId = delegateAppId(delegate);
  const token = await deps.mintSession(params.bUsername, appId);

  const clientDataDelegation = {
    kind: C.CLIENTDATA_KIND.DELEGATE_PAT,
    relId: params.relId,
    delegate: { username: delegate.username, hostSlug: delegate.hostSlug },
  };

  // Create-or-update the personal access keyed on {name: appId, type: personal},
  // mirroring the login flow — including the duplicate-race recovery (a
  // concurrent issue between the lookup and the insert collides on the storage
  // (type, name) uniqueness; re-look-up and update).
  let pat = await store.findAccessByNameType(mall, params.bUserId, appId, 'personal');
  if (pat == null) {
    try {
      pat = await store.mintPersonalAccess(mall, params.bUserId, {
        name: appId, token, clientDataDelegation,
      });
    } catch (err) {
      if (isDuplicateErr(err)) {
        pat = await store.findAccessByNameType(mall, params.bUserId, appId, 'personal');
      }
      if (pat == null) throw err;
      pat = await store.updateAccessFields(mall, params.bUserId, pat.id, {
        token, clientData: { delegation: clientDataDelegation },
      });
    }
  } else {
    // Existing PAT: rotate the token to the (re)resolved session id and refresh
    // the marker. Re-issue extends the PAT exactly as a re-login would.
    pat = await store.updateAccessFields(mall, params.bUserId, pat.id, {
      token, clientData: { delegation: clientDataDelegation },
    });
  }

  if (pat?.apiEndpoint == null) {
    throw delegationError(DelegationErrorIds.CREATION_FAILED,
      'Could not provision the delegate token endpoint', 502);
  }

  // Anchor bookkeeping: last issuance time + the PAT access id (used by the
  // detach sweep to find + destroy the PAT and its backing session).
  await store.updateAnchorContent(mall, params.bUserId, anchor, {
    lastTokenIssuedAt: now(),
    patAccessId: pat.id,
  });

  return { token, apiEndpoint: pat.apiEndpoint };
}

// ============================================================ A-side: wrapper

/**
 * getToken — A-side wrapper. Loads the mirror's control endpoint server-side and
 * issues the PAT on B. On a peer 401/403 (the control access no longer
 * authorizes — the relationship was torn down on B) the mirror is flipped to
 * `stale` and `delegation-not-active` is surfaced.
 */
async function getToken (deps: GetTokenDeps, params: {
  aUserId: string;
  controlledUsername: string;
}): Promise<{ token: string; apiEndpoint: string }> {
  const { mall } = deps;
  const mirror = await store.findMirrorByControlled(mall, params.aUserId, params.controlledUsername);
  if (mirror == null) {
    throw delegationError(DelegationErrorIds.NOT_FOUND,
      'No delegation relationship with "' + params.controlledUsername + '"', 404);
  }
  const content = mirror.content as MirrorContent;
  if (content.status !== C.STATUS.ACTIVE || content.controlApiEndpoint == null) {
    throw delegationError(DelegationErrorIds.NOT_ACTIVE,
      'This delegation relationship is not active', 410);
  }

  let peer: PeerResult;
  try {
    peer = await deps.callControl(content.controlApiEndpoint, content.relId);
  } catch (err) {
    throw delegationError(DelegationErrorIds.DELIVERY_FAILED,
      'Could not reach the controlled account core to issue a token', 503,
      { cause: String((err as Error)?.message || err) });
  }

  if (!peer.ok) {
    if (peer.status === 401 || peer.status === 403) {
      // The control credential is gone on B → lazy reconciliation: mark stale.
      await store.updateMirrorContent(mall, params.aUserId, mirror, { status: C.STATUS.STALE });
      throw delegationError(DelegationErrorIds.NOT_ACTIVE,
        'This delegation relationship is no longer active on the controlled account', 410,
        { peerStatus: peer.status });
    }
    throw delegationError(DelegationErrorIds.DELIVERY_FAILED,
      'The controlled account core did not issue a token', 503, { peerStatus: peer.status });
  }

  const body = (peer.body ?? {}) as { token?: string; apiEndpoint?: string };
  if (body.token == null || body.apiEndpoint == null) {
    throw delegationError(DelegationErrorIds.DELIVERY_FAILED,
      'The controlled account core returned an incomplete token response', 502);
  }
  return { token: body.token, apiEndpoint: body.apiEndpoint };
}

// ------------------------------------------------------------------ helpers

/** Duplicate/uniqueness-violation classifier (personal access (type,name)). */
function isDuplicateErr (err: unknown): boolean {
  const e = err as { id?: string; isDuplicate?: boolean; data?: { id?: string }; message?: string };
  if (e?.isDuplicate === true) return true;
  const id = e?.id || e?.data?.id;
  if (id === 'item-already-exists' || id === 'duplicate') return true;
  const msg = String(e?.message || err).toLowerCase();
  return msg.includes('already exists') || msg.includes('duplicate');
}

export { handleIssueToken, getToken, delegateAppId };
export type { IssueTokenDeps, GetTokenDeps, PeerResult };
