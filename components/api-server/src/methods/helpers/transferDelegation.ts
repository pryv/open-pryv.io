/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The delegation steps an account transfer runs on the owner's behalf. The
 * delegation methods register them at boot (they hold the cross-core
 * delivery); absent when delegation is off on this core, and transfers are
 * then not offered.
 */

type UserRef = { id: string; username: string };

export type RelationshipState = {
  status: 'active' | 'invite' | 'stale' | 'none';
  relId?: string;
  hostSlug?: string;
  /** A pending invite whose capability has expired (or is gone). */
  expired?: boolean;
};

export type TransferDelegation = {
  /** The owner's side of `delegations.requestAttach`: invites `delegateUsername` to control the owner's account. */
  invite (owner: UserRef, delegateUsername: string, ttlSeconds: number): Promise<{ relId: string; hostSlug?: string }>;
  /** The owner's relationship to `delegateUsername`. */
  stateOf (owner: UserRef, delegateUsername: string): Promise<RelationshipState>;
  /** Withdraws a pending invite (the owner's side of `delegations.cancelInvite`); nothing when there is none. */
  withdraw (owner: UserRef, delegateUsername: string): Promise<void>;
};

let registered: TransferDelegation | null = null;

export function setTransferDelegation (delegation: TransferDelegation | null): void {
  registered = delegation;
}

export function getTransferDelegation (): TransferDelegation | null {
  return registered;
}
