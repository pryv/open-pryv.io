/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Content-query conditions on events' `content` / `clientData` JSON.
 *
 * This module owns the API-facing surface:
 * - validation + normalization of raw API conditions (`events.get` params
 *   `content` and `clientData`),
 * - the per-store capability announcement + support check.
 *
 * The in-memory reference matcher, the JSON-path primitives, and the
 * `NormalizedCondition` contract now live in
 * `components/utils/src/eventMatchQuery` (so they can be reused without a
 * `utils -> storages` dependency). They are imported and re-exported here for
 * backwards compatibility, so existing consumers keep importing them from this
 * module unchanged.
 *
 * Engines translate normalized conditions to SQL; the account store and
 * conformance tests evaluate them with `matchesConditions()`.
 */

import { createRequire } from 'node:module';
import type { NormalizedCondition, ScalarValue, ConditionOp } from 'utils';
const require = createRequire(import.meta.url);
const { ROOT_PATH, parseJsonPath, resolveJsonPath, matchesConditions } = require('utils').eventMatchQuery;

const MAX_CONDITIONS = 10;
const MAX_VALUES_PER_IN = 100;
const OPERATORS: ConditionOp[] = ['eq', 'neq', 'in', 'exists', 'gt', 'gte', 'lt', 'lte', 'prefix'];
const NUMERIC_OPS = new Set<ConditionOp>(['gt', 'gte', 'lt', 'lte']);

/**
 * Capability announcement of the built-in storage (full operator set on
 * both fields). Custom datastores announce their own (possibly partial)
 * object via `DataStore.supports`.
 */
const CONTENT_QUERY_SUPPORT = Object.freeze({
  contentQueries: Object.freeze({
    fields: Object.freeze(['content', 'clientData']),
    operators: Object.freeze([...OPERATORS])
  })
});

type StoreSupports = { contentQueries?: { fields?: readonly string[], operators?: readonly string[] } } | null | undefined;

export {
  MAX_CONDITIONS, MAX_VALUES_PER_IN, ROOT_PATH, OPERATORS, CONTENT_QUERY_SUPPORT,
  validateAndNormalizeConditions, matchesConditions, resolveJsonPath, parseJsonPath,
  getConditionsSupportError
};
export type { NormalizedCondition, ScalarValue, ConditionOp, StoreSupports };

/**
 * Check normalized conditions against a store's capability announcement.
 * Returns a human-readable detail when something is unsupported, `null`
 * when the store can serve all conditions.
 */
function getConditionsSupportError (supports: StoreSupports, conditions: NormalizedCondition[]): string | null {
  const capability = supports?.contentQueries;
  if (capability == null) return 'content/clientData query conditions are not supported';
  for (const condition of conditions) {
    if (!(capability.fields ?? []).includes(condition.field)) {
      return `'${condition.field}' conditions are not supported`;
    }
    if (!(capability.operators ?? []).includes(condition.op)) {
      return `operator '${condition.op}' is not supported`;
    }
  }
  return null;
}

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
