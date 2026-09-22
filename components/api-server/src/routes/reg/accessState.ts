/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Access-request state store, core-local, backed by `cluster_kv` (a
 * master-held in-memory map that every worker of THIS core reaches over
 * the cluster IPC channel; an in-process map when there is no master).
 *
 * Why core-local: the poll URL handed to the app is the entry core's own
 * URL, so every read and write of a request lands on the core that
 * created it. Nothing about a request is needed on another core. Once
 * ACCEPTED, the state holds the app's access token (and an apiEndpoint
 * embedding it) plus the username, so it must not sit in the platform
 * store: that store is replicated to every core of the platform, on disk.
 *
 * Why not a per-worker Map: under `cluster.fork()` a POST lands on worker
 * A and the polls round-robin across workers (GH issue
 * pryv/open-pryv.io#67). The master-held map is shared by all workers.
 *
 * Trade-off: in memory only, so a core restart drops the requests in
 * flight; the user signs in again (the same trade-off as MFA sessions).
 *
 * Delivery: a terminal state (ACCEPTED, REFUSED, ERROR) is kept for a
 * short retention window after it is first read by a poll, then dropped,
 * so the credential does not linger for the whole request lifetime. The
 * window exists because clients read the ACCEPTED body more than once
 * (lib-js polls, then `connectFromKey` polls again).
 */

const crypto = require('node:crypto');

const KEY_LENGTH = 16;
const DEFAULT_TTL_MS = 3600 * 1000; // 1 hour
const NAMESPACE = 'access-request/';
/** Terminal states: the outcome is decided, only delivery is left. */
const TERMINAL_STATUSES = Object.freeze(['ACCEPTED', 'REFUSED', 'ERROR']);

type BuildStateParams = {
  /** Lifetime of the access the app asks for, in SECONDS (an
   * `accesses.create` parameter the auth page applies), not of the request. */
  expireAfter?: number;
  /** Token the app asks the access to carry (`accesses.create` `token`). */
  token?: string;
  requestingAppId: string;
  requestedPermissions: unknown;
  languageCode?: string;
  returnURL?: string | null;
  oauthState?: unknown;
  clientData?: unknown;
  deviceName?: string | null;
  /** Resolved consent form, present ONLY when the request carried a
   * `consent` sidecar. Absence is meaningful: it is what keeps an
   * un-annotated request behaving exactly as it did before, and it is
   * what the ACCEPTED handler tests to decide whether to enforce. */
  consent?: unknown;
  /** Who the app wants the access for: 'allow' (the auth page may offer
   * the accounts the user controls), 'deny' (the signed-in account only),
   * or a username to preselect. Validated by the route; set only when sent. */
  actAs?: string;
  /** Delivery mode the app asked for. 'shared-secret' means the ACCEPTED
   * body must carry a one-time hand-off key instead of the token. Validated
   * by the route; set only when the app sent it. Absence keeps today's
   * inline delivery. */
  credentialHandoff?: 'shared-secret';
};

type AccessState = {
  status: string;
  code: number;
  key: string;
  requestingAppId: string;
  requestedPermissions: unknown;
  languageCode: string;
  returnURL: string | null;
  oauthState: unknown;
  clientData: unknown;
  deviceName: string | null;
  /** See `BuildStateParams.expireAfter`: set only when the app sent one. */
  expireAfter?: number;
  /** See `BuildStateParams.consent`: set only for an annotated request. */
  consent?: unknown;
  /** See `BuildStateParams.credentialHandoff`: set only for a request that
   * asked for shared-secret delivery. */
  credentialHandoff?: 'shared-secret';
  /** One-time credential hand-off descriptor, set on an ACCEPTED state that
   * delivers by shared secret. The token itself is NOT here: it lives in the
   * referenced one-time secret on the user's core. */
  handoff?: { type: 'shared-secret'; key: string };
  poll_rate_ms: number;
  createdAt: number;
  expiresAt: number;
  pollUrl?: string;
  authUrl?: string;
  /** First time a poll read the terminal state (ms epoch). */
  deliveredAt?: number;
  [k: string]: unknown;
};

type KvClient = {
  get: (key: string) => Promise<unknown>;
  /** Resolves true when it wrote, false when `ifUnderPrefix` refused (the
   * namespace is full). A guarded write that answers anything else is not
   * trusted to have honoured the ceiling. */
  set: (key: string, value: unknown, opts?: { ttlMs?: number; ifUnderPrefix?: { prefix: string; max: number } }) => Promise<boolean>;
  delete: (key: string) => Promise<void>;
};

let kvClient: KvClient | null = null;

/** Lazily bound so a test can inject a client before first use. */
function getKv (): KvClient {
  if (kvClient == null) kvClient = require('messages/src/cluster_kv.ts').clientFor();
  return kvClient as KvClient;
}

/** Test seam: swap the store client (null restores the default). */
function _setKvClientForTests (client: KvClient | null): void {
  kvClient = client;
}

/** Keys created through this module in this process, so `clear()` (tests)
 * can drop them without wiping unrelated `cluster_kv` entries. Tracked in
 * test runs only: nothing removes a key on expiry, so in a server this set
 * would grow with every request. */
const TRACK_KEYS = process.env.NODE_ENV === 'test';
const knownKeys = new Set<string>();

async function write (key: string, state: AccessState, expiresAt: number, maxLive?: number): Promise<boolean> {
  // cluster_kv treats a non-positive TTL as "never expires": clamp to 1 ms
  // so an already-past expiry drops the entry instead of pinning it.
  const ttlMs = Math.max(1, expiresAt - Date.now());
  const opts: { ttlMs: number; ifUnderPrefix?: { prefix: string; max: number } } = { ttlMs };
  if (maxLive != null && maxLive > 0) opts.ifUnderPrefix = { prefix: NAMESPACE, max: maxLive };
  const stored = await getKv().set(NAMESPACE + key, state, opts);
  // A guarded write must say it wrote. Anything else (a refusal, or a client
  // that does not report one) counts as not written, so the ceiling cannot be
  // lifted by an answer we do not understand.
  if (opts.ifUnderPrefix != null && stored !== true) return false;
  if (TRACK_KEYS) knownKeys.add(key);
  return true;
}

/**
 * Generate a random alphanumeric key.
 */
function generateKey (): string {
  return crypto.randomBytes(KEY_LENGTH).toString('base64url').slice(0, KEY_LENGTH);
}

/**
 * Build a fresh access-request state in memory. Does NOT persist — callers
 * decorate the state with `pollUrl` / `authUrl` (computed from
 * core-affine routing) and then call `persist()` to flush it to the store
 * in a single write.
 *
 * Splitting create into build + persist avoids a read-modify-write
 * round-trip we'd otherwise need to add the URLs after the initial save.
 *
 */
function buildState (params: BuildStateParams): { key: string; state: AccessState; expiresAt: number } {
  const key = generateKey();
  // The request always lives DEFAULT_TTL_MS. `expireAfter` is the lifetime
  // of the ACCESS (seconds), carried to the auth page below.
  const expiresAt = Date.now() + DEFAULT_TTL_MS;
  const state: AccessState = {
    status: 'NEED_SIGNIN',
    code: 201,
    key,
    requestingAppId: params.requestingAppId,
    requestedPermissions: params.requestedPermissions,
    languageCode: params.languageCode || 'en',
    returnURL: params.returnURL ?? null,
    oauthState: params.oauthState || null,
    clientData: params.clientData || null,
    deviceName: params.deviceName || null,
    poll_rate_ms: 1000,
    createdAt: Date.now(),
    expiresAt
  };
  // Assigned only when present, never as `consent: undefined`: an
  // un-annotated state must not gain the key at all, so its poll body
  // stays byte-identical to what it was before consent forms existed.
  if (params.consent !== undefined) state.consent = params.consent;
  // Same rule for the access-creation parameters the auth page applies:
  // present only when the app sent them.
  if (typeof params.expireAfter === 'number' && Number.isFinite(params.expireAfter)) {
    state.expireAfter = params.expireAfter;
  }
  if (typeof params.token === 'string' && params.token !== '') state.token = params.token;
  if (typeof params.actAs === 'string') state.actAs = params.actAs;
  if (params.credentialHandoff === 'shared-secret') state.credentialHandoff = 'shared-secret';
  return { key, state, expiresAt };
}

/**
 * Persist an in-memory state to the store. Used both for the initial
 * write after `buildState()` and to push subsequent mutations of `state`
 * back to the store.
 *
 * @param [expiresAt] - defaults to `state.expiresAt`
 */
async function persist (key: string, state: AccessState, expiresAt?: number): Promise<void> {
  const ts = expiresAt ?? state.expiresAt;
  state.expiresAt = ts;
  await write(key, state, ts);
}

/**
 * First write of a NEW request, refused when this core already holds
 * `maxLive` of them. Returns whether it stored.
 *
 * Creating a request takes no credentials, so this is what keeps a flood of
 * them from filling the core's memory. The count and the write happen in one
 * step inside the store: counting first and writing after is a check-then-act
 * that every worker passes at the same moment.
 *
 * `maxLive` of 0 (or less) means no ceiling.
 */
async function persistNew (key: string, state: AccessState, expiresAt: number, maxLive: number, maxBytes?: number): Promise<boolean> {
  state.expiresAt = expiresAt;
  assertWithinSize(state, maxBytes);
  return await write(key, state, expiresAt, maxLive);
}

/**
 * Compatibility shim — older code paths called `create()` and then
 * mutated the returned `state`. The mutation is not written back; new
 * code should use `buildState()` + `persist()` instead. Kept for tests
 * and any external caller that doesn't decorate the state.
 *
 */
async function create (params: BuildStateParams): Promise<{ key: string; state: AccessState }> {
  const built = buildState(params);
  await persist(built.key, built.state, built.expiresAt);
  return { key: built.key, state: built.state };
}

/**
 * Get an access request state.
 */
async function get (key: string): Promise<AccessState | null> {
  const value = await getKv().get(NAMESPACE + key) as AccessState | null;
  if (value == null) return null;
  // The store expires entries on its own clock; this guards a caller that
  // reads between expiry and the store's next sweep in a fallback store.
  if (typeof value.expiresAt === 'number' && Date.now() > value.expiresAt) return null;
  return value;
}

/**
 * Record that a poll has read a terminal state, and shorten its remaining
 * life to `retentionMs` from that first read. Later reads inside the window
 * are served unchanged; after it the key is unknown, exactly as on expiry.
 * A non-terminal state, an already-stamped state, or `retentionMs <= 0`
 * (retention disabled) is left as is.
 */
async function markDelivered (key: string, state: AccessState, retentionMs: number): Promise<void> {
  if (!TERMINAL_STATUSES.includes(state.status)) return;
  if (state.deliveredAt != null) return;
  if (!(retentionMs > 0)) return;
  const now = Date.now();
  state.deliveredAt = now;
  const expiresAt = Math.min(state.expiresAt, now + retentionMs);
  state.expiresAt = expiresAt;
  await write(key, state, expiresAt);
}

/**
 * The ONLY fields an update may write.
 *
 * Whoever posts the outcome of the flow is exactly the party whose grant
 * the accept then verifies, so it must not be able to reach the rest of
 * the state. Assigning the request body wholesale let a poster send
 * `consent: null`, or a consent form of its own choosing, and so switch
 * the grant check off or narrow the offer to whatever it had minted.
 *
 * The server's record of what the APP asked for (`requestedPermissions`,
 * `consent`, `requestingAppId`, the URLs, the expiry) is not the poster's
 * to change.
 *
 * `delegation` is the display hint an auth page posts when it granted the
 * access on an account the user controls; the route validates its shape
 * before it gets here.
 *
 * `handoff` is the one-time credential hand-off descriptor for shared-secret
 * delivery; the route validates its shape (and that the request asked for it)
 * before it gets here. A state that carries `handoff` never carries `token`
 * (see `update()` below): the token moved into the referenced secret.
 */
const UPDATABLE_FIELDS = Object.freeze([
  'status', 'username', 'token', 'apiEndpoint',
  'reasonId', 'message', 'redirectUrl', 'delegation', 'handoff'
]);

/** Of those, the ones that carry free text and so must be strings. Whoever
 * posts the outcome is unauthenticated (it holds the key, nothing else), and
 * an unchecked field takes whatever JSON the body carried: an object, or a
 * string as large as the body limit, held under that key until the request
 * expires. `delegation` and `handoff` are shape-checked by the route. */
const STRING_UPDATABLE_FIELDS = Object.freeze([
  'username', 'token', 'apiEndpoint', 'reasonId', 'message', 'redirectUrl'
]);

/** Marks a refusal the route turns into a status code rather than a 500. */
function rejection (kind: 'invalid-field' | 'too-large', message: string): Error {
  return Object.assign(new Error(message), { accessStateRejection: kind });
}

/**
 * Update an access request state (accept or refuse). Only
 * `UPDATABLE_FIELDS` are written; anything else in `update` is ignored.
 */
async function update (key: string, update: Partial<AccessState>, opts: { maxBytes?: number } = {}): Promise<AccessState | null> {
  for (const field of STRING_UPDATABLE_FIELDS) {
    if (update[field] !== undefined && typeof update[field] !== 'string') {
      throw rejection('invalid-field', field + ' must be a string');
    }
  }
  const stored = await get(key);
  if (!stored) return null;
  // Merge into a COPY, so that a refusal below leaves the stored request
  // exactly as it was. The store now detaches what it hands back, so this is
  // defence in depth rather than the only thing standing between a rejected
  // update and a mutated request.
  const state: AccessState = { ...stored };
  for (const field of UPDATABLE_FIELDS) {
    if (update[field] !== undefined) state[field] = update[field];
  }
  // Invariant: a hand-off state carries no token. The token moved into the
  // one-time secret, so drop whatever the state held — a token the request
  // had echoed (the app-requested token), or one a shape-L conversion just
  // wrote before the route decided to hand off. Deleting here (rather than
  // relying on the caller to omit it) keeps the invariant in one place.
  if (state.handoff != null) delete state.token;
  if (update.status === 'ACCEPTED') {
    state.code = 200;
  } else if (update.status === 'REFUSED' || update.status === 'ERROR') {
    state.code = 403;
  } else if (update.status === 'REDIRECTED') {
    state.code = 301;
  }
  // The ceiling applies to EVERY write of a request, not only its creation:
  // the outcome post rewrites the same entry, so a ceiling checked once at
  // creation would just move the exhaustion one call later. Refusing before
  // the write leaves the stored request exactly as it was.
  assertWithinSize(state, opts.maxBytes);
  await write(key, state, state.expiresAt);
  return state;
}

/**
 * Refuse a state too large to be held. `maxBytes` of 0 (or absent) disables
 * the check. Measured on the serialized form, which is what crosses to the
 * store and what it holds per request.
 */
function assertWithinSize (state: AccessState, maxBytes?: number): void {
  if (maxBytes == null || !(maxBytes > 0)) return;
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > maxBytes) {
    throw rejection('too-large', 'This access request is too large to be held by the core.');
  }
}

/**
 * Delete an access request.
 */
async function remove (key: string): Promise<void> {
  await getKv().delete(NAMESPACE + key);
  knownKeys.delete(key);
}

/**
 * Drop every request created through this module in this process (used by
 * tests). Entries created by other processes, and unrelated `cluster_kv`
 * entries such as MFA sessions, are left alone.
 */
async function clear (): Promise<void> {
  for (const key of [...knownKeys]) await remove(key);
}

export { buildState, persist, persistNew, create, get, markDelivered, update, remove, clear, TERMINAL_STATUSES, _setKvClientForTests };
export type { AccessState };