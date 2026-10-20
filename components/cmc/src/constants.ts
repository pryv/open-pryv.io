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
 *       :_cmc:_internal:members             group-member ledger (plugin-managed)
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
 * Auto-provisioned at user-creation time: the six reserved parents
 * (`:_cmc:`, `:_cmc:inbox`, `:_cmc:apps`, `:_cmc:_internal`,
 * `:_cmc:_internal:retries`, `:_cmc:_internal:members`). Everything under `:_cmc:apps:<app-code>`
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
// The group-member ledger: one record per child access the group's core
// minted on a patient's core for a member (memberLedger.ts). Hidden like the
// retry queue; created lazily on accounts provisioned before it existed.
const NS_INTERNAL_MEMBERS = NS_INTERNAL + ':members';

// The six parents auto-provisioned on every user account.
const RESERVED_PARENT_STREAM_IDS = [
  NS,
  NS_INBOX,
  NS_APPS,
  NS_INTERNAL,
  NS_INTERNAL_RETRIES,
  NS_INTERNAL_MEMBERS,
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

/** Inverse of `responsesStreamIdFor`: the capability id, or null for any other stream id. */
function capabilityIdFromResponsesStreamId (streamId: string): string | null {
  const prefix = NS_INTERNAL + ':responses:';
  if (typeof streamId !== 'string' || !streamId.startsWith(prefix)) return null;
  const capabilityId = streamId.slice(prefix.length);
  return capabilityId.length > 0 && !capabilityId.includes(':') ? capabilityId : null;
}

// --- Classification predicates ---

// The mall addresses the local store by a `:local:` id prefix: `:local:<id>`
// resolves to the very same stream as `<id>` (storeDataUtils.parseStoreId...
// routes `local` to the account's main storage, where every `:_cmc:*` stream
// lives). A raw-string guard that tests `:local::_cmc:...` would therefore see
// a non-matching string and pass, while the write reaches the reserved stream.
// Every classification below is fed through this first, so the prefixed alias
// is judged as the canonical id it resolves to.
const LOCAL_STORE_PREFIX = ':local:';

/** Strip any leading `:local:` store prefix(es), returning the canonical id. */
function canonicalLocalStreamId (streamId: unknown): string | unknown {
  if (typeof streamId !== 'string') return streamId;
  let id = streamId;
  while (id.startsWith(LOCAL_STORE_PREFIX)) id = id.slice(LOCAL_STORE_PREFIX.length);
  return id;
}

/** Does this stream-id live anywhere under the :_cmc: namespace? */
function isCmcStreamId (streamId: string): boolean {
  const id = canonicalLocalStreamId(streamId) as string;
  if (typeof id !== 'string') return false;
  return id === ':_cmc' || id.startsWith(NS);
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
  const id = canonicalLocalStreamId(streamId);
  if (typeof id !== 'string') return false;
  return APP_NESTED_PLUGIN_RE.test(id);
}

/**
 * Children under `:_cmc:apps:` that the user may freely create.
 * Excludes the plugin-reserved sub-segments (`chats` / `collectors`).
 */
function isUserCreatableStreamId (streamId: string): boolean {
  const id = canonicalLocalStreamId(streamId);
  if (typeof id !== 'string') return false;
  if (!id.startsWith(NS_APPS + ':')) return false;
  if (isAppNestedPluginStream(id)) return false;
  return true;
}

/** True for any :_cmc:* stream that's NOT user-creatable. */
function isPluginManagedStreamId (streamId: string): boolean {
  if (!isCmcStreamId(streamId)) return false;
  return !isUserCreatableStreamId(streamId);
}

/**
 * True for any stream-id under the plugin-internal subtree
 * (`:_cmc:_internal`, `:_cmc:_internal:retries`,
 * `:_cmc:_internal:offer:*`, `:_cmc:_internal:responses:*`). The
 * defense-in-depth filter on events.get / events.getOne /
 * streams.get uses this so internal events / streams cannot leak via
 * api-server read paths even if an access erroneously has perms on the
 * subtree.
 */
function isCmcInternalStreamId (streamId: string): boolean {
  const id = canonicalLocalStreamId(streamId);
  if (typeof id !== 'string') return false;
  return id === NS_INTERNAL || id.startsWith(NS_INTERNAL + ':');
}

/**
 * Extract the app-code segment for any `:_cmc:apps:<app-code>[:...]` id.
 * Returns null for ids that aren't under `:_cmc:apps:`.
 */
function getAppCode (streamId: string): string | null {
  const canonical = canonicalLocalStreamId(streamId);
  if (typeof canonical !== 'string' || !canonical.startsWith(NS_APPS + ':')) return null;
  const rest = canonical.substring(NS_APPS.length + 1);
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
// Content fields of a `consent/accept-cmc` event only the server writes (the
// subject-side record of a consent): a client value is dropped on create and
// the stored one kept on update (acceptServerOwnedFieldsHook.ts).
const ACCEPT_SERVER_OWNED_FIELDS: readonly string[] = ['approvedBy', 'ownerConfirmedAt', 'withdrawal'];
// Content fields of an accept the client sends at create (the features it asks
// for) and the server then rewrites with the resolved value: kept from
// storage on update, so the record says what the relationship got.
const ACCEPT_UPDATE_PRESERVED_FIELDS: readonly string[] = ['features'];
// Content fields of every CMC event only the server writes: the dispatch
// status stamps (`delivered` / `completed` / `failed` + its `failure`), the
// mint's `pending`, a scope request's outcome. Kept from storage on update.
const CMC_SERVER_OWNED_FIELDS: readonly string[] = ['status', 'failure'];
// Content fields of a `consent/revoke-cmc` arrival only the RECEIVING server
// writes: its own handles for the relationship, the ids it tore down, and the
// marker of a notice it dropped as stale. They describe the receiving account,
// so a value the sender put there is dropped at the inbox write
// (inboxWriteHook.ts) and again when the handler records its decision
// (handleIncomingRevoke.ts): an app never reads a peer's claim as this
// server's.
const REVOKE_RECEIVER_OWNED_FIELDS: readonly string[] = [
  'backChannelAccessId', 'dataGrantAccessId', 'revokedAccessIds', 'superseded',
];

// --- Group accounts: members, member accesses, offboarding ---
//
// A group account (a practice, a research team) accepts membership requests
// from ordinary accounts; the access it mints for a member carries
// `clientData.cmc.role === 'member'`. A member then asks the group's core for a
// short-lived access on a patient's account (`consent/member-access-cmc`); the
// group's core mints it on the patient's core through the relationship grant
// it holds and hands the token back once, in the synchronous response. When a
// membership ends the server writes a `consent/member-revoke-cmc` on the
// group's scope stream and deletes what was minted for that member.
const ET_MEMBER_ACCESS = 'consent/member-access-cmc';
const ET_MEMBER_REVOKE = 'consent/member-revoke-cmc';
// Ledger record, one per minted child (plugin-internal, never published).
const ET_MEMBER_LEDGER = 'cmc-internal/member-cmc';
// The roles a relationship access can carry in `clientData.cmc.role`.
// `counterparty`: one side's access toward its peer in a consent relationship.
// `member`: a membership access on a group account, "a peer for protocol
// deliveries, a local actor for triggers" (it writes the inbox like a peer and
// writes mint triggers like the account's own apps).
// `member-child`: the access minted on a patient's account for one member,
// stamped by the patient's core from the grant that created it.
const ROLE_COUNTERPARTY = 'counterparty';
const ROLE_MEMBER = 'member';
const ROLE_MEMBER_CHILD = 'member-child';
// The two roles that serve a relationship on the group side.
const RELATIONSHIP_ROLES: readonly string[] = [ROLE_COUNTERPARTY, ROLE_MEMBER];
// Content fields of a `consent/member-access-cmc` only the server writes
// (beside `status` / `failure`): dropped from a client create and kept from
// storage on update (memberAccessServerOwnedFieldsHook).
const MEMBER_ACCESS_SERVER_OWNED_FIELDS: readonly string[] = ['memberAccess', 'member', 'relationshipAccessId'];
// What ended a membership, as recorded on the sweep trigger. `vanished`: the
// membership access no longer exists but its records do (deleted by a path
// that did not sweep, or a crash between the delete and the sweep).
const MEMBER_REVOKE_REASONS: readonly string[] = ['revoke', 'accesses.delete', 'expired', 'narrowed', 'detach', 'account-deleted', 'vanished'];
// How a minted child names its member on the patient's core.
const MEMBER_ATTRIBUTION_STAMPED = 'stamped';
const MEMBER_ATTRIBUTION_NAME_ONLY = 'name-only';
// Config keys (`cmc:memberAccess:*`) with the values used when unset.
const MEMBER_ACCESS_CONFIG_DEFAULTS = {
  defaultTtl: 86400,
  minTtl: 60,
  maxTtl: 604800,
  ratePerMinute: 30,
  maxInFlightPerMembership: 1,
  allowNameOnly: true,
  sweepIntervalMs: 60000,
} as const;
// Back-channel info delivery (requester → accepter, post-acceptance).
// After the requester mints the back-channel access (handleIncomingAccept),
// they POST one of these to the accepter's :_cmc:inbox via the data-grant
// URL (which now carries inbox create-only). The accepter's plugin updates
// the data-grant access's clientData.cmc.counterparty with the requester's
// apiEndpoint + remote stream-ids so future chat / system deliveries from
// the accepter to the requester resolve cleanly.
const ET_BACK_CHANNEL = 'consent/back-channel-cmc';
// Per-capability invalidation (open-link mode). The requester
// writes this to one of their own `:_cmc:apps:*` streams; the plugin
// flips the capability access state to `'invalidated'` so further
// accepts are rejected by the responses-stream write-hook. Already
// established data-grant + back-channel relationships are NOT touched
// (per-relationship teardown remains `consent/revoke-cmc`).
const ET_INVALIDATE_LINK = 'consent/invalidate-link-cmc';

const EVENT_TYPES_LIFECYCLE = [ET_REQUEST, ET_ACCEPT, ET_REFUSE, ET_REVOKE, ET_BACK_CHANNEL];
// Group-account triggers: the mint (client-written on the group's scope
// stream) and the sweep (server-written there; a client write is refused).
const EVENT_TYPES_MEMBER = [ET_MEMBER_ACCESS, ET_MEMBER_REVOKE];
// The types a counterparty token may deliver on `:_cmc:inbox`. An accept and a
// refuse are not among them: they reach the requester only through the
// capability's responses stream (the inbox holds the server's copy of an accept).
// Taken from a peer's own inbox write, either would let it open a relationship
// under a scope of its choosing, or mark one of the requester's invites refused.
const EVENT_TYPES_INBOX = [ET_REQUEST, ET_REVOKE, ET_BACK_CHANNEL];
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
  ...EVENT_TYPES_MEMBER,
  ET_RETRY,
  ET_MEMBER_LEDGER,
];

const ALL_EVENT_TYPES_SET = new Set(ALL_EVENT_TYPES);

// The author (`modifiedBy`) the plugin records on the events it updates
// itself: the platform's reserved access id, never the id of a real access.
const SYSTEM_ACCESS_ID = 'system';

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
function isCmcEventType (eventType: unknown): boolean {
  return typeof eventType === 'string' && ALL_EVENT_TYPES_SET.has(eventType);
}

export {
  // namespaces (reserved roots)
  NS,
  NS_INBOX,
  NS_APPS,
  NS_INTERNAL,
  NS_INTERNAL_RETRIES,
  NS_INTERNAL_MEMBERS,
  RESERVED_PARENT_STREAM_IDS,
  USER_CREATABLE_PARENT_STREAM_ID,
  APP_RESERVED_SEGMENTS,

  // group accounts
  ET_MEMBER_ACCESS,
  ET_MEMBER_REVOKE,
  ET_MEMBER_LEDGER,
  ROLE_COUNTERPARTY,
  ROLE_MEMBER,
  ROLE_MEMBER_CHILD,
  RELATIONSHIP_ROLES,
  MEMBER_ACCESS_SERVER_OWNED_FIELDS,
  MEMBER_REVOKE_REASONS,
  MEMBER_ATTRIBUTION_STAMPED,
  MEMBER_ATTRIBUTION_NAME_ONLY,
  MEMBER_ACCESS_CONFIG_DEFAULTS,
  EVENT_TYPES_MEMBER,

  // stream-id builders
  chatsParentUnder,
  chatStreamUnder,
  collectorsParentUnder,
  collectorStreamUnder,
  offerStreamIdFor,
  responsesStreamIdFor,
  capabilityIdFromResponsesStreamId,

  // classification predicates
  canonicalLocalStreamId,
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
  ACCEPT_SERVER_OWNED_FIELDS,
  ACCEPT_UPDATE_PRESERVED_FIELDS,
  CMC_SERVER_OWNED_FIELDS,
  REVOKE_RECEIVER_OWNED_FIELDS,
  ET_BACK_CHANNEL,
  ET_INVALIDATE_LINK,
  EVENT_TYPES_LIFECYCLE,
  EVENT_TYPES_INBOX,
  EVENT_TYPES_CHAT,
  EVENT_TYPES_SYSTEM,
  EVENT_TYPES_CAPABILITY,
  ALL_EVENT_TYPES,
  isCmcEventType,

  // server-side writes
  SYSTEM_ACCESS_ID,
};
