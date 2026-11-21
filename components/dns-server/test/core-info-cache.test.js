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
const { createDnsServer } = require('../src/index.ts');

/**
 * [DCIC] While the periodic platform refresh runs, the embedded DNS answers
 * core names, the core of an account, cluster discovery and hosted sites from
 * the core-info list of the last refresh: a query costs no core-info read. A
 * core missing from the list is read for an account on it; without a recent
 * list (refresh off, or failing for three intervals) every answer reads.
 */

describe('[DCIC] DNS core-info list', function () {
  const CORES = [
    { id: 'core-a', ip: '192.0.2.11', sites: ['docs'] },
    { id: 'core-b', ip: '192.0.2.12' }
  ];

  async function startWith ({ intervalMs, cores = CORES, userCores = { alice: 'core-a', bob: 'core-c' } }) {
    const reads = { one: 0, all: 0 };
    const state = { failAll: false };
    const platform = {
      async getUserCore (name) { return userCores[name] ?? null; },
      async getCoreInfo (id) {
        reads.one++;
        if (id === 'core-c') return { id: 'core-c', ip: '192.0.2.13' };
        return cores.find((c) => c.id === id) ?? null;
      },
      async getAllCoreInfos () {
        reads.all++;
        if (state.failAll) throw new Error('no leader');
        return cores;
      }
    };
    const store = { 'dns:domain': 'dcic.test', 'dns:defaultTTL': 60, 'dns:staticEntries': {}, 'dns:records:root': { a: ['192.0.2.1'] }, 'core:id': 'core-a' };
    const logger = { info () {}, warn () {}, error () {}, debug () {} };
    const server = createDnsServer({ config: { get: (k) => store[k] }, platform, logger, platformRefreshIntervalMs: intervalMs, responseRateLimit: { perSecond: 0, slip: 0 } });
    await server.start({ port: 0, ip: '127.0.0.1' });
    const { port } = server._getAddresses().udp;
    return { server, port, reads, state };
  }

  function query (port, name) {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      const timer = setTimeout(() => { client.close(); reject(new Error('no answer for ' + name)); }, 2000);
      client.on('message', (msg) => { clearTimeout(timer); client.close(); resolve(Packet.parse(msg)); });
      const q = new Packet();
      q.header.id = 4242;
      q.questions.push({ name, type: Packet.TYPE.A, class: Packet.CLASS.IN });
      client.send(q.toBuffer(), port, '127.0.0.1');
    });
  }

  const ips = (reply) => reply.answers.map((a) => a.address).sort();

  it('[DCIC1] with a recent list: a core name, an account, cluster discovery and a hosted site cost no core-info read', async function () {
    const { server, port, reads } = await startWith({ intervalMs: 60_000 });
    try {
      reads.one = 0;
      reads.all = 0;
      assert.deepStrictEqual(ips(await query(port, 'core-b.dcic.test')), ['192.0.2.12']);
      assert.deepStrictEqual(ips(await query(port, 'alice.dcic.test')), ['192.0.2.11']);
      assert.deepStrictEqual(ips(await query(port, 'reg.dcic.test')), ['192.0.2.11', '192.0.2.12']);
      assert.deepStrictEqual(ips(await query(port, 'docs.dcic.test')), ['192.0.2.11']);
      assert.strictEqual((await query(port, 'nobody.dcic.test')).header.rcode, 3);
      assert.deepStrictEqual(reads, { one: 0, all: 0 });
    } finally {
      await server.stop();
    }
  });

  it('[DCIC2] an account on a core not in the list yet is answered by reading that core', async function () {
    const { server, port, reads } = await startWith({ intervalMs: 60_000 });
    try {
      reads.one = 0;
      assert.deepStrictEqual(ips(await query(port, 'bob.dcic.test')), ['192.0.2.13']);
      assert.strictEqual(reads.one, 1);
    } finally {
      await server.stop();
    }
  });

  it('[DCIC3] without the periodic refresh every answer reads, as before', async function () {
    const { server, port, reads } = await startWith({ intervalMs: 0 });
    try {
      reads.one = 0;
      reads.all = 0;
      assert.deepStrictEqual(ips(await query(port, 'alice.dcic.test')), ['192.0.2.11']);
      assert.deepStrictEqual(ips(await query(port, 'reg.dcic.test')), ['192.0.2.11', '192.0.2.12']);
      assert.strictEqual(reads.one, 2, 'core name lookup + the account core');
      assert.strictEqual(reads.all, 1, 'cluster discovery');
    } finally {
      await server.stop();
    }
  });

  it('[DCIC4] a list older than three refresh intervals (refresh failing) is not used', async function () {
    const { server, port, reads, state } = await startWith({ intervalMs: 50 });
    try {
      state.failAll = true;
      await new Promise((resolve) => setTimeout(resolve, 250));
      reads.one = 0;
      const reply = await query(port, 'alice.dcic.test');
      assert.ok(reads.one >= 1, 'read through: ' + reads.one);
      assert.deepStrictEqual(ips(reply), ['192.0.2.11']);
    } finally {
      await server.stop();
    }
  });
});
