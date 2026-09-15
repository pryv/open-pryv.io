/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account-delegation plugin — data model (TypeScript types only).
 *
 * These types describe the anchor (B-side, controlling account) and mirror
 * (A-side, controlled account) records plus the `clientData.delegation`
 * payload the plugin stamps onto its managed accesses. They carry no runtime
 * behaviour — pure shape declarations shared across the plugin and its
 * consumers.
 */

/** Relationship lifecycle status. Mirrors constants.STATUS values. */
type DelegationStatus = 'invite' | 'active' | 'stale';

/** Reference to a delegate account (the account being controlled). */
type DelegateRef = {
  username: string;
  hostSlug: string;
};

/** Reference to a controlled account, from the controlled side's view. */
type ControlledRef = {
  username: string;
  hostSlug: string;
};

/**
 * B-side anchor content — stored on the controlling account. One anchor per
 * delegate the account controls.
 */
type AnchorContent = {
  relId: string;
  delegate: DelegateRef;
  status: DelegationStatus;
  requestedAt: number;
  activatedAt?: number;
  notifyApiEndpoint?: string;
  controlAccessId?: string;
  patAccessId?: string;
};

/**
 * A-side mirror content — stored on the controlled account. One mirror per
 * account that controls this one.
 */
type MirrorContent = {
  relId: string;
  controlled: ControlledRef;
  status: DelegationStatus;
  capabilityUrl?: string;
  controlApiEndpoint?: string;
};

/**
 * The `clientData.delegation` payload the plugin stamps onto managed accesses,
 * discriminated by `kind` (see constants.CLIENTDATA_KIND).
 */
type ClientDataDelegation =
  | { kind: 'control'; relId: string; controlled?: ControlledRef }
  | { kind: 'delegate-pat'; relId: string; delegate?: DelegateRef }
  | { kind: 'invite-capability'; relId: string; capabilityUrl?: string }
  | { kind: 'notify'; relId: string };

export type {
  DelegationStatus,
  DelegateRef,
  ControlledRef,
  AnchorContent,
  MirrorContent,
  ClientDataDelegation,
};
