/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Middleware factories for the CMC plugin's write-hooks.
 *
 * Each factory takes a `deps` object (errors factory, logger) and returns
 * an api-server-shaped middleware: `(context, params, result, next) → void`.
 *
 * These are pure factories — no module-level side effects, no api-server
 * imports — so they can be unit-tested with fake deps. Wiring into the
 * real chain lives in api-server (see methods/events.ts + methods/streams.ts).
 */

const C = require('./constants.ts');
const validators = require('./validators.ts');
const provisioning = require('./provisioning.ts');

type ApiError = Error & { id?: string; data?: unknown };
type ErrorFactory = {
  invalidOperation: (message: string, details?: Record<string, unknown>) => ApiError;
  unknownResource?: (resource: string, id?: unknown) => ApiError;
};

type Deps = {
  errors: ErrorFactory;
};

type MethodContext = {
  newEvent?: { type?: string; content?: Record<string, unknown>; streamIds?: string[]; [k: string]: unknown };
  user?: { id?: string };
  access?: { clientData?: { cmc?: { role?: string; counterparty?: { username?: string; host?: string } } } };
  event?: { streamIds?: string[]; [k: string]: unknown };
  cmc?: { isCmcEvent?: boolean; eventType?: string; streamIds?: string[]; [k: string]: unknown };
  [k: string]: unknown;
};
type MethodNext = (err?: unknown) => unknown;
// Per-method call params — heterogeneous across the hooked methods
// (events.create / streams.* / accesses.*); each hook narrows the
// fields it reads.
type HookParams = {
  id?: unknown;
  // events.get stream queries: ids and/or {streamId} query objects
  streams?: Array<string | { streamId?: string; [k: string]: unknown } | null>;
  clientData?: { cmc?: unknown; [k: string]: unknown } | null;
  update?: { id?: unknown; clientData?: { cmc?: unknown; [k: string]: unknown } | null; [k: string]: unknown } | null;
  [k: string]: unknown;
} | null | undefined;
type StreamNode = { id?: string; children?: StreamNode[]; [k: string]: unknown };
type HookResult = {
  // streams.get response tree (pruned in place by the internal guard)
  streams?: StreamNode[];
  access?: { permissions?: unknown; [k: string]: unknown } | null;
  [k: string]: unknown;
} | null | undefined;
type Middleware = (context: MethodContext, params: HookParams, result: HookResult, next: MethodNext) => unknown | Promise<unknown>;

/**
 * events.create hook — validates cmc/* event content against its schema.
 *
 * Behaviour:
 * - If `context.newEvent.streamIds` contains no `:_cmc:*` stream, passthrough.
 * - If the event type isn't a `cmc/*` type, passthrough (app-defined types
 *   under :_cmc:apps:* are not schema-validated by CMC).
 * - Otherwise validate via validators.validate(type, content); reject with
 *   `cmc-invalid-event-content` on failure.
 *
 * Sets `context.cmc = { isCmcEvent, eventType?, region? }` so downstream
 * middleware in api-server / hfs-server / etc. can branch.
 */
function createCmcContentValidationHook (deps: Deps): Middleware {
  return function cmcContentValidationHook (context, params, result, next) {
    const event = context.newEvent;
    if (event == null) return next();

    const streamIds: string[] = Array.isArray(event.streamIds) ? event.streamIds : [];
    const cmcStreamIds = streamIds.filter((id: string) => C.isCmcStreamId(id));
    if (cmcStreamIds.length === 0) return next();

    context.cmc = context.cmc || {};
    context.cmc.isCmcEvent = true;
    context.cmc.streamIds = cmcStreamIds;

    const type: unknown = event.type;
    // Recognise CMC types via the centralised set rather than a single
    // prefix check — after the rename to class/format-style names, types
    // span four classes (consent/*, message/chat-cmc, notification/cmc-*,
    // cmc-internal/*) so a `startsWith('cmc/')` would miss most of them.
    const isCmcType = C.isCmcEventType(type);
    if (isCmcType) {
      context.cmc.eventType = type as string;
    }

    if (!isCmcType) {
      // App-defined type in a :_cmc:* stream — pass through. Useful for app
      // organizational metadata under :_cmc:apps:* (e.g. a 'collector/metadata'
      // event the app uses for its own purposes). After the class/format
      // rename the CMC types share their class namespaces (consent, message,
      // notification) with potentially app-defined formats; we no longer
      // try to claim every event in those classes — only the exact set of
      // CMC-known types is intercepted for content validation.
      return next();
    }

    if (!validators.isKnownEventType(type)) {
      // Edge: a CMC-known type with no registered validator (e.g. ET_RETRY,
      // which is plugin-internal). Pass through — no app-side validation
      // applies.
      return next();
    }

    const validation = validators.validate(type as string, event.content);
    if (!validation.valid) {
      return next(deps.errors.invalidOperation(
        'CMC event content failed schema validation for ' + type,
        { id: 'cmc-invalid-event-content', eventType: type, errors: validation.errors }
      ));
    }

    next();
  };
}

/**
 * streams.create hook — rejects creates of reserved CMC streams.
 *
 * Behaviour:
 * - If the target stream-id isn't under `:_cmc:`, passthrough.
 * - If the target is exactly one of the plugin-managed reserved parents
 *   (`:_cmc:`, `:_cmc:inbox`, `:_cmc:apps`, `:_cmc:_internal`,
 *   `:_cmc:_internal:retries`), reject — these are auto-provisioned by
 *   the CMC plugin on user creation.
 * - If the target is at or beneath a plugin-managed sub-segment
 *   (`chats` / `collectors`) anywhere under `:_cmc:apps:<app-code>:...`,
 *   reject — the plugin auto-creates these at acceptance time.
 * - If the target is otherwise under `:_cmc:apps:` (user-creatable region),
 *   passthrough.
 * - Otherwise (any other `:_cmc:*` location, e.g. `:_cmc:_internal:*`),
 *   reject — user code may not create plugin-managed streams.
 */
function createStreamCreateReservedRootHook (deps: Deps): Middleware {
  return function streamCreateReservedRootHook (context, params, result, next) {
    // params can be either the plain stream payload OR { update: {...} }
    // depending on the entrypoint. Be tolerant.
    const target = (params != null && typeof params === 'object' && params.update != null)
      ? params.update
      : params;
    const id: unknown = target?.id;

    if (typeof id !== 'string') return next();
    if (!C.isCmcStreamId(id)) return next();

    // Reject creation of the reserved parents themselves.
    if (C.RESERVED_PARENT_STREAM_IDS.includes(id)) {
      return next(deps.errors.invalidOperation(
        'Stream "' + id + '" is reserved and auto-provisioned by the CMC plugin',
        { id: 'cmc-reserved-stream', streamId: id }
      ));
    }

    // Allow children of :_cmc:apps (user-creatable).
    if (C.isUserCreatableStreamId(id)) return next();

    // Reject everything else under :_cmc:.
    return next(deps.errors.invalidOperation(
      'Stream "' + id + '" lives in a plugin-managed region of :_cmc:; only :_cmc:apps:* is user-creatable',
      { id: 'cmc-reserved-stream', streamId: id }
    ));
  };
}

/**
 * streams.delete hook — Phase 4 H6 reserved-root immutability.
 *
 * Symmetric counterpart to `createStreamCreateReservedRootHook`. Even
 * a personal token (which bypasses per-access permission checks via
 * `AccessLogic._canManageStream` returning true for personal) MUST NOT
 * be able to delete one of the plugin-auto-provisioned reserved
 * parents — deleting `:_cmc:` would silently break every active CMC
 * relationship on the account because subsequent inbox / chat /
 * system events would land on a non-existent parent and 400.
 *
 * Behaviour mirrors the create-hook decisions:
 *   - Outside `:_cmc:` → passthrough.
 *   - Hit a reserved parent (`:_cmc:`, `:_cmc:inbox`, `:_cmc:apps`,
 *     `:_cmc:_internal`, `:_cmc:_internal:retries`) → reject.
 *   - Inside `:_cmc:apps:` and NOT under a `chats|collectors` segment
 *     (i.e. `isUserCreatableStreamId(id) === true`) → passthrough.
 *   - Everything else under `:_cmc:` (`:_cmc:_internal:*`,
 *     chats/collectors parents and children) → reject. The plugin
 *     owns these and removes them itself when revoking a relationship.
 */
function createStreamDeleteReservedRootHook (deps: Deps): Middleware {
  return function cmcStreamDeleteReservedRootHook (_context, params, _result, next) {
    const id: unknown = params?.id;
    if (typeof id !== 'string') return next();
    if (!C.isCmcStreamId(id)) return next();

    if (C.RESERVED_PARENT_STREAM_IDS.includes(id)) {
      return next(deps.errors.invalidOperation(
        'Stream "' + id + '" is reserved by the CMC plugin and may not be deleted',
        { id: 'cmc-reserved-stream-undeletable', streamId: id }
      ));
    }

    if (C.isUserCreatableStreamId(id)) return next();

    return next(deps.errors.invalidOperation(
      'Stream "' + id + '" lives in a plugin-managed region of :_cmc: and may not be deleted directly',
      { id: 'cmc-reserved-stream-undeletable', streamId: id }
    ));
  };
}

/**
 * Lazy auto-provision hook for the reserved `:_cmc:*` parents.
 *
 * Accounts that pre-date the CMC deploy — and every account on a
 * platform where creation-time provisioning is off — don't have the
 * five reserved parents (`:_cmc:`, `:_cmc:inbox`, `:_cmc:apps`,
 * `:_cmc:_internal`, `:_cmc:_internal:retries`). Creation-time
 * provisioning stays disabled (account-suite constraint), so they are
 * provisioned lazily, on the account's first `:_cmc:*` operation.
 *
 * "First operation" includes READS. Wiring this only into the write
 * paths left every read-first consumer permanently broken: an app whose
 * first CMC act is an inbox watcher
 * (`events.get {streams: [':_cmc:inbox']}`) got
 * `unknown-referenced-resource` on every poll, because the stream-query
 * validation resolves ids that were never created (open-pryv.io#111).
 *
 * This middleware MUST fire BEFORE any code path that depends on the
 * parents existing (verifyCanCreateEventsOnStream on writes,
 * streamQueryCheckPermissionsAndReplaceStars on reads, parent-id
 * resolution in streams.create).
 *
 * Gating:
 *   - events.create: `context.newEvent.streamIds` holds a `:_cmc:*` id,
 *     or the event type is a CMC type.
 *   - streams.create: the new stream's id is `:_cmc:*`.
 *   - events.get (read path): `params.streams` references a `:_cmc:*`
 *     id — string form or `{streamId}` object form.
 *   - accesses.create/update: called directly by the app-scope
 *     provisioning hook before it creates a `:_cmc:apps:<app>` leaf.
 *
 * Cost guard (this now sits on a polling path): a per-process memo of
 * already-ensured user-ids short-circuits repeat calls, and on a memo
 * miss a single cheap stream read decides whether provisioning is
 * needed at all — so the steady state of an inbox watcher is one Set
 * lookup, not five create attempts.
 *
 * Failure is non-fatal (logged): the downstream call surfaces its own
 * clearer error if provisioning truly didn't take.
 */

// Per-process memo of users whose reserved tree is known to exist.
// Bounded: cleared wholesale when it grows past the cap (a cleared memo
// costs one existence probe per user, never correctness).
const ensuredUsers = new Set<string>();
const ENSURED_USERS_MAX = 10_000;

function markEnsured (userId: string): void {
  if (ensuredUsers.size >= ENSURED_USERS_MAX) ensuredUsers.clear();
  ensuredUsers.add(userId);
}

/** Test seam — the memo is process-wide state. */
function _resetEnsuredUsersMemo (): void {
  ensuredUsers.clear();
}

/**
 * True when `params.streams` (events.get) references any `:_cmc:*`
 * stream. Accepts both accepted wire forms: bare id strings and
 * `{streamId, …}` query objects (mirrors createEventsGetInternalGuardHook).
 */
function streamsParamReferencesCmc (streams: unknown): boolean {
  if (!Array.isArray(streams)) return false;
  return streams.some((s) => {
    if (typeof s === 'string') return C.isCmcStreamId(s);
    if (s != null && typeof s === 'object') {
      const sid = (s as { streamId?: unknown }).streamId;
      if (typeof sid === 'string' && C.isCmcStreamId(sid)) return true;
      // Logical-query form: {any|all|not: [ids]}
      for (const key of ['any', 'all', 'not']) {
        const list = (s as Record<string, unknown>)[key];
        if (Array.isArray(list) && list.some((id) => typeof id === 'string' && C.isCmcStreamId(id))) {
          return true;
        }
      }
    }
    return false;
  });
}

/**
 * Ensure the reserved tree exists for `userId`, cheaply.
 *
 * Order: memo hit → done. Memo miss → one existence probe on `:_cmc:`
 * (when the mall view exposes one) → provision only if absent. Marks
 * the memo in every non-throwing outcome.
 */
async function ensureReservedParentsOnce (deps: ProvisionDeps, userId: string): Promise<void> {
  if (ensuredUsers.has(userId)) return;

  const probe = deps.mall.streams.getOneWithNoChildren;
  if (typeof probe === 'function') {
    try {
      const existing = await probe.call(deps.mall.streams, userId, C.NS, 'local');
      if (existing != null) {
        markEnsured(userId);
        return;
      }
    } catch (err: unknown) {
      // Probe failure is not fatal — fall through to the idempotent
      // provisioning path rather than skipping it.
      deps.logger?.debug?.('cmc/ensureReservedParents: existence probe failed, provisioning anyway', {
        userId,
        error: String((err as Error)?.message || err),
      });
    }
  }

  await provisioning.provisionUserStreams({
    mall: deps.mall,
    userId,
    logger: deps.logger,
  });
  markEnsured(userId);
}

function createEnsureReservedParentsHook (deps: ProvisionDeps): Middleware {
  return async function cmcEnsureReservedParents (context, _params, _result, next) {
    const userId: string | undefined = context?.user?.id;
    if (userId == null) return next();

    let shouldEnsure = false;
    const newEvent = context.newEvent;
    if (newEvent != null) {
      const streamIds: string[] = Array.isArray(newEvent.streamIds) ? newEvent.streamIds : [];
      if (streamIds.some((id: string) => typeof id === 'string' && C.isCmcStreamId(id))) {
        shouldEnsure = true;
      } else if (C.isCmcEventType(newEvent.type)) {
        shouldEnsure = true;
      }
    }
    // streams.create case: caller supplies the new stream payload via
    // _params (events.ts uses context.newEvent; streams.ts uses params).
    if (!shouldEnsure && _params != null && typeof _params === 'object') {
      const targetId: unknown = _params.id ?? _params.update?.id;
      if (typeof targetId === 'string' && C.isCmcStreamId(targetId)) {
        shouldEnsure = true;
      }
      // events.get read path (#111).
      if (!shouldEnsure && streamsParamReferencesCmc(_params.streams)) {
        shouldEnsure = true;
      }
    }

    if (!shouldEnsure) return next();

    try {
      await ensureReservedParentsOnce(deps, userId);
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/ensureReservedParents: failed (continuing)', {
        userId,
        error: String((err as Error)?.message || err),
      });
    }
    next();
  };
}

/**
 * events.get hook — Phase 4 H5 defense-in-depth: strip any
 * `:_cmc:_internal:*` stream-ids from `params.streams` (string form OR
 * `{streamId, ...}` object form) before the query reaches the store.
 *
 * Today the plugin auto-provisions internal streams (`:_cmc:_internal`,
 * `:_cmc:_internal:retries`, `:_cmc:_internal:offer:*`,
 * `:_cmc:_internal:responses:*`) with no app-visible permissions, so
 * an explicit query for an internal id returns empty regardless. This
 * hook is the belt-and-braces against future regressions (e.g. an
 * admin permission bundle inadvertently granting read on the subtree,
 * or a permission-system bug treating `*` as including hidden trees).
 *
 * Behaviour: walks `params.streams`. If a string id is internal,
 * drops it. If an object has `.streamId` that's internal, drops the
 * object. Leaves wildcard `'*'` queries untouched (those are governed
 * by access permissions, NOT direct stream-id targeting).
 */
function createEventsGetInternalGuardHook (): Middleware {
  return function cmcEventsGetInternalGuard (_context, params, _result, next) {
    if (params == null || !Array.isArray(params.streams)) return next();
    params.streams = params.streams.filter((s: string | { streamId?: string } | null) => {
      if (typeof s === 'string') return !C.isCmcInternalStreamId(s);
      if (s != null && typeof s === 'object' && typeof s.streamId === 'string') {
        return !C.isCmcInternalStreamId(s.streamId);
      }
      return true;
    });
    next();
  };
}

/**
 * events.getOne hook — Phase 4 H5 defense-in-depth: if the fetched
 * event lives in `:_cmc:_internal:*`, return 404 instead of leaking
 * its existence (mirrors the existing pattern for hidden system
 * streams in `checkIfAuthorized`).
 *
 * Wired AFTER the existing `findEvent` middleware (which loads
 * `context.event`) so this hook sees the resolved event. Does NOT
 * mutate the event when it has mixed streamIds (some internal, some
 * not) — caller invariant is that internal events are *only* in the
 * internal subtree, so any presence of an internal id means "this
 * shouldn't be visible at all".
 */
function createEventGetOneInternalGuardHook (deps: Deps): Middleware {
  return function cmcEventGetOneInternalGuard (context, params, _result, next) {
    const event = context?.event;
    if (event == null) return next();
    const streamIds: string[] = Array.isArray(event.streamIds) ? event.streamIds : [];
    if (streamIds.some((id: string) => C.isCmcInternalStreamId(id))) {
      // Drop the staged event from context so downstream middleware
      // doesn't render it, then surface 404 (info-leak parity with the
      // existing hidden-system-stream pattern).
      delete context.event;
      return next(deps.errors.unknownResource?.('event', params?.id) ??
        deps.errors.invalidOperation('Event not found', { id: 'unknown-resource' }));
    }
    next();
  };
}

/**
 * streams.get hook — Phase 4 H5 defense-in-depth: prune the
 * `:_cmc:_internal` subtree from the response tree. The tree returned
 * by `findAccessibleStreams` is shaped as a forest of `{id, children}`
 * nodes; we recursively drop any node whose id starts in the internal
 * region.
 *
 * Wired AFTER `findAccessibleStreams` populates `result.streams`.
 */
function createStreamsGetInternalGuardHook (): Middleware {
  function prune (nodes: StreamNode[]): StreamNode[] {
    if (!Array.isArray(nodes)) return nodes;
    const kept: StreamNode[] = [];
    for (const n of nodes) {
      if (n != null && typeof n.id === 'string' && C.isCmcInternalStreamId(n.id)) continue;
      if (Array.isArray(n?.children)) n.children = prune(n.children);
      kept.push(n);
    }
    return kept;
  }
  return function cmcStreamsGetInternalGuard (_context, _params, result, next) {
    if (result != null && Array.isArray(result.streams)) {
      result.streams = prune(result.streams);
    }
    next();
  };
}

/**
 * events.create hook — Phase 4 H8 `content.from` forge-prevention for
 * chat / system messages delivered into our per-app streams by a
 * counterparty-marked access (i.e. peer outbound POSTs that landed on
 * our :_cmc:apps:<app>:[<sub>:]chats:<slug> or
 * :_cmc:apps:<app>:[<sub>:]collectors:<slug>).
 *
 * `inboxWriteHook` already handles writes to `:_cmc:inbox` (lifecycle
 * events) — including from-stamping with stricter validation
 * (rejection on missing identity). This hook is the sibling for
 * non-inbox CMC writes coming from peers. The peer's authentication
 * token is a counterparty-marked shared access on our server; its
 * `clientData.cmc.counterparty.{username, host}` was stamped at
 * handshake time from the OFFER metadata (server-derived, not
 * user-supplied), so it's the canonical identity. We overwrite
 * `event.content.from` with that identity before persist, dropping any
 * value the peer may have hand-crafted into the body.
 *
 * Behaviour:
 *   - Passthrough if no `context.newEvent`.
 *   - Passthrough if writer is not a counterparty-marked access
 *     (i.e. self-writes from a personal/app token — local content.from
 *     is the app's hygiene problem, not a cross-actor forge vector).
 *   - Passthrough if event type isn't a chat/system family member.
 *   - Passthrough on writes to `:_cmc:inbox` — `inboxWriteHook` owns
 *     those (different rejection semantics on missing identity).
 *   - Otherwise: overwrite content.from with the access's stored
 *     counterparty identity.
 */
function createCounterpartyFromStampingHook (deps: Deps): Middleware {
  const TYPES_WITH_FROM = new Set([
    C.ET_CHAT, C.ET_SYSTEM_ALERT, C.ET_SYSTEM_ACK,
    C.ET_SYSTEM_SCOPE_REQUEST, C.ET_SYSTEM_SCOPE_UPDATE,
  ]);
  return function cmcCounterpartyFromStampingHook (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event == null) return next();
    if (!TYPES_WITH_FROM.has(event.type)) return next();

    const accessCmc = context?.access?.clientData?.cmc;
    if (accessCmc?.role !== 'counterparty') return next();

    const streamIds: string[] = Array.isArray(event.streamIds) ? event.streamIds : [];
    if (streamIds.includes(C.NS_INBOX)) return next();

    const counterparty = accessCmc.counterparty;
    if (counterparty?.username == null || counterparty?.host == null) {
      // No identity stored on access — can't stamp safely. Reject so the
      // peer's malformed access surfaces rather than persisting a write
      // with whatever they hand-crafted.
      return next(deps.errors.invalidOperation(
        'Counterparty access is missing identity (clientData.cmc.counterparty.{username,host})',
        { id: 'cmc-counterparty-identity-missing' }
      ));
    }

    event.content = {
      ...(event.content || {}),
      from: { username: counterparty.username, host: counterparty.host },
    };
    context.newEvent = event;
    next();
  };
}

/**
 * accesses.create / accesses.update hook — Phase 4 H7 forge-prevention.
 *
 * The `clientData.cmc` namespace is owned end-to-end by the CMC plugin:
 * `role`, `appCode`, `counterparty`, `capability`, `requestEventId`,
 * `features` are all populated by `mall.accesses.create` /
 * `mall.accesses.update` calls inside the plugin (handshake +
 * acceptOrchestration + capabilityMintHook + scope-update). User code
 * has no legitimate reason to populate any field under this key, and
 * allowing it would let a malicious app forge a counterparty role on
 * its own access (bypassing the handshake) or stamp a fake
 * `capability.state` to confuse the lifecycle.
 *
 * The CMC plugin reaches the storage layer via `mall.accesses.create` /
 * `mall.accesses.update`, NOT via the api-server route — so blocking
 * `clientData.cmc.*` at the route level is safe.
 *
 * Behaviour: if `params.clientData?.cmc != null` (any nested fields),
 * reject with `cmc-clientdata-cmc-forbidden`. Other `clientData.*` keys
 * pass through unchanged.
 *
 * Pair: `createAccessUpdateForgePreventionHook` does the same for the
 * `params.update.clientData.cmc` path on `accesses.update`.
 */
function createAccessCreateForgePreventionHook (deps: Deps): Middleware {
  return function cmcAccessCreateForgePreventionHook (context, params, result, next) {
    const clientData = params?.clientData;
    if (clientData != null && typeof clientData === 'object' && clientData.cmc != null) {
      return next(deps.errors.invalidOperation(
        'clientData.cmc is reserved for the CMC plugin and may not be supplied by user code',
        { id: 'cmc-clientdata-cmc-forbidden' }
      ));
    }
    next();
  };
}

function createAccessUpdateForgePreventionHook (deps: Deps): Middleware {
  return function cmcAccessUpdateForgePreventionHook (context, params, result, next) {
    const update = params?.update;
    const clientData = update?.clientData;
    if (clientData != null && typeof clientData === 'object' && clientData.cmc != null) {
      return next(deps.errors.invalidOperation(
        'clientData.cmc is reserved for the CMC plugin and may not be supplied by user code',
        { id: 'cmc-clientdata-cmc-forbidden' }
      ));
    }
    next();
  };
}

/**
 * accesses.create / accesses.update post-hook — per-app appScope lazy provisioning.
 *
 * The 5 reserved parents under `:_cmc:` are pre-provisioned at user
 * creation by `provisioning.ts`. Per-app sub-trees under
 * `:_cmc:apps:<app-code>` were historically created on demand at
 * CMC-acceptance time (see `provisioning.ts:21-26`). The OAuth-grant
 * flow used by doctor-dashboard never reaches an acceptance event
 * before the first invite, so the per-app *root* `:_cmc:apps:<app-code>`
 * is missing when downstream `streams.create` for a child of it runs,
 * producing `unknown-referenced-resource`.
 *
 * This hook runs AFTER `createAccess` / `snapshotAndApplyUpdate` so
 * `result.access.permissions` is the post-state. It scans those perms
 * for any `streamId` resolving to a valid app-code via `getAppCode()`
 * and pre-creates the leaf `:_cmc:apps:<app-code>` as a child of
 * `:_cmc:apps` via mall.streams.create — bypassing api-server
 * middleware, the same pattern `provisioning.ts:provisionUserStreams`
 * uses (otherwise the reserved-root hook would reject the create).
 *
 * Deep app sub-trees (`:_cmc:apps:<app>:chats:*` /
 * `:_cmc:apps:<app>:<...>:collectors:*`) keep their on-demand-at-
 * acceptance-time behaviour — this hook only provisions the leaf root.
 *
 * Provisioning failures are logged but do NOT fail the access response:
 * the access already exists, surfacing an error here would confuse the
 * caller (access stored but response 5xx). If the stream truly can't be
 * created, the caller's first `streams.create` against the child will
 * surface the same downstream error — matching pre-fix behaviour, not
 * worse.
 */

type MallStreamsOnly = { streams: import('./_types.ts').MallStreamsLike };

type ProvisionLogger = {
  debug?: (msg: string, ...rest: unknown[]) => void;
  warn?: (msg: string, ...rest: unknown[]) => void;
};

type ProvisionDeps = {
  mall: MallStreamsOnly;
  logger?: ProvisionLogger;
};

// Matches the slug.ts SLUG_PIECE_RE — `manage` perm on an app-code
// segment is only allowed to provision a stream whose name passes the
// same shape check the rest of the plugin uses for slug pieces.
const APP_CODE_RE = /^[a-z0-9-]+$/;
const RESERVED_APP_SEGMENTS = new Set(C.APP_RESERVED_SEGMENTS);

/**
 * Extract the set of `:_cmc:apps:<app-code>` leaf stream-ids that this
 * permission list authorises and which therefore need to exist. Walks
 * each perm's streamId through `getAppCode()`; a non-empty result that
 * passes APP_CODE_RE and isn't a reserved sub-segment is added.
 *
 * Returns a deduped Set so callers can iterate without rework.
 */
function extractAppScopeLeavesToProvision (permissions: Array<{ streamId?: unknown }>): Set<string> {
  const targets = new Set<string>();
  if (!Array.isArray(permissions)) return targets;
  for (const perm of permissions) {
    const sid = perm?.streamId;
    if (typeof sid !== 'string') continue;
    const appCode = C.getAppCode(sid);
    if (appCode == null || appCode === '') continue;
    if (RESERVED_APP_SEGMENTS.has(appCode)) continue;
    if (!APP_CODE_RE.test(appCode)) continue;
    targets.add(C.NS_APPS + ':' + appCode);
  }
  return targets;
}

function createAccessProvisionAppScopeHook (deps: ProvisionDeps): Middleware {
  return async function cmcAccessProvisionAppScopeHook (context, params, result, next) {
    const userId = context?.user?.id;
    const access = result?.access;
    if (userId == null || access == null) return next();

    const targets = extractAppScopeLeavesToProvision(Array.isArray(access.permissions) ? access.permissions : []);
    if (targets.size === 0) return next();

    // The leaf is created as a child of `:_cmc:apps`, which only exists
    // once the reserved tree has been provisioned. On a grant-first
    // account (an access minted before any other CMC operation) that
    // parent is absent and every leaf create below fails with
    // `unknown-referenced-resource` — the same read-first class of gap
    // as open-pryv.io#111, reached through the access path. Ensure the
    // tree first (memoised + probe-guarded, so this is nearly free).
    try {
      await ensureReservedParentsOnce(deps, userId);
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc: failed to ensure reserved parents before app-scope provisioning', {
        userId,
        error: String((err as Error)?.message || err),
      });
    }

    for (const streamId of targets) {
      const appCode = C.getAppCode(streamId);
      const payload: Record<string, unknown> = {
        id: streamId,
        parentId: C.NS_APPS,
        name: appCode,
        clientData: { cmc: { kind: 'app-scope-root', autoProvisioned: true } },
      };
      if (access.id != null) {
        payload.createdBy = access.id;
        payload.modifiedBy = access.id;
      }
      try {
        await deps.mall.streams.create(userId, payload);
        deps.logger?.debug?.('cmc: provisioned app-scope root', {
          userId, streamId, accessId: access.id,
        });
      } catch (err: unknown) {
        if (provisioning.isAlreadyExistsError(err)) {
          deps.logger?.debug?.('cmc: app-scope root already present', { userId, streamId });
          continue;
        }
        deps.logger?.warn?.('cmc: failed to provision app-scope root', {
          userId,
          streamId,
          accessId: access.id,
          error: (err as Error)?.message || err,
        });
        // Intentional: continue rather than abort. See docstring.
      }
    }

    next();
  };
}

export {
  createCmcContentValidationHook,
  createStreamCreateReservedRootHook,
  createStreamDeleteReservedRootHook,
  createEnsureReservedParentsHook,
  streamsParamReferencesCmc,
  _resetEnsuredUsersMemo,
  createCounterpartyFromStampingHook,
  createAccessCreateForgePreventionHook,
  createAccessUpdateForgePreventionHook,
  createAccessProvisionAppScopeHook,
  extractAppScopeLeavesToProvision,
  createEventsGetInternalGuardHook,
  createEventGetOneInternalGuardHook,
  createStreamsGetInternalGuardHook,
};
