/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [PLCS] the keys the platform store may hold: every key classified
 * `platform` in the effective-configuration rules is in the schema or listed
 * as staying in the files with a reason; schema keys are platform keys with
 * valid names, none inside another, each with a usable schema.
 */

const assert = require('node:assert/strict');
const { RULES, findRule, matchScore } = require('business/src/effectiveConfig/classification.ts');
const { SCHEMA, NOT_IN_STORE, isValidKeyName } = require('business/src/platformConfig/schema.ts');
const { CAPABILITY_NAMES } = require('business/src/admin/capabilities.ts');
const { createValidator } = require('utils/src/jsonValidator.ts');

/**
 * What makes a value schema unbounded or open: a node without a type or an
 * enum, a string without `maxLength`, an array without `maxItems` or `items`,
 * an object without `additionalProperties: false`, a property named
 * `__proto__`, `constructor` or `prototype`. Answers the problems found.
 */
function boundedSchemaProblems (schema, path = '#') {
  const problems = [];
  if (schema == null || typeof schema !== 'object') return [path + ': not a schema'];
  if (Array.isArray(schema.enum)) return problems;
  const types = Array.isArray(schema.type) ? schema.type : (schema.type != null ? [schema.type] : []);
  if (types.length === 0) return [path + ': no type nor enum'];
  if (types.includes('string') && typeof schema.maxLength !== 'number') problems.push(path + ': string without maxLength');
  if (types.includes('array')) {
    if (typeof schema.maxItems !== 'number') problems.push(path + ': array without maxItems');
    if (schema.items == null) problems.push(path + ': array without items');
    else problems.push(...boundedSchemaProblems(schema.items, path + '/items'));
  }
  if (types.includes('object')) {
    if (schema.additionalProperties !== false) problems.push(path + ': object without additionalProperties: false');
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      if (['__proto__', 'constructor', 'prototype'].includes(name)) problems.push(path + ': property ' + name);
      else problems.push(...boundedSchemaProblems(sub, path + '/' + name));
    }
  }
  return problems;
}

describe('[PLCS] platform configuration schema', function () {
  it('[PLCS1] every platform-scoped rule is in the schema or in the not-in-store list with a reason', () => {
    const missing = [];
    for (const rule of RULES.filter((r) => r.scope === 'platform')) {
      const pattern = rule.pattern.join('.');
      if (Object.prototype.hasOwnProperty.call(SCHEMA, pattern)) continue;
      const covering = Object.keys(NOT_IN_STORE).filter((p) => matchScore(p.split('.'), rule.pattern) >= 0);
      if (covering.length === 0) missing.push(pattern);
    }
    assert.deepEqual(missing, [], 'platform keys with neither a schema entry nor a reason in NOT_IN_STORE');
    for (const [pattern, reason] of Object.entries(NOT_IN_STORE)) {
      assert.ok(typeof reason === 'string' && reason.length > 10, 'reason of ' + pattern);
      assert.ok(!Object.prototype.hasOwnProperty.call(SCHEMA, pattern), pattern + ' is both in the schema and not in the store');
    }
  });

  it('[PLCS2] each not-in-store pattern names platform keys (no stale line)', () => {
    const platformRules = RULES.filter((r) => r.scope === 'platform');
    for (const pattern of Object.keys(NOT_IN_STORE)) {
      const covers = platformRules.some((r) => matchScore(pattern.split('.'), r.pattern) >= 0);
      assert.ok(covers, pattern + ' covers no platform rule');
    }
  });

  it('[PLCS3] schema keys: valid names, classified platform, none inside another, valid entries', () => {
    const keys = Object.keys(SCHEMA);
    const capabilities = new Set(CAPABILITY_NAMES);
    const validator = createValidator();
    for (const key of keys) {
      assert.ok(isValidKeyName(key), 'name of ' + key);
      assert.equal(findRule(key.split('.'))?.scope, 'platform', key + ' is classified platform');
      for (const other of keys) assert.ok(other === key || !other.startsWith(key + '.'), other + ' is inside ' + key);
      const def = SCHEMA[key];
      assert.ok(['live', 'restart'].includes(def.appliesAt), 'appliesAt of ' + key);
      assert.equal(typeof def.sensitive, 'boolean', 'sensitive of ' + key);
      assert.ok(capabilities.has(def.capability), 'capability of ' + key);
      assert.equal(validator.validateSchema(def.schema), true, 'schema of ' + key);
    }
  });

  it('[PLCS5] no schema key is a secret, an opaque or redacted value, or under a YAML-only or secret line', () => {
    const closed = Object.entries(NOT_IN_STORE).filter(([, reason]) => reason.startsWith('secret') || reason.startsWith('YAML-only'));
    for (const key of Object.keys(SCHEMA)) {
      const segments = key.split('.');
      assert.equal(findRule(segments)?.class, 'public', key + ' is shown in clear by the effective configuration');
      for (const [pattern, reason] of closed) {
        assert.ok(matchScore(pattern.split('.'), segments) < 0, key + ' is under ' + pattern + ' (' + reason + ')');
      }
    }
  });

  it('[PLCS6] value schemas are bounded and closed', () => {
    for (const [key, def] of Object.entries(SCHEMA)) assert.deepEqual(boundedSchemaProblems(def.schema), [], 'schema of ' + key);
    // the check itself
    assert.deepEqual(boundedSchemaProblems({ type: 'string', maxLength: 80 }), []);
    assert.deepEqual(boundedSchemaProblems({ type: 'integer', minimum: 1, maximum: 9 }), []);
    assert.deepEqual(boundedSchemaProblems({ enum: ['a', 'b'] }), []);
    assert.deepEqual(boundedSchemaProblems({ type: 'array', maxItems: 5, items: { type: 'string', maxLength: 10 } }), []);
    assert.deepEqual(boundedSchemaProblems({ type: 'object', additionalProperties: false, properties: { a: { type: 'boolean' } } }), []);
    assert.equal(boundedSchemaProblems({ type: 'string' }).length, 1, 'string without maxLength');
    assert.equal(boundedSchemaProblems({ type: 'array', items: { type: 'string', maxLength: 3 } }).length, 1, 'array without maxItems');
    assert.equal(boundedSchemaProblems({ type: 'array', maxItems: 3 }).length, 1, 'array without items');
    assert.equal(boundedSchemaProblems({ type: 'object', properties: {} }).length, 1, 'open object');
    assert.equal(boundedSchemaProblems({ type: 'object', additionalProperties: false, properties: { constructor: { type: 'boolean' } } }).length, 1);
    assert.equal(boundedSchemaProblems({}).length, 1, 'no type');
    assert.equal(boundedSchemaProblems({ type: ['string', 'object'], maxLength: 3 }).length, 1, 'an object branch must be closed too');
  });

  it('[PLCS4] key names: dots, letters, digits and dashes only', () => {
    for (const ok of ['service.name', 'user-account.delete', 'a', 'oauth.clientRegistration.mode']) assert.equal(isValidKeyName(ok), true, ok);
    for (const bad of ['', 'a..b', '.a', 'a.', 'a_b', 'a%b', 'a:b', 'a/b', '1a', 'a.1b', 'x'.repeat(201), null, 3]) assert.equal(isValidKeyName(bad), false, String(bad));
  });
});
