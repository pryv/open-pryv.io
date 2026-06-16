/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * In-memory event matching — the canonical predicates an event must satisfy
 * to be returned by an `events.get` query, evaluated against an event object
 * already held in memory (no DB round-trip).
 *
 * This module owns the `content` / `clientData` JSON-condition matcher, the
 * JSON-path primitives, and the `NormalizedCondition` contract (strict JSON
 * types: `true` never equals `1` nor `"true"`). It is the single source of
 * truth those semantics, shared by the account store, conformance tests, and
 * scope-matching. `storages/shared/contentQueryConditions` builds on these for
 * API-param validation + per-engine SQL translation; storage engines reproduce
 * the same semantics in SQL.
 */

type ScalarValue = string | number | boolean;
type ConditionOp = 'eq' | 'neq' | 'in' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte' | 'prefix';
type NormalizedCondition = {
  field: 'content' | 'clientData';
  /** Path segments into the JSON document; `null` addresses the root value (`$`). */
  path: string[] | null;
  op: ConditionOp;
  value: ScalarValue | ScalarValue[];
};

/** One stream condition: at least one of `any` present, none of `not` present. */
type StreamCondition = { any?: string[]; not?: string[] };
/** A normalized stream-query group (single condition or AND-ed array). */
type StreamGroup = StreamCondition | StreamCondition[];

/** Minimal event shape the matcher inspects. */
type EventToMatch = {
  streamIds: string[];
  type: string;
  content?: unknown;
  clientData?: unknown;
};
/**
 * The standing-filter subset of an `events.get` query the matcher evaluates.
 * Time window / pagination / `state` are the caller's concern, not part of it.
 */
type EventMatchQuery = {
  streams?: StreamGroup[];
  types?: string[];
  content?: NormalizedCondition[];
  clientData?: NormalizedCondition[];
};

const ROOT_PATH = '$';
const SEGMENT_REGEXP = /^[a-zA-Z0-9_:-]+$/;

export {
  ROOT_PATH, SEGMENT_REGEXP, parseJsonPath, resolveJsonPath,
  matchesConditions, matchesStreamQuery, eventMatchesQuery
};
export type { NormalizedCondition, ScalarValue, ConditionOp, StreamCondition, StreamGroup, EventToMatch, EventMatchQuery };

/**
 * Parse a raw path string per the content-query path grammar.
 * Returns `null` for the reserved root path (`$`), the segments array
 * otherwise. Throws on any invalid segment.
 */
function parseJsonPath (rawPath: string): string[] | null {
  if (rawPath === ROOT_PATH) return null;
  const segments = rawPath.split('.');
  for (const segment of segments) {
    if (!SEGMENT_REGEXP.test(segment)) {
      throw new Error(`Invalid path '${rawPath}': segment '${segment}' does not match ${SEGMENT_REGEXP}.`);
    }
  }
  return segments;
}

/**
 * Resolve a normalized path against a JSON value.
 * Returns `undefined` when the path does not lead to a value
 * (`null` is a present value and is returned as such).
 */
function resolveJsonPath (root: unknown, path: string[] | null): unknown {
  if (root === undefined) return undefined;
  if (path === null) return root;
  let current: unknown = root;
  for (const segment of path) {
    if (current == null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Reference matcher — defines the matching semantics (strict JSON types).
 * `fields` are the event's raw `content` / `clientData` values
 * (`undefined` when the event has none).
 */
function matchesConditions (
  fields: { content?: unknown, clientData?: unknown },
  conditions: NormalizedCondition[]
): boolean {
  for (const condition of conditions) {
    if (!matchesCondition(fields[condition.field], condition)) return false;
  }
  return true;
}

function matchesCondition (fieldValue: unknown, condition: NormalizedCondition): boolean {
  const value = resolveJsonPath(fieldValue, condition.path);
  switch (condition.op) {
    case 'exists':
      return condition.value === true ? value !== undefined : value === undefined;
    case 'eq':
      return strictEquals(value, condition.value as ScalarValue);
    case 'neq':
      return value !== undefined && !strictEquals(value, condition.value as ScalarValue);
    case 'in':
      return (condition.value as ScalarValue[]).some((v) => strictEquals(value, v));
    case 'gt':
      return typeof value === 'number' && value > (condition.value as number);
    case 'gte':
      return typeof value === 'number' && value >= (condition.value as number);
    case 'lt':
      return typeof value === 'number' && value < (condition.value as number);
    case 'lte':
      return typeof value === 'number' && value <= (condition.value as number);
    case 'prefix':
      return typeof value === 'string' && value.startsWith(condition.value as string);
    default:
      return false;
  }
}

function strictEquals (value: unknown, expected: ScalarValue): boolean {
  return typeof value === typeof expected && value === expected;
}

/**
 * Check whether an event's streamIds satisfy a normalized stream query.
 * Groups are OR-ed; within a group, conditions are AND-ed; a `{ any }`
 * condition needs at least one match, a `{ not }` condition needs none.
 */
function matchesStreamQuery (eventStreamIds: string[], streamGroups: StreamGroup[]): boolean {
  const sids = new Set(eventStreamIds);
  for (const group of streamGroups) { // OR between groups
    if (matchesGroup(sids, group)) return true;
  }
  return false;
}

function matchesGroup (sids: Set<string>, group: StreamGroup): boolean {
  // Accept both the normalized array form and a single-condition object.
  const conditions: StreamCondition[] = Array.isArray(group) ? group : [group];
  for (const cond of conditions) {
    if (cond.any && !cond.any.some((sid) => sids.has(sid))) return false;
    if (cond.not && cond.not.some((sid) => sids.has(sid))) return false;
  }
  return true;
}

/**
 * The composed predicate: does this in-memory event satisfy the standing
 * `events.get`-shaped filter (streams + types + content/clientData)? All
 * present dimensions must hold (AND). Empty/absent dimensions are skipped.
 * Time window, `state` and `modifiedSince` are NOT evaluated here — they are
 * not part of a standing filter and are the caller's responsibility.
 */
function eventMatchesQuery (event: EventToMatch, query: EventMatchQuery): boolean {
  if (query.streams && query.streams.length > 0) {
    if (!matchesStreamQuery(event.streamIds, query.streams)) return false;
  }
  if (query.types && query.types.length > 0) {
    if (!query.types.includes(event.type)) return false;
  }
  if ((query.content != null && query.content.length > 0) ||
      (query.clientData != null && query.clientData.length > 0)) {
    const conditions = [...(query.content ?? []), ...(query.clientData ?? [])];
    if (!matchesConditions({ content: event.content, clientData: event.clientData }, conditions)) return false;
  }
  return true;
}
