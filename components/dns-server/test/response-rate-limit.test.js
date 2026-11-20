/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('assert');
const dgram = require('dgram');
const dns2 = require('dns2');
const { Packet } = dns2;
const { ResponseRateLimiter, networkOf, readRrlConfig, RRL_DEFAULTS } = require('../src/responseRateLimit.ts');
const { createDnsServer } = require('../src/index.ts');

/**
 * [DRRL] UDP response rate limit of the embedded DNS (dns.responseRateLimit):
 * answers per client network (/24, /56) and second, refused ones dropped except
 * every slip-th, sent truncated.
 */

describe('[DRRL] DNS response rate limit', function () {
  it('[DRRL1] client networks: /24 for IPv4 (IPv4-mapped included), /56 for IPv6', function () {
    assert.strictEqual(networkOf('192.0.2.17'), networkOf('192.0.2.200'));
    assert.notStrictEqual(networkOf('192.0.2.17'), networkOf('192.0.3.17'));
    assert.strictEqual(networkOf('::ffff:192.0.2.17'), networkOf('192.0.2.99'));
    assert.strictEqual(networkOf('2001:db8:1:2a00::1'), networkOf('2001:db8:1:2aff:ffff::9'));
    assert.notStrictEqual(networkOf('2001:db8:1:2a00::1'), networkOf('2001:db8:1:2b00::1'));
    assert.strictEqual(networkOf('2001:db8::1'), networkOf('2001:0db8:0000:0000:0000::2'));
    assert.strictEqual(networkOf('fe80::1%lo0'), networkOf('fe80::2'));
  });

  it('[DRRL2] past perSecond the answers of a network are dropped, every slip-th sent truncated; the next second starts over; other networks are not affected', function () {
    const rrl = new ResponseRateLimiter({ perSecond: 3, slip: 2 });
    const t = 10_000;
    const decisions = Array.from({ length: 7 }, () => rrl.decide('198.51.100.1', t));
    assert.deepStrictEqual(decisions, ['answer', 'answer', 'answer', 'drop', 'slip', 'drop', 'slip']);
    assert.strictEqual(rrl.decide('198.51.101.1', t), 'answer', 'another network');
    assert.strictEqual(rrl.decide('198.51.100.9', t + 1000), 'answer', 'next second');
    const noSlip = new ResponseRateLimiter({ perSecond: 1, slip: 0 });
    assert.deepStrictEqual([0, 1, 2].map(() => noSlip.decide('203.0.113.5', t)), ['answer', 'drop', 'drop']);
    const off = new ResponseRateLimiter({ perSecond: 0, slip: 2 });
    for (let i = 0; i < 100; i++) assert.strictEqual(off.decide('203.0.113.5', t), 'answer');
  });

  it('[DRRL3] the networks tracked stay bounded', function () {
    const rrl = new ResponseRateLimiter({ perSecond: 1, slip: 2, maxNetworks: 100 });
    for (let i = 0; i < 1000; i++) rrl.decide(`10.${i >> 8}.${i & 0xff}.1`, 5000 + i * 1000);
    assert.ok(rrl.size <= 100, String(rrl.size));
    for (let i = 0; i < 1000; i++) rrl.decide(`10.${i >> 8}.${i & 0xff}.1`, 9_999_000);
    assert.ok(rrl.size <= 100, 'same second: cleared when nothing is stale: ' + rrl.size);
  });

  it('[DRRL4] defaults: 20 answers a second, slip 2', function () {
    assert.deepStrictEqual(readRrlConfig(() => undefined), { ...RRL_DEFAULTS });
    assert.deepStrictEqual({ ...RRL_DEFAULTS }, { perSecond: 20, slip: 2 });
  });

  it('[DRRL5] the server answers a burst from one address up to the limit, then truncated or nothing, and looks no name up for a refused one', async function () {
    let lookups = 0;
    const platform = {
      async getUserCore () { lookups++; return null; },
      async getCoreInfo () { return null; },
      async getAllCoreInfos () { return []; }
    };
    const store = { 'dns:domain': 'rrl.test', 'dns:defaultTTL': 60, 'dns:staticEntries': {}, 'dns:records:root': {} };
    const logger = { info () {}, warn () {}, error () {}, debug () {} };
    const server = createDnsServer({ config: { get: (k) => store[k] }, platform, logger, platformRefreshIntervalMs: 0, responseRateLimit: { perSecond: 4, slip: 2 } });
    await server.start({ port: 0, ip: '127.0.0.1' });
    const { port } = server._getAddresses().udp;
    const client = dgram.createSocket('udp4');
    const replies = [];
    client.on('message', (msg) => replies.push(Packet.parse(msg)));
    try {
      for (let i = 0; i < 12; i++) {
        const q = new Packet();
        q.header.id = 100 + i;
        q.questions.push({ name: `random${i}.rrl.test`, type: Packet.TYPE.A, class: Packet.CLASS.IN });
        client.send(q.toBuffer(), port, '127.0.0.1');
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      client.close();
      await server.stop();
    }
    const full = replies.filter((r) => r.header.tc === 0);
    const truncated = replies.filter((r) => r.header.tc === 1);
    // All 12 can only fit in one second if the run did not cross a second
    // boundary; either way at most 4 full answers per second were sent.
    assert.ok(full.length >= 4 && full.length <= 8, 'full answers: ' + full.length);
    assert.ok(truncated.length >= 1, 'some refused answers slip through truncated');
    assert.ok(replies.length < 12, 'some are dropped: ' + replies.length);
    assert.strictEqual(lookups, full.length, 'a refused query costs no lookup');
  });
});
