/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account-delegation plugin — reserved stream-id namespace + event-type
 * constants.
 *
 * Stream-id model:
 *
 *   :_delegation:                              reserved root
 *     :_delegation:_internal                   plugin-internal hidden region
 *       :_delegation:_internal:delegates       B-side: the delegates this
 *                                              account controls (anchors)
 *       :_delegation:_internal:controlled      A-side: the accounts this
 *                                              account is controlled by (mirrors)
 *       :_delegation:_internal:responses:<rel> per-relationship handshake responses
 *       :_delegation:_internal:notify:<rel>    per-relationship notification channel
 *       :_delegation:_internal:ctl:<rel>       per-relationship control channel
 *
 * The WHOLE `:_delegation:*` namespace is plugin-owned end-to-end. Unlike the
 * cross-account messaging namespace, there is no user-creatable region: user
 * code may neither create, delete, nor write anywhere under `:_delegation:`.
 * The plugin writes via the data-access layer (mall) in later phases; the
 * guard hooks here reject any attempt to reach the namespace via the generic
 * api-server routes.
 *
 * Design lock: delegation is a plugin (stream-id-namespace owner + guard
 * write-hooks), NOT a new storage engine. All `:_delegation:*` state lives in
 * standard per-user storage.
 */

// --- Reserved root + plugin-managed parent stream-ids ---
//
// All `:_delegation:*` identifiers compose from NS. Changing NS alone updates
// every constant + every helper that builds a stream-id, and every
// classification predicate below picks up the new prefix automatically.

const NS = ':_delegation:';
const NS_INTERNAL = NS + '_internal';

// --- Per-relationship / role stream-id builders ---

/** `:_delegation:_internal:delegates` — B-side anchor parent. */
function delegatesStreamId (): string {
  return NS_INTERNAL + ':delegates';
}

/** `:_delegation:_internal:controlled` — A-side mirror parent. */
function controlledStreamId (): string {
  return NS_INTERNAL + ':controlled';
}

/** `:_delegation:_internal:responses:<relId>` */
function responsesStreamIdFor (relId: string): string {
  return NS_INTERNAL + ':responses:' + relId;
}

/** `:_delegation:_internal:notify:<relId>` */
function notifyStreamIdFor (relId: string): string {
  return NS_INTERNAL + ':notify:' + relId;
}

/** `:_delegation:_internal:ctl:<relId>` */
function ctlStreamIdFor (relId: string): string {
  return NS_INTERNAL + ':ctl:' + relId;
}

// The two parents auto-provisioned per delegation-using account.
const RESERVED_PARENT_STREAM_IDS = [
  NS,
  NS_INTERNAL,
];

// --- Classification predicates ---

/** Does this stream-id live anywhere under the `:_delegation:` namespace? */
function isDelegationStreamId (id: string): boolean {
  return id === ':_delegation' || id.startsWith(NS);
}

/**
 * True for any stream-id under the plugin-internal subtree
 * (`:_delegation:_internal`, `:_delegation:_internal:*`).
 */
function isDelegationInternalStreamId (id: string): boolean {
  if (typeof id !== 'string') return false;
  return id === NS_INTERNAL || id.startsWith(NS_INTERNAL + ':');
}

// --- Event-type constants ---

// Common prefix for every delegation-owned event type. User code may not
// write ANY `delegation/*` event via the generic events routes — the plugin
// writes the namespace itself.
const ET_PREFIX = 'delegation/';

// B-side anchor: the delegate record on the controlling account.
const ET_ANCHOR = 'delegation/delegate';
// A-side mirror: the controlled-account record on the controlled account.
const ET_MIRROR = 'delegation/controlled';

const ALL_EVENT_TYPES = [ET_ANCHOR, ET_MIRROR];
const ALL_EVENT_TYPES_SET = new Set(ALL_EVENT_TYPES);

/**
 * True if the given event type is one the delegation plugin owns as a known
 * anchor/mirror type. Note the write-guard additionally blocks any
 * `delegation/*`-prefixed type (see ET_PREFIX) so future types stay reserved
 * even before they are enumerated here.
 */
function isDelegationEventType (type: unknown): boolean {
  return typeof type === 'string' && ALL_EVENT_TYPES_SET.has(type);
}

// --- clientData discriminators + statuses ---

// The `kind` field discriminating a `clientData.delegation` payload.
const CLIENTDATA_KIND = {
  CONTROL: 'control',
  DELEGATE_PAT: 'delegate-pat',
  INVITE_CAPABILITY: 'invite-capability',
  NOTIFY: 'notify',
} as const;

// Relationship lifecycle statuses.
const STATUS = {
  INVITE: 'invite',
  ACTIVE: 'active',
  STALE: 'stale',
} as const;

export {
  // namespaces (reserved roots)
  NS,
  NS_INTERNAL,
  RESERVED_PARENT_STREAM_IDS,

  // stream-id builders
  delegatesStreamId,
  controlledStreamId,
  responsesStreamIdFor,
  notifyStreamIdFor,
  ctlStreamIdFor,

  // classification predicates
  isDelegationStreamId,
  isDelegationInternalStreamId,

  // event types
  ET_PREFIX,
  ET_ANCHOR,
  ET_MIRROR,
  ALL_EVENT_TYPES,
  isDelegationEventType,

  // clientData discriminators + statuses
  CLIENTDATA_KIND,
  STATUS,
};
