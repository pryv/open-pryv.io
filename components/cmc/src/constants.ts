/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin — reserved stream-id namespace + event-type constants.
 *
 * Stream-id model:
 *
 *   :_cmc:                                  reserved root
 *     :_cmc:inbox                           one-shot lifecycle delivery (cross-app)
 *     :_cmc:apps                            parent of user-creatable app scopes
 *       :_cmc:apps:<app-code>               user-creatable app root
 *         <any user-defined path>           (e.g. :study-A, :campaign-2026, ...)
 *           :chats                          plugin-auto-created (chat parent for THIS path)
 *             :chats:<counterparty-slug>   plugin-auto-created per user-pair
 *           :collectors                     plugin-auto-created (system parent for THIS path)
 *             :collectors:<counterparty>   plugin-auto-created per collector-relationship
 *     :_cmc:_internal                       plugin-internal hidden region
 *       :_cmc:_internal:retries             retry queue (per-user, plugin-managed)
 *       :_cmc:_internal:offer:<capId>       per-capability single-event stream
 *       :_cmc:_internal:responses:<capId>   per-capability single-write stream
 *
 * Why nested under app + user-chosen path: an app's access can be scoped
 * to `:_cmc:apps:<app-code>:*` (all the app's data including its chats and
 * collectors), or more granularly to a per-request sub-tree like
 * `:_cmc:apps:<app-code>:<request-slug>:*` (just one cross-account
 * relationship). The chats / collectors sub-segments live under whichever
 * stream the trigger event was written to, so permission scoping is a
 * natural prefix-match.
 *
 * Auto-provisioned at user-creation time: the five reserved parents
 * (`:_cmc:`, `:_cmc:inbox`, `:_cmc:apps`, `:_cmc:_internal`,
 * `:_cmc:_internal:retries`). Everything under `:_cmc:apps:<app-code>`
 * and `:_cmc:_internal:offer:*` / `:_cmc:_internal:responses:*` is
 * created on demand by the user or by the plugin.
 *
 * Design lock: CMC is a plugin (stream-id-namespace owner + orchestration
 * write-hooks), NOT a new storage engine. All :_cmc:* state lives in
 * standard per-user storage. See README.md for the full design.
 */

// --- Reserved root + plugin-managed parent stream-ids ---
//
// All :_cmc:* identifiers compose from NS. If the namespace is ever
// rebranded (e.g. to ':_xchg:' or similar), changing NS alone updates
// every constant + every helper that builds a stream-id, and every
// classification predicate / regex below picks up the new prefix
// automatically.

const NS = ':_cmc:';
const NS_INBOX = NS + 'inbox';
const NS_APPS = NS + 'apps';
const NS_INTERNAL = NS + '_internal';
const NS_INTERNAL_RETRIES = NS_INTERNAL + ':retries';

// The five parents auto-provisioned on every user account.
const RESERVED_PARENT_STREAM_IDS = [
  NS,
  NS_INBOX,
  NS_APPS,
  NS_INTERNAL,
  NS_INTERNAL_RETRIES,
];

// User-creatable region root. Children are owned by the user's apps.
const USER_CREATABLE_PARENT_STREAM_ID = NS_APPS;

// Sub-segments reserved as plugin-managed children of ANY stream under
// `:_cmc:apps:<app-code>:...`. The plugin auto-creates these when acceptance
// happens; user code may not.
const APP_RESERVED_SEGMENTS = ['chats', 'collectors'] as const;

// --- Per-trigger / per-capability stream-id builders ---

/** `<triggerStreamId>:chats` */
function chatsParentUnder (triggerStreamId: string): string {
  return triggerStreamId + ':chats';
}

/** `<triggerStreamId>:chats:<counterparty-slug>` */
function chatStreamUnder (triggerStreamId: string, counterpartySlug: string): string {
  return triggerStreamId + ':chats:' + counterpartySlug;
}

/** `<triggerStreamId>:collectors` */
function collectorsParentUnder (triggerStreamId: string): string {
  return triggerStreamId + ':collectors';
}

/** `<triggerStreamId>:collectors:<counterparty-slug>` */
function collectorStreamUnder (triggerStreamId: string, counterpartySlug: string): string {
  return triggerStreamId + ':collectors:' + counterpartySlug;
}

function offerStreamIdFor (capabilityId: string): string {
  return NS_INTERNAL + ':offer:' + capabilityId;
}

function responsesStreamIdFor (capabilityId: string): string {
  return NS_INTERNAL + ':responses:' + capabilityId;
}

// --- Classification predicates ---

/** Does this stream-id live anywhere under the :_cmc: namespace? */
function isCmcStreamId (streamId: string): boolean {
  return streamId === ':_cmc' || streamId.startsWith(NS);
}

// Matches any stream-id whose path contains `:chats` or `:collectors`
// as a segment underneath `:_cmc:apps:<app-code>:` (any depth).
//
//   :_cmc:apps:foo:chats                           → match
//   :_cmc:apps:foo:chats:alice--ex                 → match
//   :_cmc:apps:foo:study-A:chats                   → match
//   :_cmc:apps:foo:study-A:chats:alice--ex         → match
//   :_cmc:apps:foo:collectors:alice--ex            → match
//   :_cmc:apps:foo:study-A                         → NO match (user-creatable)
//   :_cmc:apps:foo:study-A:chats-style-data        → NO match (segment isn't exactly 'chats')
const APP_NESTED_PLUGIN_RE = /:_cmc:apps:[^:]+(?::[^:]+)*:(chats|collectors)(?::|$)/;

/**
 * True if this id is at or beneath one of the plugin-reserved sub-segments
 * (`chats` or `collectors`) anywhere under `:_cmc:apps:<app-code>:...`.
 * The plugin auto-creates these; user code may not.
 */
function isAppNestedPluginStream (streamId: string): boolean {
  return APP_NESTED_PLUGIN_RE.test(streamId);
}

/**
 * Children under `:_cmc:apps:` that the user may freely create.
 * Excludes the plugin-reserved sub-segments (`chats` / `collectors`).
 */
function isUserCreatableStreamId (streamId: string): boolean {
  if (!streamId.startsWith(NS_APPS + ':')) return false;
  if (isAppNestedPluginStream(streamId)) return false;
  return true;
}

/** True for any :_cmc:* stream that's NOT user-creatable. */
function isPluginManagedStreamId (streamId: string): boolean {
  if (!isCmcStreamId(streamId)) return false;
  return !isUserCreatableStreamId(streamId);
}

/**
 * Plan 68 Phase 4 H5 — true for any stream-id under the plugin-internal
 * subtree (`:_cmc:_internal`, `:_cmc:_internal:retries`,
 * `:_cmc:_internal:offer:*`, `:_cmc:_internal:responses:*`). The
 * defense-in-depth filter on events.get / events.getOne /
 * streams.get uses this so internal events / streams cannot leak via
 * api-server read paths even if an access erroneously has perms on the
 * subtree.
 */
function isCmcInternalStreamId (streamId: string): boolean {
  if (typeof streamId !== 'string') return false;
  return streamId === NS_INTERNAL || streamId.startsWith(NS_INTERNAL + ':');
}

/**
 * Extract the app-code segment for any `:_cmc:apps:<app-code>[:...]` id.
 * Returns null for ids that aren't under `:_cmc:apps:`.
 */
function getAppCode (streamId: string): string | null {
  if (!streamId.startsWith(NS_APPS + ':')) return null;
  const rest = streamId.substring(NS_APPS.length + 1);
  const colonIdx = rest.indexOf(':');
  return colonIdx === -1 ? rest : rest.substring(0, colonIdx);
}

// --- Event-type constants ---

const ET_REQUEST = 'consent/request-cmc';
const ET_ACCEPT = 'consent/accept-cmc';
const ET_REFUSE = 'consent/refuse-cmc';
const ET_REVOKE = 'consent/revoke-cmc';
const ET_CHAT = 'message/chat-cmc';
const ET_SYSTEM_ALERT = 'notification/alert-cmc';
const ET_SYSTEM_ACK = 'notification/ack-cmc';
const ET_SYSTEM_SCOPE_REQUEST = 'consent/scope-request-cmc';
const ET_SYSTEM_SCOPE_UPDATE = 'consent/scope-update-cmc';
const ET_RETRY = 'cmc-internal/retry-cmc';
// Back-channel info delivery (requester → accepter, post-acceptance).
// After the requester mints the back-channel access (handleIncomingAccept),
// they POST one of these to the accepter's :_cmc:inbox via the data-grant
// URL (which now carries inbox create-only). The accepter's plugin updates
// the data-grant access's clientData.cmc.counterparty with the requester's
// apiEndpoint + remote stream-ids so future chat / system deliveries from
// the accepter to the requester resolve cleanly.
const ET_BACK_CHANNEL = 'consent/back-channel-cmc';
// Per-capability invalidation (open-link mode, Phase 2). The requester
// writes this to one of their own `:_cmc:apps:*` streams; the plugin
// flips the capability access state to `'invalidated'` so further
// accepts are rejected by the responses-stream write-hook. Already
// established data-grant + back-channel relationships are NOT touched
// (per-relationship teardown remains `consent/revoke-cmc`).
const ET_INVALIDATE_LINK = 'consent/invalidate-link-cmc';

const EVENT_TYPES_LIFECYCLE = [ET_REQUEST, ET_ACCEPT, ET_REFUSE, ET_REVOKE, ET_BACK_CHANNEL];
const EVENT_TYPES_CHAT = [ET_CHAT];
const EVENT_TYPES_SYSTEM = [
  ET_SYSTEM_ALERT,
  ET_SYSTEM_ACK,
  ET_SYSTEM_SCOPE_REQUEST,
  ET_SYSTEM_SCOPE_UPDATE,
];
// Per-capability lifecycle events (not per-relationship). Today: just
// `consent/invalidate-link-cmc`. Distinct from EVENT_TYPES_LIFECYCLE
// which deals with the relationship lifecycle (request/accept/refuse/
// revoke/back-channel).
const EVENT_TYPES_CAPABILITY = [ET_INVALIDATE_LINK];

const ALL_EVENT_TYPES = [
  ...EVENT_TYPES_LIFECYCLE,
  ...EVENT_TYPES_CHAT,
  ...EVENT_TYPES_SYSTEM,
  ...EVENT_TYPES_CAPABILITY,
  ET_RETRY,
];

const ALL_EVENT_TYPES_SET = new Set(ALL_EVENT_TYPES);

/**
 * True if the given event type is one that the CMC plugin owns
 * (and therefore should be intercepted by the dispatch / hooks).
 *
 * Since the rename to class/format-style types (`consent/*`,
 * `message/chat-cmc`, `notification/cmc-*`, `cmc-internal/retry-cmc`),
 * a single `startsWith('cmc/')` no longer works — the types span
 * four classes. Centralised here so callers don't have to know the
 * full list.
 */
function isCmcEventType (eventType: any): boolean {
  return typeof eventType === 'string' && ALL_EVENT_TYPES_SET.has(eventType);
}

export {
  // namespaces (reserved roots)
  NS,
  NS_INBOX,
  NS_APPS,
  NS_INTERNAL,
  NS_INTERNAL_RETRIES,
  RESERVED_PARENT_STREAM_IDS,
  USER_CREATABLE_PARENT_STREAM_ID,
  APP_RESERVED_SEGMENTS,

  // stream-id builders
  chatsParentUnder,
  chatStreamUnder,
  collectorsParentUnder,
  collectorStreamUnder,
  offerStreamIdFor,
  responsesStreamIdFor,

  // classification predicates
  isCmcStreamId,
  isAppNestedPluginStream,
  isUserCreatableStreamId,
  isPluginManagedStreamId,
  isCmcInternalStreamId,
  getAppCode,

  // event types
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
  ET_BACK_CHANNEL,
  ET_INVALIDATE_LINK,
  EVENT_TYPES_LIFECYCLE,
  EVENT_TYPES_CHAT,
  EVENT_TYPES_SYSTEM,
  EVENT_TYPES_CAPABILITY,
  ALL_EVENT_TYPES,
  isCmcEventType,
};
