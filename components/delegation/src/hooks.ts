/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Middleware factories for the account-delegation plugin's guard hooks.
 *
 * Each factory takes a `deps` object (errors factory) and returns an
 * api-server-shaped middleware: `(context, params, result, next) → void`.
 *
 * These are pure factories — no module-level side effects, no api-server
 * imports — so they can be unit-tested with fake deps. Wiring into the real
 * chain lives in api-server (methods/accesses.ts + methods/events.ts).
 *
 * Three protection families:
 *   - FORGE PREVENTION: user code may not supply `clientData.delegation` on
 *     accesses.create / accesses.update.
 *   - LIFECYCLE PROTECTION: a delegation-marker access/event may not be
 *     deleted or updated via the generic APIs by ANY token.
 *   - NAMESPACE WRITE PROTECTION: the `:_delegation:*` stream namespace is
 *     plugin-owned; user code may not create/delete its streams nor write
 *     events into it.
 */

import * as C from './constants.ts';
import { DelegationErrorIds } from './errorIds.ts';

type ApiError = Error & { id?: string; data?: unknown };
type ErrorFactory = {
  invalidOperation: (message: string, details?: Record<string, unknown>) => ApiError;
  unknownResource?: (resource: string, id?: unknown) => ApiError;
};
type Deps = {
  errors: ErrorFactory;
};

// Types enumerate only the fields these guard hooks read (the api-server
// method params carry more; the hooks are deliberately narrow).
type ClientDataLike = { delegation?: unknown };
type AccessLike = {
  id?: string;
  clientData?: ClientDataLike | null;
};
type EventLike = {
  type?: string;
  streamIds?: string[];
};
type MethodContext = {
  newEvent?: EventLike;
  oldEvent?: EventLike;
  // events.getOne stages the resolved event here; the getOne guard reads its
  // streamIds (the event carries more fields at runtime — only streamIds is read).
  event?: EventLike;
};
// streams.get response node: the guard reads only id + children; runtime nodes
// carry more fields (name, parentId, …) that survive the pass untouched.
type StreamNode = { id?: string; children?: StreamNode[] };
type HookParams = {
  id?: unknown;
  // events.get stream queries: ids and/or {streamId} query objects
  streams?: Array<string | { streamId?: string } | null>;
  clientData?: ClientDataLike | null;
  update?: { id?: unknown; clientData?: ClientDataLike | null } | null;
  targetAccess?: AccessLike;
  accessToDelete?: AccessLike;
  relatedAccessesToDelete?: AccessLike[];
} | null | undefined;
type HookResult = Record<string, unknown> | null | undefined;
type MethodNext = (err?: unknown) => unknown;
type Middleware = (context: MethodContext, params: HookParams, result: HookResult, next: MethodNext) => unknown | Promise<unknown>;

/** True when an access carries a `clientData.delegation` marker. */
function hasDelegationMarker (access: AccessLike | null | undefined): boolean {
  const clientData = access?.clientData;
  return clientData != null && typeof clientData === 'object' && clientData.delegation != null;
}

type MarkerLike = { kind?: unknown; relId?: unknown; delegate?: unknown };

/** The marker's `kind`, or null when the access carries no marker. */
function markerKind (access: AccessLike | null | undefined): unknown {
  if (!hasDelegationMarker(access)) return null;
  const marker = access!.clientData!.delegation as MarkerLike;
  return typeof marker === 'object' ? marker.kind : undefined;
}

/**
 * True for a marker the plugin owns (control, delegate PAT, invite
 * capability, notify, or any kind not known here): such an access is
 * control-plane state and only the plugin may delete or update it.
 * A `delegated-child` access is an ordinary grant that happens to have been
 * made by a delegate; its lifecycle follows the normal access rules.
 */
function isPluginOwnedMarker (access: AccessLike | null | undefined): boolean {
  return hasDelegationMarker(access) && markerKind(access) !== C.CLIENTDATA_KIND.DELEGATED_CHILD;
}

/** True when a stream-id list references the `:_delegation:*` namespace. */
function streamIdsReferenceDelegation (streamIds: unknown): boolean {
  if (!Array.isArray(streamIds)) return false;
  return streamIds.some((id) => typeof id === 'string' && C.isDelegationStreamId(id));
}

// ------------------------------------------------------------- FORGE PREVENTION

/**
 * accesses.create hook — forge-prevention.
 *
 * The `clientData.delegation` namespace is owned end-to-end by the plugin.
 * User code has no legitimate reason to populate it, and allowing it would let
 * a malicious app forge a delegation marker on its own access (bypassing the
 * handshake). The plugin reaches storage via the data-access layer, NOT via
 * this route, so blocking `clientData.delegation` at the route level is safe.
 */
function createAccessCreateForgePreventionHook (deps: Deps): Middleware {
  return function delegationAccessCreateForgePreventionHook (context, params, result, next) {
    const clientData = params?.clientData;
    if (clientData != null && typeof clientData === 'object' && clientData.delegation != null) {
      return next(deps.errors.invalidOperation(
        'clientData.delegation is reserved for the account-delegation plugin and may not be supplied by user code',
        { id: DelegationErrorIds.CLIENTDATA_FORBIDDEN }
      ));
    }
    next();
  };
}

/**
 * accesses.update hook — forge-prevention on the `params.update.clientData`
 * path. Pair of `createAccessCreateForgePreventionHook`.
 */
function createAccessUpdateForgePreventionHook (deps: Deps): Middleware {
  return function delegationAccessUpdateForgePreventionHook (context, params, result, next) {
    const clientData = params?.update?.clientData;
    if (clientData != null && typeof clientData === 'object' && clientData.delegation != null) {
      return next(deps.errors.invalidOperation(
        'clientData.delegation is reserved for the account-delegation plugin and may not be supplied by user code',
        { id: DelegationErrorIds.CLIENTDATA_FORBIDDEN }
      ));
    }
    next();
  };
}

// ------------------------------------------------------------------- LINEAGE

type LineageContext = {
  access?: { id?: string; clientData?: ClientDataLike | null } | null;
};

/**
 * accesses.create hook — lineage marker. An access created while
 * authenticated by a delegate PAT (or by an access such a PAT created) lives
 * on the controlled account but was granted by the delegate: stamp
 * `clientData.delegation = { kind: 'delegated-child', relId, delegate,
 * viaAccessId }` on it, so access-info and audit name the delegate and
 * detach can revoke it.
 *
 * The source of truth is the authenticated access only. MUST run after the
 * forge-prevention hook, which has already refused any client-supplied
 * `clientData.delegation`.
 */
function createAccessCreateLineageHook (): Middleware {
  return function delegationAccessCreateLineageHook (context, params, _result, next) {
    const creator = (context as LineageContext).access;
    const kind = markerKind(creator);
    if (kind !== C.CLIENTDATA_KIND.DELEGATE_PAT && kind !== C.CLIENTDATA_KIND.DELEGATED_CHILD) return next();
    if (params == null) return next();
    const marker = creator!.clientData!.delegation as MarkerLike;
    params.clientData = {
      ...(params.clientData ?? {}),
      delegation: {
        kind: C.CLIENTDATA_KIND.DELEGATED_CHILD,
        relId: marker.relId,
        delegate: marker.delegate,
        viaAccessId: creator!.id,
      },
    };
    next();
  };
}

// ------------------------------------------------------- INTERNAL READ PROTECTION

/**
 * events.get hook — defense-in-depth: strip every explicit `:_delegation:_internal:*`
 * stream-id from a caller's `params.streams` before the query reaches the store.
 *
 * The internal subtree holds the plugin's private records — including the
 * A-side mirror, whose payload carries a control credential onto another
 * account. It is personal-visibility only and must never reach a client, so a
 * direct-target read must return nothing.
 *
 * MUST be wired AFTER `coerceStreamsParam` — that step normalises the wire
 * forms (a single-value `streams=<id>` arrives as a bare string, not an array)
 * into an array, so running before it would let a single-value internal query
 * slip past the array filter. Handles all post-coerce shapes: bare id strings,
 * `{streamId}` query objects, and logical `{any|all|not:[ids]}` queries (the
 * internal ids are scrubbed from each list). A wildcard `'*'` is NOT a
 * direct-target read and is left untouched (it is governed by access
 * permissions, and is the residual this hook cannot close on its own).
 */
function createEventsGetInternalGuardHook (): Middleware {
  function scrubList (list: unknown): unknown {
    if (!Array.isArray(list)) return list;
    return list.filter((id) => !(typeof id === 'string' && C.isDelegationInternalStreamId(id)));
  }
  return function delegationEventsGetInternalGuard (_context, params, _result, next) {
    if (params == null || !Array.isArray(params.streams)) return next();
    params.streams = params.streams.filter((s: unknown) => {
      if (typeof s === 'string') return !C.isDelegationInternalStreamId(s);
      if (s != null && typeof s === 'object') {
        const obj = s as { streamId?: unknown; any?: unknown; all?: unknown; not?: unknown };
        if (typeof obj.streamId === 'string' && C.isDelegationInternalStreamId(obj.streamId)) return false;
        // Logical-query form: scrub internal ids out of any/all/not in place.
        if (obj.any !== undefined) obj.any = scrubList(obj.any);
        if (obj.all !== undefined) obj.all = scrubList(obj.all);
        if (obj.not !== undefined) obj.not = scrubList(obj.not);
      }
      return true;
    });
    next();
  };
}

/**
 * events.getOne hook — defense-in-depth: if the fetched event lives in
 * `:_delegation:_internal:*`, return 404 instead of leaking its existence.
 *
 * Wired AFTER the existing findEvent middleware (which loads `context.event`)
 * so this hook sees the resolved event. Any presence of an internal id means
 * the event should not be visible at all.
 */
function createEventGetOneInternalGuardHook (deps: Deps): Middleware {
  return function delegationEventGetOneInternalGuard (context, params, _result, next) {
    const event = context?.event;
    if (event == null) return next();
    const streamIds: string[] = Array.isArray(event.streamIds) ? event.streamIds : [];
    if (streamIds.some((id: string) => C.isDelegationInternalStreamId(id))) {
      // Drop the staged event so downstream middleware doesn't render it, then
      // surface 404 (info-leak parity with the hidden-system-stream pattern).
      delete context.event;
      return next(deps.errors.unknownResource?.('event', params?.id) ??
        deps.errors.invalidOperation('Event not found', { id: 'unknown-resource' }));
    }
    next();
  };
}

/**
 * streams.get hook — defense-in-depth: prune the `:_delegation:_internal`
 * subtree from the response tree. The tree returned by findAccessibleStreams is
 * a forest of `{id, children}` nodes; we recursively drop any node whose id is
 * in the internal region.
 *
 * Wired AFTER findAccessibleStreams populates `result.streams`.
 */
function createStreamsGetInternalGuardHook (): Middleware {
  function prune (nodes: StreamNode[]): StreamNode[] {
    if (!Array.isArray(nodes)) return nodes;
    const kept: StreamNode[] = [];
    for (const n of nodes) {
      if (n != null && typeof n.id === 'string' && C.isDelegationInternalStreamId(n.id)) continue;
      if (Array.isArray(n?.children)) n.children = prune(n.children);
      kept.push(n);
    }
    return kept;
  }
  return function delegationStreamsGetInternalGuard (_context, _params, result, next) {
    const r = result as { streams?: StreamNode[] } | null | undefined;
    if (r != null && Array.isArray(r.streams)) {
      r.streams = prune(r.streams);
    }
    next();
  };
}

// ---------------------------------------------------------- LIFECYCLE PROTECTION

/**
 * accesses.delete hook — reject deletion of a plugin-owned access.
 *
 * Wired AFTER the delete chain has resolved the targets: `params.accessToDelete`
 * (the primary target loaded by checkAccessForDeletion) and
 * `params.relatedAccessesToDelete` (cascade descendants). If any target carries
 * a plugin-owned `clientData.delegation` marker, reject — the plugin tears
 * those down itself during detach. A `delegated-child` access is revocable
 * like any access (by the account owner, the delegate, or the app itself).
 */
function createAccessesDeleteGuardHook (deps: Deps): Middleware {
  return function delegationAccessesDeleteGuard (context, params, result, next) {
    const targets: AccessLike[] = [];
    if (params?.accessToDelete != null) targets.push(params.accessToDelete);
    if (Array.isArray(params?.relatedAccessesToDelete)) targets.push(...params.relatedAccessesToDelete);
    for (const target of targets) {
      if (isPluginOwnedMarker(target)) {
        return next(deps.errors.invalidOperation(
          'This access is managed by the account-delegation plugin and may not be deleted directly',
          { id: DelegationErrorIds.MANAGED_RESOURCE }
        ));
      }
    }
    next();
  };
}

/**
 * accesses.update hook — reject updating an access that carries a
 * plugin-owned `clientData.delegation` marker. The pre-image target is loaded
 * onto `params.targetAccess` by loadAccessForUpdate; this hook is wired
 * directly after it. A `delegated-child` access is updatable like any access
 * (its marker is kept by `createAccessesUpdateMarkerPreserveHook`).
 */
function createAccessesUpdateGuardHook (deps: Deps): Middleware {
  return function delegationAccessesUpdateGuard (context, params, result, next) {
    if (isPluginOwnedMarker(params?.targetAccess)) {
      return next(deps.errors.invalidOperation(
        'This access is managed by the account-delegation plugin and may not be updated directly',
        { id: DelegationErrorIds.MANAGED_RESOURCE }
      ));
    }
    next();
  };
}

/**
 * accesses.update hook — keep a `delegated-child` marker across updates.
 * Storage merges an update's `clientData` one level deep and removes a key
 * sent as `null`, so `{ delegation: null }` (which the forge hook lets
 * through: it refuses values only) or a null `clientData` would drop the
 * marker, and with it the delegate's attribution and the detach
 * revocation. Wired after the update guard; the
 * forge-prevention hook has already refused a client-supplied `delegation`,
 * so the only value that can reach storage is the stored one.
 */
function createAccessesUpdateMarkerPreserveHook (): Middleware {
  return function delegationAccessesUpdateMarkerPreserve (_context, params, _result, next) {
    const target = params?.targetAccess;
    if (markerKind(target) !== C.CLIENTDATA_KIND.DELEGATED_CHILD) return next();
    const update = params?.update;
    if (update == null || update.clientData === undefined) return next();
    update.clientData = {
      ...(update.clientData ?? {}),
      delegation: target!.clientData!.delegation,
    };
    next();
  };
}

// ----------------------------------------------------- NAMESPACE WRITE PROTECTION

/**
 * streams.create hook — reject creation of any `:_delegation:*` stream. Unlike
 * the cross-account messaging namespace there is NO user-creatable region: the
 * whole namespace is plugin-managed and auto-provisioned. Tolerates the
 * `{ update: {...} }` wrapper some stream flows pass.
 */
function createStreamCreateReservedRootHook (deps: Deps): Middleware {
  return function delegationStreamCreateReservedRootHook (context, params, result, next) {
    const target = (params != null && typeof params === 'object' && params.update != null)
      ? params.update
      : params;
    const id: unknown = target?.id;
    if (typeof id !== 'string') return next();
    if (!C.isDelegationStreamId(id)) return next();
    return next(deps.errors.invalidOperation(
      'Stream "' + id + '" is reserved and managed by the account-delegation plugin',
      { id: DelegationErrorIds.RESERVED_STREAM, streamId: id }
    ));
  };
}

/**
 * streams.delete hook — reserved-namespace immutability. Symmetric counterpart
 * to the create hook: even a personal token may not delete a `:_delegation:*`
 * stream.
 */
function createStreamDeleteReservedRootHook (deps: Deps): Middleware {
  return function delegationStreamDeleteReservedRootHook (context, params, result, next) {
    const id: unknown = params?.id;
    if (typeof id !== 'string') return next();
    if (!C.isDelegationStreamId(id)) return next();
    return next(deps.errors.invalidOperation(
      'Stream "' + id + '" is reserved by the account-delegation plugin and may not be deleted',
      { id: DelegationErrorIds.RESERVED_STREAM, streamId: id }
    ));
  };
}

/**
 * events.create hook — reject writes into the delegation namespace. User code
 * may not write an event that targets a `:_delegation:*` stream OR carries a
 * `delegation/*` type; the plugin writes the namespace via the data-access
 * layer in later phases.
 */
function createEventsWriteGuardHook (deps: Deps): Middleware {
  return function delegationEventsWriteGuard (context, params, result, next) {
    const event = context?.newEvent;
    if (event == null) return next();
    const type = event.type;
    const targetsNamespace = streamIdsReferenceDelegation(event.streamIds);
    const delegationType = typeof type === 'string' && type.startsWith(C.ET_PREFIX);
    if (targetsNamespace || delegationType) {
      return next(deps.errors.invalidOperation(
        'Events in the account-delegation namespace are managed by the plugin and may not be written by user code',
        { id: DelegationErrorIds.RESERVED_STREAM }
      ));
    }
    next();
  };
}

/**
 * events.delete hook — reject deletion of an event living in a `:_delegation:*`
 * stream. Wired alongside blockAccountEventDeletion, which reads the pre-image
 * from `context.oldEvent`.
 */
function createEventsDeleteGuardHook (deps: Deps): Middleware {
  return function delegationEventsDeleteGuard (context, params, result, next) {
    const event = context?.oldEvent;
    if (streamIdsReferenceDelegation(event?.streamIds)) {
      return next(deps.errors.invalidOperation(
        'This event is managed by the account-delegation plugin and may not be deleted',
        { id: DelegationErrorIds.MANAGED_RESOURCE }
      ));
    }
    next();
  };
}

/**
 * events.update hook — reject updating an event living in a `:_delegation:*`
 * stream. The pre-image is loaded onto `context.oldEvent` by
 * applyPrerequisitesForUpdate; this hook is wired directly after it.
 */
function createEventsUpdateGuardHook (deps: Deps): Middleware {
  return function delegationEventsUpdateGuard (context, params, result, next) {
    const event = context?.oldEvent;
    if (streamIdsReferenceDelegation(event?.streamIds)) {
      return next(deps.errors.invalidOperation(
        'This event is managed by the account-delegation plugin and may not be updated',
        { id: DelegationErrorIds.MANAGED_RESOURCE }
      ));
    }
    next();
  };
}

export {
  createAccessCreateForgePreventionHook,
  createAccessUpdateForgePreventionHook,
  createAccessCreateLineageHook,
  createAccessesDeleteGuardHook,
  createAccessesUpdateGuardHook,
  createAccessesUpdateMarkerPreserveHook,
  createStreamCreateReservedRootHook,
  createStreamDeleteReservedRootHook,
  createEventsWriteGuardHook,
  createEventsDeleteGuardHook,
  createEventsUpdateGuardHook,
  createEventsGetInternalGuardHook,
  createEventGetOneInternalGuardHook,
  createStreamsGetInternalGuardHook,
};
