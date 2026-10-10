/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('assert');
const { validateDnsRecord, normalizeStoredRecord, isEncodableAnswer } = require('../src/recordValidation.ts');
const { buildTXT } = require('../src/records.ts');
const { Packet } = require('dns2');

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

// Walk the RDATA of an encoded TXT record: a 16-bit length, then
// length-prefixed character-strings.
function txtCharacterStrings (rdata) {
  const rdlength = rdata.readUInt16BE(0);
  assert.strictEqual(rdata.length, 2 + rdlength, 'RDATA length matches its prefix');
  const strings = [];
  let offset = 2;
  while (offset < rdata.length) {
    const len = rdata[offset];
    strings.push(rdata.subarray(offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  assert.strictEqual(offset, rdata.length, 'character-strings end exactly at the end of the RDATA');
  return strings;
}

describe('[DNTX] DNS TXT values over 255 bytes', function () {
  it('[DNTX1] a multibyte character at the 255-byte boundary: every character-string is <= 255 bytes and the bytes round-trip', () => {
    // 254 ASCII bytes, then a 2-byte character straddling the boundary, then more.
    const value = 'a'.repeat(254) + 'é' + 'b'.repeat(300) + '€'.repeat(100);
    const expected = Buffer.from(value, 'utf8');
    assert.deepStrictEqual(validateDnsRecord('long', { txt: [value] }), []);

    const answer = buildTXT('long.test.pryv.me', value, 60);
    assert.strictEqual(isEncodableAnswer(answer), true);
    for (const chunk of answer.data) assert.ok(chunk.length <= 255, 'chunk of ' + chunk.length + ' bytes');

    const strings = txtCharacterStrings(Packet.Resource.TXT.encode(answer));
    assert.ok(strings.length >= 2);
    for (const s of strings) assert.ok(s.length <= 255, 'encoded character-string of ' + s.length + ' bytes');
    assert.ok(Buffer.concat(strings).equals(expected), 'the encoded bytes are the value bytes');
  });

  it('[DNTX2] a short value is one character-string with the value bytes', () => {
    const answer = buildTXT('short.test.pryv.me', 'v=spf1 ~all', 60);
    const strings = txtCharacterStrings(Packet.Resource.TXT.encode(answer));
    assert.strictEqual(strings.length, 1);
    assert.strictEqual(strings[0].toString('utf8'), 'v=spf1 ~all');
  });

  it('[DNTX3] a TXT answer holding a character-string over 255 bytes is not encodable', () => {
    assert.strictEqual(isEncodableAnswer({ type: Packet.TYPE.TXT, data: ['x'.repeat(256)] }), false);
    assert.strictEqual(isEncodableAnswer({ type: Packet.TYPE.TXT, data: [Buffer.alloc(256)] }), false);
    assert.strictEqual(isEncodableAnswer({ type: Packet.TYPE.TXT, data: [Buffer.alloc(255), 'ok'] }), true);
  });
});

describe('[DNNM] DNS stored record normalisation', function () {
  it('[DNNM1] the subdomain and CNAME target are lowercased and lose one trailing dot', () => {
    const out = normalizeStoredRecord('Www.', { cname: 'Host.Example.com.' });
    assert.deepStrictEqual(out, { subdomain: 'www', records: { cname: 'host.example.com' } });
    assert.deepStrictEqual(validateDnsRecord(out.subdomain, out.records), []);
  });

  it('[DNNM2] other values and non-string input are left unchanged', () => {
    const records = { a: ['10.0.0.1'], txt: ['Mixed Case.'] };
    assert.deepStrictEqual(normalizeStoredRecord('api', records), { subdomain: 'api', records });
    assert.deepStrictEqual(normalizeStoredRecord(42, null), { subdomain: 42, records: null });
    // Only one trailing dot is stripped; the result is still refused.
    const twoDots = normalizeStoredRecord('www..', { a: ['10.0.0.1'] });
    assert.ok(validateDnsRecord(twoDots.subdomain, twoDots.records).length > 0);
  });
});
