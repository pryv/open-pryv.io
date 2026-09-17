/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Access-request state store, backed by PlatformDB (rqlite `keyValue`).
 *
 * Why PlatformDB and not an in-process Map: under `cluster.fork()` each
 * worker is a separate Node process. A POST to `/reg/access` lands on
 * worker A and writes; the polling GETs round-robin across workers, so
 * worker B's lookup sees nothing and 400s. Backing the store on rqlite
 * keeps it cluster-wide and worker-symmetric (and survives restart, which
 * is operator-friendly for mid-flow auth requests).
 *
 * Replaces the in-memory `new Map()` from the original v2 implementation
 * (which itself replaced v1's Redis store; the regression was "Map ≠ shared
 * across workers"). See workspace plan 55 + GH issue
 * pryv/open-pryv.io#67 for the production reproducer.
 */

const crypto = require('node:crypto');

const KEY_LENGTH = 16;
const DEFAULT_TTL_MS = 3600 * 1000; // 1 hour

type BuildStateParams = {
  expireAfter?: number;
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
  /** See `BuildStateParams.consent`: set only for an annotated request. */
  consent?: unknown;
  poll_rate_ms: number;
  createdAt: number;
  expiresAt: number;
  pollUrl?: string;
  authUrl?: string;
  [k: string]: unknown;
};

type PlatformDbAccessRow = { value: AccessState; expiresAt: number };

type PlatformDbAccessApi = {
  setAccessState: (key: string, state: AccessState, expiresAt: number) => Promise<unknown>;
  getAccessState: (key: string) => Promise<PlatformDbAccessRow | null>;
  deleteAccessState: (key: string) => Promise<unknown>;
  sweepExpiredAccessStates: (now: number) => Promise<unknown>;
};

function getPlatformDB (): PlatformDbAccessApi {
  return require('storages').platformDB;
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
 * core-affine routing) and then call `persist()` to flush it to PlatformDB
 * in a single write.
 *
 * Splitting create into build + persist avoids a read-modify-write
 * round-trip we'd otherwise need to add the URLs after the initial save.
 *
 */
function buildState (params: BuildStateParams): { key: string; state: AccessState; expiresAt: number } {
  const key = generateKey();
  const ttl = params.expireAfter || DEFAULT_TTL_MS;
  const expiresAt = Date.now() + ttl;
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
  return { key, state, expiresAt };
}

/**
 * Persist an in-memory state to PlatformDB. Used both for the initial
 * write after `buildState()` and to push subsequent mutations of `state`
 * back to the store.
 *
 * @param [expiresAt] - defaults to `state.expiresAt`
 */
async function persist (key: string, state: AccessState, expiresAt?: number): Promise<void> {
  const ts = expiresAt ?? state.expiresAt;
  await getPlatformDB().setAccessState(key, state, ts);
}

/**
 * Compatibility shim — older code paths called `create()` and then
 * mutated the returned `state`. The mutation was lost on PlatformDB-backed
 * writes; new code should use `buildState()` + `persist()` instead. Kept
 * for tests and any external caller that doesn't decorate the state.
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
  const row = await getPlatformDB().getAccessState(key);
  return row ? row.value : null;
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
 */
const UPDATABLE_FIELDS = Object.freeze([
  'status', 'username', 'token', 'apiEndpoint',
  'reasonId', 'message', 'redirectUrl'
]);

/**
 * Update an access request state (accept or refuse). Only
 * `UPDATABLE_FIELDS` are written; anything else in `update` is ignored.
 */
async function update (key: string, update: Partial<AccessState>): Promise<AccessState | null> {
  const platformDB = getPlatformDB();
  const row = await platformDB.getAccessState(key);
  if (!row) return null;
  const state = row.value;
  for (const field of UPDATABLE_FIELDS) {
    if (update[field] !== undefined) state[field] = update[field];
  }
  if (update.status === 'ACCEPTED') {
    state.code = 200;
  } else if (update.status === 'REFUSED' || update.status === 'ERROR') {
    state.code = 403;
  } else if (update.status === 'REDIRECTED') {
    state.code = 301;
  }
  await platformDB.setAccessState(key, state, row.expiresAt);
  return state;
}

/**
 * Delete an access request.
 */
async function remove (key: string): Promise<void> {
  await getPlatformDB().deleteAccessState(key);
}

/**
 * Clear all entries (used by tests). Calls the master sweep with `now =
 * Infinity` so every row is dropped.
 */
async function clear () {
  return await getPlatformDB().sweepExpiredAccessStates(Number.POSITIVE_INFINITY);
}

export { buildState, persist, create, get, update, remove, clear };