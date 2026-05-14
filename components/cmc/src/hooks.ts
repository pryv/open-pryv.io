/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Plan 68 — middleware factories for the CMC plugin's write-hooks.
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

type ErrorFactory = {
  invalidOperation: (message: string, details?: any) => any;
};

type Deps = {
  errors: ErrorFactory;
};

type Middleware = (context: any, params: any, result: any, next: any) => any | Promise<any>;

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
    const isCmcType = typeof type === 'string' && type.startsWith('cmc/');
    if (isCmcType) {
      context.cmc.eventType = type;
    }

    if (!isCmcType) {
      // App-defined type in a :_cmc:* stream — pass through. Useful for app
      // organizational metadata under :_cmc:apps:* (e.g. a 'collector/metadata'
      // event the app uses for its own purposes).
      return next();
    }

    if (!validators.isKnownEventType(type)) {
      return next(deps.errors.invalidOperation(
        'CMC event type "' + type + '" is not a recognised cmc/* type',
        { id: 'cmc-unknown-event-type', eventType: type }
      ));
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
 * events.create / streams.create lazy auto-provision hook.
 *
 * Existing user accounts that pre-date the CMC deploy don't have the
 * five reserved parents (`:_cmc:`, `:_cmc:inbox`, `:_cmc:apps`,
 * `:_cmc:_internal`, `:_cmc:_internal:retries`). User-creation-time
 * provisioning is currently disabled per the AC04 workaround, so we
 * provision lazily — on the first :_cmc:* operation for that user.
 *
 * This middleware MUST fire BEFORE any code path that depends on the
 * parents existing (verifyCanCreateEventsOnStream, parent-id resolution
 * in streams.create, etc.). Idempotent: subsequent CMC operations on
 * the same user catch `item-already-exists` and no-op.
 *
 * Gating:
 *   - events.create: trigger if streamIds contain a `:_cmc:*` id OR
 *     event.type starts with 'cmc/'.
 *   - streams.create: trigger if the new stream's id starts with `:_cmc:`.
 *
 * Failure is non-fatal (logged) — the downstream call will surface a
 * clearer "parent not found" error if provisioning truly didn't take.
 */
type ProvisionDeps = {
  mall: { streams: { create: (userId: string, params: any) => Promise<any> } };
  logger?: { debug: Function; warn: Function };
};

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
      } else if (typeof newEvent.type === 'string' && newEvent.type.startsWith('cmc/')) {
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
    }

    if (!shouldEnsure) return next();

    try {
      await provisioning.provisionUserStreams({
        mall: deps.mall,
        userId,
        logger: deps.logger,
      });
    } catch (err: any) {
      deps.logger?.warn?.('cmc/ensureReservedParents: failed (continuing)', {
        userId,
        error: String(err?.message || err),
      });
    }
    next();
  };
}

export {
  createCmcContentValidationHook,
  createStreamCreateReservedRootHook,
  createEnsureReservedParentsHook,
};
