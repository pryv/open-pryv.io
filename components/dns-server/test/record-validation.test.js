/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('assert');
const { validateDnsRecord } = require('../src/recordValidation.ts');

function ipv4List (n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push('10.0.' + Math.floor(i / 250) + '.' + ((i % 250) + 1));
  return out;
}

function ipv6List (n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push('2001:db8::' + (i + 1).toString(16));
  return out;
}

function txtList (n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push('value-' + i);
  return out;
}

describe('[DNRV] DNS stored record validation: number of values', function () {
  it('[DNRV1] 32 values for one key are accepted (a, aaaa, txt)', () => {
    assert.deepStrictEqual(validateDnsRecord('many', { a: ipv4List(32) }), []);
    assert.deepStrictEqual(validateDnsRecord('many', { aaaa: ipv6List(32) }), []);
    assert.deepStrictEqual(validateDnsRecord('many', { txt: txtList(32) }), []);
  });

  it('[DNRV2] more than 32 values for one key are refused (a, aaaa, txt)', () => {
    for (const records of [{ a: ipv4List(33) }, { aaaa: ipv6List(33) }, { txt: txtList(33) }]) {
      const problems = validateDnsRecord('many', records);
      assert.ok(problems.length > 0, 'expected a refusal for ' + Object.keys(records)[0]);
      assert.ok(problems.some((p) => /at most 32 values/.test(p)), JSON.stringify(problems));
    }
  });

  it('[DNRV3] the values of all keys together are capped at 64 per subdomain', () => {
    assert.deepStrictEqual(validateDnsRecord('many', { a: ipv4List(32), aaaa: ipv6List(32) }), []);
    const problems = validateDnsRecord('many', { a: ipv4List(32), aaaa: ipv6List(32), txt: txtList(1) });
    assert.ok(problems.some((p) => /at most 64 values/.test(p)), JSON.stringify(problems));
  });

  it('[DNRV4] a refused oversized list reports one problem, not one per value', () => {
    const problems = validateDnsRecord('many', { a: new Array(5000).fill('not-an-address') });
    assert.ok(problems.some((p) => /at most 32 values/.test(p)), JSON.stringify(problems.slice(0, 3)));
    assert.ok(problems.length <= 3, 'problems: ' + problems.length);
  });

  it('[DNRV5] single-value records stay valid', () => {
    assert.deepStrictEqual(validateDnsRecord('www', { a: '10.0.0.1' }), []);
    assert.deepStrictEqual(validateDnsRecord('www', { txt: 'hello' }), []);
    assert.deepStrictEqual(validateDnsRecord('www', { cname: 'core1.example.com' }), []);
  });
});
