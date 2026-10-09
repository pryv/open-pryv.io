/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('assert');
const { validateRequest, parseName, RCODE_FORMERR, RCODE_NOTIMP, RCODE_REFUSED } = require('../src/wire.ts');

// --- buffer construction helpers -------------------------------------------

function header ({ id = 1, qr = 0, opcode = 0, rd = 1, qd = 1, an = 0, ns = 0, ar = 0 } = {}) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(id, 0);
  let flags = 0;
  flags |= (qr & 1) << 15;
  flags |= (opcode & 0xf) << 11;
  flags |= (rd & 1) << 8;
  b.writeUInt16BE(flags >>> 0, 2);
  b.writeUInt16BE(qd, 4);
  b.writeUInt16BE(an, 6);
  b.writeUInt16BE(ns, 8);
  b.writeUInt16BE(ar, 10);
  return b;
}

function encodeName (labels) {
  const parts = [];
  for (const l of labels) {
    const lb = Buffer.from(l, 'latin1');
    parts.push(Buffer.from([lb.length]), lb);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function question (labels, type = 1, cls = 1) {
  const tc = Buffer.alloc(4);
  tc.writeUInt16BE(type, 0);
  tc.writeUInt16BE(cls, 2);
  return Buffer.concat([encodeName(labels), tc]);
}

function message (opts, qbuf) {
  return Buffer.concat([header(opts), qbuf]);
}

const NAME = ['alice', 'test', 'pryv', 'me'];

describe('[DNW] DNS request validation (wire)', function () {
  this.timeout(2000);

  it('[DNW01] a conformant single-question query parses as ok', () => {
    const res = validateRequest(message({}, question(NAME, 1, 1)));
    assert.strictEqual(res.kind, 'ok');
    assert.strictEqual(res.name, 'alice.test.pryv.me');
    assert.strictEqual(res.type, 1);
    assert.strictEqual(res.qclass, 1);
    assert.ok(Buffer.isBuffer(res.rawQuestion));
  });

  it('[DNW02] a message shorter than the 12-octet header is ignored', () => {
    assert.strictEqual(validateRequest(Buffer.alloc(11)).kind, 'ignore');
  });

  it('[DNW03] a message beyond the EDNS-less size ceiling is ignored', () => {
    const big = Buffer.concat([message({}, question(NAME)), Buffer.alloc(1300)]);
    assert.strictEqual(validateRequest(big).kind, 'ignore');
  });

  it('[DNW04] a message that is itself a response (QR=1) is ignored', () => {
    const res = validateRequest(message({ qr: 1 }, question(NAME)));
    assert.strictEqual(res.kind, 'ignore');
    assert.strictEqual(res.reason, 'response');
  });

  it('[DNW05] an opcode other than QUERY returns NOTIMP (header-only)', () => {
    const res = validateRequest(message({ opcode: 4 }, question(NAME)));
    assert.strictEqual(res.kind, 'error');
    assert.strictEqual(res.rcode, RCODE_NOTIMP);
  });

  it('[DNW06] qdcount other than 1 returns FORMERR', () => {
    const zero = validateRequest(message({ qd: 0 }, Buffer.alloc(0)));
    assert.strictEqual(zero.kind, 'error');
    assert.strictEqual(zero.rcode, RCODE_FORMERR);
    const two = validateRequest(message({ qd: 2 }, question(NAME)));
    assert.strictEqual(two.kind, 'error');
    assert.strictEqual(two.rcode, RCODE_FORMERR);
  });

  it('[DNW07] arcount above 1 returns FORMERR', () => {
    const res = validateRequest(message({ ar: 2 }, question(NAME)));
    assert.strictEqual(res.kind, 'error');
    assert.strictEqual(res.rcode, RCODE_FORMERR);
  });

  it('[DNW08] a reserved label type (0x40 / 0x80) returns FORMERR', () => {
    // A length octet over 63 sets a reserved label-type bit; both forms are refused.
    for (const lead of [0x41, 0x80]) {
      const qbuf = Buffer.concat([Buffer.from([lead]), Buffer.alloc(6)]);
      const res = validateRequest(message({}, qbuf));
      assert.strictEqual(res.kind, 'error', 'lead ' + lead);
      assert.strictEqual(res.rcode, RCODE_FORMERR, 'lead ' + lead);
    }
  });

  it('[DNW09] a name longer than 255 octets returns FORMERR', () => {
    const big = 'a'.repeat(63);
    const res = validateRequest(message({}, question([big, big, big, big])));
    assert.strictEqual(res.kind, 'error');
    assert.strictEqual(res.rcode, RCODE_FORMERR);
  });

  it('[DNW10] a self-targeting compression pointer returns FORMERR and parses promptly', () => {
    const t0 = Date.now();
    const qbuf = Buffer.concat([Buffer.from([0xc0, 0x0c]), Buffer.alloc(4)]);
    const res = validateRequest(message({}, qbuf));
    assert.strictEqual(res.kind, 'error');
    assert.strictEqual(res.rcode, RCODE_FORMERR);
    assert.ok(Date.now() - t0 < 100, 'returned promptly');
  });

  it('[DNW11] a forward compression pointer returns FORMERR', () => {
    const qbuf = Buffer.concat([Buffer.from([0xc0, 0x20]), Buffer.alloc(4)]);
    const res = validateRequest(message({}, qbuf));
    assert.strictEqual(res.kind, 'error');
    assert.strictEqual(res.rcode, RCODE_FORMERR);
  });

  it('[DNW12] a class other than IN returns REFUSED (question echoed)', () => {
    const res = validateRequest(message({}, question(NAME, 1, 3)));
    assert.strictEqual(res.kind, 'refused');
    assert.strictEqual(res.reason, 'class');
    assert.ok(Buffer.isBuffer(res.rawQuestion));
  });

  it('[DNW13] a label containing a dot octet returns REFUSED', () => {
    const res = validateRequest(message({}, question(['a.b'], 1, 1)));
    assert.strictEqual(res.kind, 'refused');
    assert.strictEqual(res.reason, 'dot-in-label');
  });

  it('[DNW14] records in the query (ancount) are neither parsed nor rejected', () => {
    // A query carrying answer records still classifies as a normal query.
    const res = validateRequest(message({ an: 1 }, question(NAME)));
    assert.strictEqual(res.kind, 'ok');
  });

  it('[DNW15] name parsing terminates: a backward pointer chain within the hop cap resolves', () => {
    const buf = Buffer.alloc(80);
    buf[12] = 0; // terminator the chain lands on
    for (let o = 40; o >= 14; o -= 2) { buf[o] = 0xc0; buf[o + 1] = o - 2; }
    const t0 = Date.now();
    const res = parseName(buf, 40);
    assert.strictEqual(res.ok, true);
    assert.ok(Date.now() - t0 < 100, 'returned promptly');
  });

  it('[DNW16] name parsing refuses a pointer chain exceeding the hop cap', () => {
    const buf = Buffer.alloc(80);
    buf[12] = 0;
    for (let o = 46; o >= 14; o -= 2) { buf[o] = 0xc0; buf[o + 1] = o - 2; }
    const res = parseName(buf, 46); // 17 hops > 16
    assert.strictEqual(res.ok, false);
  });

  it('[DNW17] the REFUSED rcode constant matches RFC 1035', () => {
    assert.strictEqual(RCODE_REFUSED, 5);
  });
});
