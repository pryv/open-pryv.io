/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Content-query conditions on events' `content` / `clientData` JSON.
 *
 * This module is the single source of truth for:
 * - validation + normalization of raw API conditions (`events.get` params
 *   `content` and `clientData`),
 * - the in-memory reference matcher implementing the exact matching
 *   semantics every storage engine must reproduce (strict JSON types:
 *   `true` never equals `1` nor `"true"`).
 *
 * Engines translate normalized conditions to SQL; the account store and
 * conformance tests evaluate them with `matchesConditions()`.
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

const MAX_CONDITIONS = 10;
const MAX_VALUES_PER_IN = 100;
const ROOT_PATH = '$';
const SEGMENT_REGEXP = /^[a-zA-Z0-9_:-]+$/;
const OPERATORS: ConditionOp[] = ['eq', 'neq', 'in', 'exists', 'gt', 'gte', 'lt', 'lte', 'prefix'];
const NUMERIC_OPS = new Set<ConditionOp>(['gt', 'gte', 'lt', 'lte']);

export {
  MAX_CONDITIONS, MAX_VALUES_PER_IN, ROOT_PATH, OPERATORS,
  validateAndNormalizeConditions, matchesConditions, resolveJsonPath, parseJsonPath
};
export type { NormalizedCondition, ScalarValue, ConditionOp };

/**
 * Validate raw conditions (already JSON-parsed) for one field parameter.
 * Returns normalized conditions; throws `Error` with a consumer-readable
 * message on any violation (callers wrap into API errors).
 */
function validateAndNormalizeConditions (raw: unknown, field: 'content' | 'clientData'): NormalizedCondition[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid '${field}' parameter: expected an array of conditions.`);
  }
  if (raw.length > MAX_CONDITIONS) {
    throw new Error(`Invalid '${field}' parameter: at most ${MAX_CONDITIONS} conditions are allowed (got ${raw.length}).`);
  }
  return raw.map((rawCondition, i) => normalizeCondition(rawCondition, field, i));
}

function normalizeCondition (rawCondition: unknown, field: 'content' | 'clientData', i: number): NormalizedCondition {
  const fail = (msg: string): never => {
    throw new Error(`Invalid '${field}' parameter: condition #${i + 1} ${msg}`);
  };
  if (rawCondition == null || typeof rawCondition !== 'object' || Array.isArray(rawCondition)) {
    return fail('must be an object with "path" and one operator.');
  }
  const condition = rawCondition as Record<string, unknown>;

  // path
  const rawPath = condition.path;
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return fail('is missing a valid "path" string.');
  }
  let path: string[] | null;
  try {
    path = parseJsonPath(rawPath);
  } catch (e) {
    return fail(`has invalid path '${rawPath}'.`);
  }

  // exactly one operator
  const ops = Object.keys(condition).filter((k) => (OPERATORS as string[]).includes(k));
  if (ops.length !== 1) {
    return fail(`must carry exactly one operator among: ${OPERATORS.join(', ')}.`);
  }
  const unknownKeys = Object.keys(condition).filter((k) => k !== 'path' && !(OPERATORS as string[]).includes(k));
  if (unknownKeys.length > 0) {
    return fail(`has unknown propert${unknownKeys.length > 1 ? 'ies' : 'y'} '${unknownKeys.join("', '")}'.`);
  }
  const op = ops[0] as ConditionOp;
  const rawValue = condition[op];

  // per-operator value validation
  let value: ScalarValue | ScalarValue[];
  switch (op) {
    case 'eq':
    case 'neq':
      if (!isScalarValue(rawValue)) return fail(`'${op}' value must be a string, number or boolean (null is not allowed).`);
      value = rawValue;
      break;
    case 'in': {
      if (!Array.isArray(rawValue) || rawValue.length === 0) return fail("'in' value must be a non-empty array.");
      if (rawValue.length > MAX_VALUES_PER_IN) return fail(`'in' accepts at most ${MAX_VALUES_PER_IN} values (got ${rawValue.length}).`);
      for (const v of rawValue) {
        if (!isScalarValue(v)) return fail("'in' values must be strings, numbers or booleans (null is not allowed).");
      }
      value = rawValue as ScalarValue[];
      break;
    }
    case 'exists':
      if (typeof rawValue !== 'boolean') return fail("'exists' value must be a boolean.");
      value = rawValue;
      break;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) return fail(`'${op}' value must be a finite number.`);
      value = rawValue;
      break;
    case 'prefix':
      if (typeof rawValue !== 'string' || rawValue.length === 0) return fail("'prefix' value must be a non-empty string.");
      value = rawValue;
      break;
    default:
      return fail(`has unsupported operator '${op as string}'.`);
  }

  return { field, path, op, value };
}

function isScalarValue (v: unknown): v is ScalarValue {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' || typeof v === 'boolean';
}

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
