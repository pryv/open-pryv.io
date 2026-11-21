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
const { ResponseRateLimiter, LookupMissBudget, networkOf, readRrlConfig, RRL_DEFAULTS } = require('../src/responseRateLimit.ts');
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

  it('[DRRL4] defaults: 20 answers a second per network, slip 2, 100 misses a second for the server', function () {
    assert.deepStrictEqual(readRrlConfig(() => undefined), { ...RRL_DEFAULTS });
    assert.deepStrictEqual({ ...RRL_DEFAULTS }, { perSecond: 20, slip: 2, missesPerSecond: 100 });
  });

  it('[DRRL7] miss budget: misses and running lookups count; past it refused (every slip-th truncated); found names give their slot back; next second starts over; 0 is off', function () {
    const t = 50_000;
    const budget = new LookupMissBudget({ perSecond: 3, slip: 2 });
    assert.deepStrictEqual([0, 1, 2].map(() => budget.admit(t)), ['answer', 'answer', 'answer']);
    assert.strictEqual(budget.admit(t), 'drop', 'three lookups running');
    budget.done(true, t);
    assert.strictEqual(budget.admit(t), 'answer', 'a found name gives its slot back');
    budget.done(false, t);
    budget.done(false, t);
    budget.done(false, t);
    assert.deepStrictEqual([0, 1, 2].map(() => budget.admit(t)), ['slip', 'drop', 'slip'], 'three misses this second');
    assert.strictEqual(budget.admit(t + 1000), 'answer', 'next second');
    const off = new LookupMissBudget({ perSecond: 0, slip: 2 });
    for (let i = 0; i < 100; i++) { assert.strictEqual(off.admit(t), 'answer'); off.done(false, t); }
  });

  async function burst (names, perSecond, { missesPerSecond, knownUsers = [] } = {}) {
    const lookups = { user: 0, core: 0 };
    const platform = {
      async getUserCore (name) { lookups.user++; return knownUsers.includes(name) ? 'core-a' : null; },
      async getCoreInfo (id) { lookups.core++; return id === 'core-a' ? { id, ip: '192.0.2.20' } : null; },
      async getAllCoreInfos () { return []; },
      peekUserCoreForRouting (name) { return knownUsers.includes(name) ? 'core-a' : undefined; }
    };
    const store = { 'dns:domain': 'rrl.test', 'dns:defaultTTL': 60, 'dns:staticEntries': { www: { a: ['192.0.2.10'] } }, 'dns:records:root': { a: ['192.0.2.1'] } };
    const warnings = [];
    const logger = { info () {}, warn (m) { warnings.push(m); }, error () {}, debug () {} };
    const server = createDnsServer({ config: { get: (k) => store[k] }, platform, logger, platformRefreshIntervalMs: 0, responseRateLimit: { perSecond, slip: 2, missesPerSecond } });
    await server.start({ port: 0, ip: '127.0.0.1' });
    const { port } = server._getAddresses().udp;
    const client = dgram.createSocket('udp4');
    const replies = [];
    client.on('message', (msg) => replies.push(Packet.parse(msg)));
    try {
      names.forEach((name, i) => {
        const q = new Packet();
        q.header.id = 100 + i;
        q.questions.push({ name, type: Packet.TYPE.A, class: Packet.CLASS.IN });
        client.send(q.toBuffer(), port, '127.0.0.1');
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      client.close();
      await server.stop();
    }
    return { replies, lookups, warnings };
  }

  it('[DRRL5] lookup answers to one network: up to the limit, then truncated or nothing; a refused query costs no lookup and is logged as rate-limited', async function () {
    const { replies, lookups, warnings } = await burst(Array.from({ length: 12 }, (_, i) => `random${i}.rrl.test`), 4);
    const full = replies.filter((r) => r.header.tc === 0);
    const truncated = replies.filter((r) => r.header.tc === 1);
    // At most 4 full answers per second (8 if the burst crossed a second boundary).
    assert.ok(full.length >= 4 && full.length <= 8, 'full answers: ' + full.length);
    assert.ok(truncated.length >= 1, 'some refused answers slip through truncated');
    assert.ok(replies.length < 12, 'some are dropped: ' + replies.length);
    for (const t of truncated) {
      assert.strictEqual(t.header.rcode, 0);
      assert.strictEqual(t.answers.length, 0);
      assert.match(t.questions[0].name, /^random\d+\.rrl\.test$/, 'the question is echoed');
    }
    assert.strictEqual(lookups.user, full.length, 'a refused query costs no username lookup');
    assert.strictEqual(lookups.core, full.length, 'nor a core-info lookup');
    assert.ok(warnings.some((w) => /refused by dns\.responseRateLimit.*sample network: 4:127\.0\.0/.test(w)), warnings.join(' | '));
  });

  it('[DRRL6] answers that need no lookup (apex, static names) are not limited', async function () {
    const names = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 'rrl.test' : 'www.rrl.test'));
    const { replies, lookups } = await burst(names, 2);
    assert.strictEqual(replies.length, 12);
    assert.ok(replies.every((r) => r.header.tc === 0 && r.answers.length === 1));
    assert.deepStrictEqual(lookups, { user: 0, core: 0 });
  });

  it('[DRRL8] unknown names from any network: past missesPerSecond for the server they cost no lookup and are refused; an account in the routing cache is still answered', async function () {
    const names = Array.from({ length: 12 }, (_, i) => `forged${i}.rrl.test`);
    names.push('alice.rrl.test');
    const { replies, lookups, warnings } = await burst(names, 0, { missesPerSecond: 3, knownUsers: ['alice'] });
    const misses = replies.filter((r) => r.header.tc === 0 && /^forged/.test(r.questions[0].name));
    // 3 per second (6 if the burst crossed a second boundary).
    assert.ok(misses.length >= 3 && misses.length <= 6, 'unknown names looked up: ' + misses.length);
    assert.ok(misses.every((r) => r.header.rcode === 3), 'NXDOMAIN');
    assert.ok(replies.some((r) => r.header.tc === 1), 'some refused queries slip through truncated');
    assert.strictEqual(lookups.user, misses.length + 1, 'refused names cost no lookup (alice costs one)');
    const alice = replies.find((r) => r.questions[0].name === 'alice.rrl.test');
    assert.ok(alice != null && alice.header.tc === 0 && alice.answers.length === 1, 'the known account is answered');
    assert.ok(warnings.some((w) => /refused by dns\.responseRateLimit\.missesPerSecond/.test(w)), warnings.join(' | '));
  });
});
