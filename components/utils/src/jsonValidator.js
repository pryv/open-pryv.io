/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * JSON-schema validator façade. Backed by `ajv` (v8, draft-04 build) under the
 * hood; emulates the slice of the legacy `z-schema` API that callers rely on:
 *
 *   - validate(data, schema, callback?) — async with `cb(errArrayOrNull)`,
 *     OR sync (no callback) returning a boolean. Errors retrievable via
 *     `getLastErrors()` / `getLastError()` / `lastReport`.
 *   - validateSchema(schema) — compile-test the schema; returns boolean.
 *
 * Errors are reshaped to z-schema's wire shape so existing consumers
 * (`commonFunctions._addCustomMessage`, schema files'
 * `messages: { PATTERN: …, OBJECT_MISSING_REQUIRED_PROPERTY: … }` blocks,
 * tests asserting on `error.code`) keep working unmodified.
 *
 * Per-schema fresh ajv instance (Pryv schemas build fresh schema objects per
 * request — a shared registry would error with "reference resolves to more
 * than one schema" on the second compile of e.g. `accessesMethods.checkApp`).
 */

const Ajv = require('ajv-draft-04');
const addFormats = require('ajv-formats');

const KEYWORD_TO_ZSCHEMA_CODE = {
  pattern: 'PATTERN',
  required: 'OBJECT_MISSING_REQUIRED_PROPERTY',
  type: 'INVALID_TYPE',
  minLength: 'MIN_LENGTH',
  maxLength: 'MAX_LENGTH',
  enum: 'ENUM_MISMATCH',
  format: 'FORMAT',
  minimum: 'MINIMUM',
  maximum: 'MAXIMUM',
  exclusiveMinimum: 'MINIMUM_EXCLUSIVE',
  exclusiveMaximum: 'MAXIMUM_EXCLUSIVE',
  minItems: 'ARRAY_LENGTH_SHORT',
  maxItems: 'ARRAY_LENGTH_LONG',
  uniqueItems: 'ARRAY_UNIQUE',
  additionalProperties: 'OBJECT_ADDITIONAL_PROPERTIES',
  oneOf: 'ONE_OF_MISSING',
  anyOf: 'ANY_OF_MISSING',
  not: 'NOT_PASSED',
  multipleOf: 'MULTIPLE_OF',
  const: 'VALUE_NOT_EQUAL'
};

function paramsToArray (params, keyword) {
  if (params == null) return [];
  switch (keyword) {
    case 'required': return [params.missingProperty];
    case 'pattern': return [params.pattern];
    case 'type': return [params.type];
    case 'enum': return [params.allowedValues];
    case 'minLength':
    case 'maxLength':
    case 'minItems':
    case 'maxItems':
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
    case 'multipleOf':
      return [params.limit];
    case 'additionalProperties': return [params.additionalProperty];
    case 'const': return [params.allowedValue];
    default: return Object.values(params);
  }
}

function translateError (e) {
  const code = KEYWORD_TO_ZSCHEMA_CODE[e.keyword] || (e.keyword || 'UNKNOWN').toUpperCase();
  // z-schema reported `required` errors with a trailing `/` and no field
  // name (e.g. `#/` for root-level missing-required), expecting the consumer
  // (`commonFunctions._addCustomMessage`) to fall back to `params[0]` for
  // the paramId. Mirror that exactly — ajv's instancePath is always the
  // parent's path, so just append a `/` for `required`.
  let path = '#' + (e.instancePath || '');
  if (e.keyword === 'required' && !path.endsWith('/')) {
    path = path + '/';
  }
  return {
    code,
    params: paramsToArray(e.params, e.keyword),
    message: e.message,
    path
  };
}

/**
 * Walk a schema, collect every $ref string used. Strip schema-level `id`
 * keys whose values aren't $ref-targeted from anywhere in the tree (z-schema
 * tolerated cosmetic ids; ajv treats every id as a registered subschema and
 * rejects duplicates within one compile when e.g. `accessesMethods.checkApp`
 * embeds `access(Action.READ)` in two sibling properties). Top-level id is
 * always preserved so self-references (`systemStreamsSchema → $ref:
 * 'systemStreamsSchema'`) keep resolving.
 */
function stripUnreferencedIds (schema) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const referenced = new Set();
  collectRefs(schema, referenced);
  return cloneStrip(schema, referenced, true);
}

function collectRefs (node, out) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return;
  }
  if (typeof node.$ref === 'string') {
    out.add(node.$ref);
    // Fragment refs like `#error` may target a sub-schema's `id: 'error'`
    // (draft-04 style). Add the bare-id form so stripping doesn't drop it.
    if (node.$ref.startsWith('#') && !node.$ref.startsWith('#/')) {
      out.add(node.$ref.slice(1));
    }
  }
  for (const key of Object.keys(node)) collectRefs(node[key], out);
}

function cloneStrip (node, referenced, isTop) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => cloneStrip(item, referenced, false));
  const result = {};
  for (const key of Object.keys(node)) {
    if ((key === 'id' || key === '$id') && !isTop && typeof node[key] === 'string') {
      // Schema-level id (string value sitting next to type/properties/etc).
      // Keep only if some $ref targets it.
      if (referenced.has(node[key])) {
        result[key] = node[key];
      }
      continue;
    }
    // `id`/`$id` with a non-string value is a property definition (the schema
    // declares a data property called "id"). Recurse normally.
    result[key] = cloneStrip(node[key], referenced, false);
  }
  return result;
}

function createValidator (options = {}) {
  const ajvOptions = {
    allErrors: !options.breakOnFirstError,
    strict: false,
    coerceTypes: false,
    validateFormats: true,
    ...(options.ajv || {})
  };

  const compileCache = new WeakMap();
  let lastErrors = null;

  function compile (schema) {
    let fn = compileCache.get(schema);
    if (fn != null) return fn;
    // Per-schema fresh ajv. addUsedSchema:true (default) keeps self-refs
    // resolvable; the per-instance scope guarantees no cross-compile id
    // collisions between separate validator() callers.
    const ajv = new Ajv(ajvOptions);
    addFormats(ajv);
    fn = ajv.compile(stripUnreferencedIds(schema));
    compileCache.set(schema, fn);
    return fn;
  }

  function validate (data, schema, callback) {
    const fn = compile(schema);
    const valid = fn(data);
    lastErrors = valid ? null : (fn.errors || []).map(translateError);
    if (typeof callback === 'function') {
      // z-schema invokes the callback synchronously when it has the answer.
      callback(lastErrors);
      return;
    }
    return valid;
  }

  function validateSchema (schema) {
    try {
      const ajv = new Ajv(ajvOptions);
      addFormats(ajv);
      ajv.compile(stripUnreferencedIds(schema));
      lastErrors = null;
      return true;
    } catch (err) {
      lastErrors = [{
        code: 'SCHEMA_INVALID',
        params: [],
        message: err.message,
        path: '#'
      }];
      return false;
    }
  }

  return {
    validate,
    validateSchema,
    getLastError: () => lastErrors,
    getLastErrors: () => lastErrors,
    get lastReport () { return lastErrors; }
  };
}

module.exports = createValidator;
module.exports.createValidator = createValidator;
