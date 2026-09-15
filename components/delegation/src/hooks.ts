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
};
type HookParams = {
  id?: unknown;
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

// ---------------------------------------------------------- LIFECYCLE PROTECTION

/**
 * accesses.delete hook — reject deletion of a delegation-marker access.
 *
 * Wired AFTER the delete chain has resolved the targets: `params.accessToDelete`
 * (the primary target loaded by checkAccessForDeletion) and
 * `params.relatedAccessesToDelete` (cascade descendants). If any target carries
 * `clientData.delegation`, reject — the plugin owns these and tears them down
 * itself during detach.
 */
function createAccessesDeleteGuardHook (deps: Deps): Middleware {
  return function delegationAccessesDeleteGuard (context, params, result, next) {
    const targets: AccessLike[] = [];
    if (params?.accessToDelete != null) targets.push(params.accessToDelete);
    if (Array.isArray(params?.relatedAccessesToDelete)) targets.push(...params.relatedAccessesToDelete);
    for (const target of targets) {
      if (hasDelegationMarker(target)) {
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
 * accesses.update hook — reject updating an access that already carries a
 * `clientData.delegation` marker. The pre-image target is loaded onto
 * `params.targetAccess` by loadAccessForUpdate; this hook is wired directly
 * after it.
 */
function createAccessesUpdateGuardHook (deps: Deps): Middleware {
  return function delegationAccessesUpdateGuard (context, params, result, next) {
    if (hasDelegationMarker(params?.targetAccess)) {
      return next(deps.errors.invalidOperation(
        'This access is managed by the account-delegation plugin and may not be updated directly',
        { id: DelegationErrorIds.MANAGED_RESOURCE }
      ));
    }
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
  createAccessesDeleteGuardHook,
  createAccessesUpdateGuardHook,
  createStreamCreateReservedRootHook,
  createStreamDeleteReservedRootHook,
  createEventsWriteGuardHook,
  createEventsDeleteGuardHook,
  createEventsUpdateGuardHook,
};
