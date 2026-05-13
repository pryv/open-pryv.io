/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 68 — Cross-account Messaging & Consent (CMC) plugin.
 *
 * Reserved stream-id namespace + event-type constants.
 *
 * Design lock: CMC is a plugin (stream-id-namespace owner + orchestration
 * write-hooks), NOT a new storage engine. All :_cmc:* events / accesses /
 * streams live in standard per-user storage. See _plans/68-cmc-datastore-atwork/
 * in the macroPryv workspace for the full design.
 */

// --- Stream-id namespace ---

// Reserved root + plugin-managed parents (auto-provisioned per user).
const NS = ':_cmc:';
const NS_INBOX = ':_cmc:inbox';
const NS_CHATS = ':_cmc:chats';
const NS_COLLECTORS = ':_cmc:collectors';
const NS_APPS = ':_cmc:apps';
const NS_INTERNAL = ':_cmc:_internal';
const NS_INTERNAL_RETRIES = ':_cmc:_internal:retries';

// Parent streams the plugin auto-creates on every user account.
// `:_cmc:_internal` is plugin-managed but its children are created
// on-demand (capability mints per-capability ephemeral streams).
const RESERVED_PARENT_STREAM_IDS = [
  NS,
  NS_INBOX,
  NS_CHATS,
  NS_COLLECTORS,
  NS_APPS,
  NS_INTERNAL,
  NS_INTERNAL_RETRIES,
];

// Allowed parent for user-created streams under :_cmc:.
const USER_CREATABLE_PARENT_STREAM_ID = NS_APPS;

// --- Stream-id helpers ---

function chatStreamIdFor (counterpartySlug: string): string {
  return NS_CHATS + ':' + counterpartySlug;
}

function collectorStreamIdFor (collectorSlug: string): string {
  return NS_COLLECTORS + ':' + collectorSlug;
}

function offerStreamIdFor (capabilityId: string): string {
  return NS_INTERNAL + ':offer:' + capabilityId;
}

function responsesStreamIdFor (capabilityId: string): string {
  return NS_INTERNAL + ':responses:' + capabilityId;
}

/** Does this stream-id live anywhere under the :_cmc: namespace? */
function isCmcStreamId (streamId: string): boolean {
  // Children are :_cmc:foo, :_cmc:foo:bar etc. — all start with `:_cmc:`.
  // The bare root form `:_cmc` (no trailing colon) is also accepted as a hint.
  return streamId === ':_cmc' || streamId.startsWith(NS);
}

/** Is this stream-id plugin-managed (i.e. user code may not directly create / mutate)? */
function isPluginManagedStreamId (streamId: string): boolean {
  if (!isCmcStreamId(streamId)) return false;
  // User-creatable: anything under :_cmc:apps (the only user-writable parent).
  if (streamId === NS_APPS) return true; // the parent itself is plugin-managed; children are user-creatable
  if (streamId.startsWith(NS_APPS + ':')) return false;
  return true;
}

/** Children of :_cmc:apps (or deeper). User code may streams.create under here. */
function isUserCreatableStreamId (streamId: string): boolean {
  return streamId.startsWith(NS_APPS + ':');
}

// --- Event-type constants ---

const ET_REQUEST = 'cmc/request-v1';
const ET_ACCEPT = 'cmc/accept-v1';
const ET_REFUSE = 'cmc/refuse-v1';
const ET_REVOKE = 'cmc/revoke-v1';
const ET_CHAT = 'cmc/chat-v1';
const ET_SYSTEM_ALERT = 'cmc/system-alert-v1';
const ET_SYSTEM_ACK = 'cmc/system-ack-v1';
const ET_SYSTEM_SCOPE_REQUEST = 'cmc/system-scope-request-v1';
const ET_SYSTEM_SCOPE_UPDATE = 'cmc/system-scope-update-v1';

// Internal types (plugin-only, retry queue, etc.)
const ET_RETRY = 'cmc/retry-v1';

const EVENT_TYPES_LIFECYCLE = [ET_REQUEST, ET_ACCEPT, ET_REFUSE, ET_REVOKE];
const EVENT_TYPES_CHAT = [ET_CHAT];
const EVENT_TYPES_SYSTEM = [
  ET_SYSTEM_ALERT,
  ET_SYSTEM_ACK,
  ET_SYSTEM_SCOPE_REQUEST,
  ET_SYSTEM_SCOPE_UPDATE,
];

const ALL_EVENT_TYPES = [
  ...EVENT_TYPES_LIFECYCLE,
  ...EVENT_TYPES_CHAT,
  ...EVENT_TYPES_SYSTEM,
  ET_RETRY,
];

export {
  // namespaces
  NS,
  NS_INBOX,
  NS_CHATS,
  NS_COLLECTORS,
  NS_APPS,
  NS_INTERNAL,
  NS_INTERNAL_RETRIES,
  RESERVED_PARENT_STREAM_IDS,
  USER_CREATABLE_PARENT_STREAM_ID,

  // stream-id helpers
  chatStreamIdFor,
  collectorStreamIdFor,
  offerStreamIdFor,
  responsesStreamIdFor,
  isCmcStreamId,
  isPluginManagedStreamId,
  isUserCreatableStreamId,

  // event-types
  ET_REQUEST,
  ET_ACCEPT,
  ET_REFUSE,
  ET_REVOKE,
  ET_CHAT,
  ET_SYSTEM_ALERT,
  ET_SYSTEM_ACK,
  ET_SYSTEM_SCOPE_REQUEST,
  ET_SYSTEM_SCOPE_UPDATE,
  ET_RETRY,
  EVENT_TYPES_LIFECYCLE,
  EVENT_TYPES_CHAT,
  EVENT_TYPES_SYSTEM,
  ALL_EVENT_TYPES,
};
