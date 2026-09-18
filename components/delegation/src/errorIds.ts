/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account-delegation plugin — typed error-id catalogue.
 *
 * Stable, kebab-case `error.id` strings the plugin emits via Pryv API error
 * responses. Clients can pattern-match on these strings to drive per-outcome
 * UX without parsing English `error.message`.
 *
 * Naming convention: `delegation-<subject>-<state>`. This set is the
 * authoritative catalogue — every new error.id the plugin introduces should
 * land here first and be referenced everywhere else via
 * `DelegationErrorIds.<NAME>`.
 *
 * Only the guard-hook ids are wired in the first phase; the remaining entries
 * are pre-enumerated so the catalogue stays stable as later phases (handshake
 * / PAT / detach / create) land.
 */

const DelegationErrorIds = {
  // --- Guard hooks (wired) ---

  // User code attempted to write under the `clientData.delegation` namespace
  // via the api-server accesses.create / accesses.update routes. That
  // namespace is plugin-owned end-to-end; the plugin populates it via the
  // data-access layer during the delegation handshake. Allowing user-supplied
  // values would let a malicious app forge a delegation marker on its own
  // access, bypassing the handshake entirely. Reject up-front.
  CLIENTDATA_FORBIDDEN: 'delegation-clientdata-forbidden',

  // Lifecycle protection: a delegation-marker access or event (one carrying
  // `clientData.delegation`, or living in the `:_delegation:*` namespace) may
  // not be deleted or updated via the generic accesses.* / events.* APIs by
  // ANY token. The plugin owns these resources and manages their lifecycle
  // itself; removing or mutating one out of band would silently break an
  // active delegation relationship.
  MANAGED_RESOURCE: 'delegation-managed-resource',

  // Namespace stream create/delete/write protection. The whole
  // `:_delegation:*` stream namespace is plugin-managed and auto-provisioned;
  // user code may neither create, delete, nor write events into it.
  RESERVED_STREAM: 'delegation-reserved-stream',

  // --- Handshake / lifecycle (pre-enumerated; not wired in this phase) ---

  // The delegate/controlling username supplied for a delegation request does
  // not resolve to a known account.
  UNKNOWN_USERNAME: 'delegation-unknown-username',
  // An account may not delegate to (or be controlled by) itself.
  SELF_NOT_ALLOWED: 'delegation-self-not-allowed',
  // The delegate identity supplied on an accept response does not match the one
  // recorded on the controlled account's anchor for that relationship.
  DELEGATE_MISMATCH: 'delegation-delegate-mismatch',
  // A delegation relationship for this pair already exists.
  ALREADY_EXISTS: 'delegation-already-exists',
  // Delivery of a delegation message to the counterparty core failed.
  DELIVERY_FAILED: 'delegation-delivery-failed',
  // The operation requires a genuine (freshly authenticated) login, not a
  // long-lived token — e.g. accepting or detaching a delegation.
  GENUINE_LOGIN_REQUIRED: 'delegation-genuine-login-required',
  // The referenced delegation relationship / resource was not found.
  NOT_FOUND: 'delegation-not-found',
  // The delegation invite has expired.
  INVITE_EXPIRED: 'delegation-invite-expired',
  // The delegation relationship exists but is not in the active state.
  NOT_ACTIVE: 'delegation-not-active',
  // The requested username for a created delegate account is already taken.
  USERNAME_TAKEN: 'delegation-username-taken',
  // The counterparty core could not be resolved / is unknown to this platform.
  UNKNOWN_CORE: 'delegation-unknown-core',
  // Creation of the delegate account / relationship failed.
  CREATION_FAILED: 'delegation-creation-failed',
  // The operation requires a personal token (provably present + authenticated
  // user) but was attempted with an app / shared token.
  PERSONAL_TOKEN_REQUIRED: 'delegation-personal-token-required',
  // A local mirror-dismissal (Dismiss) was attempted on a mirror that is not in
  // the `stale` state. Only a stale mirror is locally deletable housekeeping; a
  // live (invite/active) relationship must not be dropped from the delegate's
  // view this way.
  MIRROR_NOT_STALE: 'delegation-mirror-not-stale',
  // A token obtained through a delegation (the delegate token, or an access
  // granted with it) tried to create a durable grant through a path that does
  // not record the delegation (OAuth2 consent, CMC data grants and offers). Only the
  // account owner may do so, until those paths carry the lineage marker.
  GRANT_REQUIRES_OWNER: 'delegation-grant-requires-owner',
} as const;

type DelegationErrorId = (typeof DelegationErrorIds)[keyof typeof DelegationErrorIds];

export { DelegationErrorIds };
export type { DelegationErrorId };
