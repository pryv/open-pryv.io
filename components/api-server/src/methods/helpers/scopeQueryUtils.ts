/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MethodContext } from 'business/src/MethodContext.ts';
import type { NormalizedCondition, StreamGroup, StreamCondition, EventMatchQuery } from 'utils';
const require = createRequire(import.meta.url);
const eventsGetUtils = require('./eventsGetUtils.ts');
const { validateAndNormalizeConditions } = require('storages/shared/contentQueryConditions.ts');
const errors = require('errors').factory;

/**
 * Resolve a raw notification scope query into the prepared form the
 * NotificationEngine matches against.
 *
 * Stream resolution reuses the exact `events.get` middleware chain
 * (permission check + `*`-replacement + recursive expansion), so a scope is
 * bound to what the registering token can read and matches streams recursively
 * — identical semantics to `events.get`. A scope with no `streams` defaults to
 * `[{ any: ['*'] }]`, which the permission step replaces with the token's
 * readable root streams: a content/type-only scope is therefore implicitly
 * bounded to the token's readable streams (never an over-broad match).
 *
 * `content` / `clientData` are validated + normalized with the same validator
 * `events.get` uses.
 */

type RawScopeQuery = {
  streams?: unknown;
  types?: string[];
  content?: unknown;
  clientData?: unknown;
  state?: string;
  accessIds?: string[]; // accesses-kind only
};

const STREAM_PREP_STEPS = [
  eventsGetUtils.coerceStreamsParam,
  eventsGetUtils.applyDefaultsForRetrieval,
  eventsGetUtils.transformArrayOfStringsToStreamsQuery,
  eventsGetUtils.validateStreamsQueriesAndSetStore,
  eventsGetUtils.streamQueryCheckPermissionsAndReplaceStars,
  eventsGetUtils.streamQueryAddForcedAndForbiddenStreams,
  eventsGetUtils.streamQueryExpandStreams,
  eventsGetUtils.streamQueryAddHiddenStreams
];

const noopTracing = { startSpan () {}, finishSpan () {}, setError () {} };

function runStep (
  step: (c: MethodContext, p: unknown, r: unknown, n: (e?: unknown) => void) => void,
  context: MethodContext, params: unknown, result: unknown
): Promise<void> {
  return new Promise((resolve, reject) => {
    step(context, params, result, (err?: unknown) => (err != null ? reject(err) : resolve()));
  });
}

/** Flatten the expanded `arrayOfStreamQueriesWithStoreId` into matcher groups. */
function toStreamGroups (items: Array<{ any?: string[]; not?: string[]; and?: Array<{ any?: string[]; not?: string[] }> }>): StreamGroup[] {
  const groups: StreamGroup[] = [];
  for (const item of items ?? []) {
    const conditions: StreamCondition[] = [];
    if (Array.isArray(item.any) && item.any.length > 0) conditions.push({ any: item.any });
    if (Array.isArray(item.and)) {
      for (const sub of item.and) {
        if (Array.isArray(sub.any) && sub.any.length > 0) conditions.push({ any: sub.any });
        if (Array.isArray(sub.not) && sub.not.length > 0) conditions.push({ not: sub.not });
      }
    }
    if (Array.isArray(item.not) && item.not.length > 0) conditions.push({ not: item.not });
    if (conditions.length > 0) groups.push(conditions);
  }
  return groups;
}

/**
 * Prepare a raw scope query for the NotificationEngine. Throws (via the
 * events.get validators) on an invalid or unauthorized stream query.
 */
async function prepareScopeQuery (context: MethodContext, rawScope: RawScopeQuery): Promise<EventMatchQuery> {
  await eventsGetUtils.init();
  const params: { streams?: unknown; state?: string; arrayOfStreamQueriesWithStoreId?: unknown[] } = {
    streams: rawScope.streams,
    state: rawScope.state
  };
  const result = {};

  // Run the prep steps with a no-op tracer to avoid the MethodContext `tracing`
  // getter's noisy null-substitution. Save/restore the RAW `_tracing` field
  // (not via the getter, which would log when null) so that — when called
  // inside a real traced method (e.g. webhooks.create) — the live tracer is
  // preserved for downstream steps/audit.
  const rawCtx = context as unknown as { _tracing: unknown };
  const savedTracing = rawCtx._tracing;
  const savedAccept = context.acceptStreamsQueryNonStringified;
  context.tracing = noopTracing as unknown as MethodContext['tracing'];
  context.acceptStreamsQueryNonStringified = true;
  try {
    for (const step of STREAM_PREP_STEPS) {
      await runStep(step, context, params, result);
    }
  } finally {
    rawCtx._tracing = savedTracing;
    context.acceptStreamsQueryNonStringified = savedAccept;
  }

  const prepared: EventMatchQuery = {
    streams: toStreamGroups(params.arrayOfStreamQueriesWithStoreId as Parameters<typeof toStreamGroups>[0])
  };
  if (Array.isArray(rawScope.types) && rawScope.types.length > 0) prepared.types = rawScope.types;
  if (rawScope.content != null) prepared.content = validateAndNormalizeConditions(rawScope.content, 'content') as NormalizedCondition[];
  if (rawScope.clientData != null) prepared.clientData = validateAndNormalizeConditions(rawScope.clientData, 'clientData') as NormalizedCondition[];
  return prepared;
}

/**
 * Prepare an `accesses`-kind scope. Watching access changes is gated on a
 * PERSONAL access (it exposes account-wide access lifecycle, not per-stream
 * data) rather than per-stream read permission — so the events.get per-stream
 * pipeline is NOT reused for authorization. The optional `streams` filter (used
 * to match an access's permission streamIds) is expanded only when provided
 * (no `*` default); `types` and `accessIds` pass through. At least one
 * dimension is required.
 */
async function prepareAccessScopeQuery (context: MethodContext, rawScope: RawScopeQuery & { accessIds?: string[] }): Promise<EventMatchQuery> {
  if (!context.access?.isPersonal?.()) {
    throw errors.forbidden('Watching access changes requires a personal access.');
  }
  const hasStreams = rawScope.streams != null;
  const hasTypes = Array.isArray(rawScope.types) && rawScope.types.length > 0;
  const hasAccessIds = Array.isArray(rawScope.accessIds) && rawScope.accessIds.length > 0;
  if (!hasStreams && !hasTypes && !hasAccessIds) {
    throw errors.invalidRequestStructure('An accesses scope requires at least one of: streams, types, accessIds.');
  }
  const prepared: EventMatchQuery = {};
  if (hasStreams) {
    const streamsPrepared = await prepareScopeQuery(context, { streams: rawScope.streams, state: rawScope.state });
    prepared.streams = streamsPrepared.streams;
  }
  if (hasTypes) prepared.types = rawScope.types;
  if (hasAccessIds) prepared.accessIds = rawScope.accessIds;
  return prepared;
}

export { prepareScopeQuery, prepareAccessScopeQuery };
export type { RawScopeQuery };
