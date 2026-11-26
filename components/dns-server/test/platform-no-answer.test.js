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
 * [DNNA] When the platform database does not answer (a leader change), the
 * embedded DNS answers SERVFAIL (no answer, no SOA: nothing a resolver caches
 * as a negative), a refresh keeps what it had, and the start, with the
 * periodic refresh on, leaves a first unanswered read to that refresh.
 */

describe('[DNNA] DNS while the platform database does not answer', function () {
  const CORES = [{ id: 'core-a', ip: '192.0.2.11', sites: ['docs'] }, { id: 'core-b', ip: '192.0.2.12' }];
  const RECORDS = [{ subdomain: 'www', records: { a: ['192.0.2.50'] } }];

  function noAnswer () {
    return Object.assign(new Error('rqlite query got no result at level default: not leader'), { name: 'RqliteNoAnswerError' });
  }

  function makePlatform () {
    const state = { fail: false, failRecords: false, recordsError: null };
    const platform = {
      async getUserCoreForRouting (name) { if (state.fail) throw noAnswer(); return name === 'alice' ? 'core-a' : null; },
      async getUserCore (name) { if (state.fail) throw noAnswer(); return name === 'alice' ? 'core-a' : null; },
      async getCoreInfo (id) { if (state.fail) throw noAnswer(); return CORES.find((c) => c.id === id) ?? null; },
      async getAllCoreInfos () { if (state.fail) throw noAnswer(); return CORES; },
      async getAllDnsRecords () {
        if (state.recordsError != null) throw state.recordsError;
        if (state.fail || state.failRecords) throw noAnswer();
        return RECORDS;
      }
    };
    return { platform, state };
  }

  function makeServer (platform, intervalMs) {
    const store = {
      'dns:domain': 'dnna.test',
      'dns:defaultTTL': 60,
      'dns:staticEntries': {},
      'dns:records:root': { a: ['192.0.2.1'], soa: { primary: 'ns1.dnna.test', admin: 'admin.dnna.test', serial: 1, refresh: 3600, retry: 600, expiration: 604800, minimum: 60 } },
      'core:id': 'core-a'
    };
    const logger = { info () {}, warn () {}, error () {}, debug () {} };
    return createDnsServer({ config: { get: (k) => store[k] }, platform, logger, platformRefreshIntervalMs: intervalMs, responseRateLimit: { perSecond: 0, slip: 0 } });
  }

  function query (port, name) {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      const timer = setTimeout(() => { client.close(); reject(new Error('no answer for ' + name)); }, 2000);
      client.on('message', (msg) => { clearTimeout(timer); client.close(); resolve(Packet.parse(msg)); });
      const q = new Packet();
      q.header.id = 4343;
      q.questions.push({ name, type: Packet.TYPE.A, class: Packet.CLASS.IN });
      client.send(q.toBuffer(), port, '127.0.0.1');
    });
  }

  const ips = (reply) => reply.answers.map((a) => a.address).sort();

  it('[DNNA1] a core name or an account read without an answer is SERVFAIL, with no answer and no SOA', async function () {
    const { platform, state } = makePlatform();
    const server = makeServer(platform, 0);
    await server.start({ port: 0, ip: '127.0.0.1' });
    try {
      const { port } = server._getAddresses().udp;
      assert.deepStrictEqual(ips(await query(port, 'alice.dnna.test')), ['192.0.2.11']);
      state.fail = true;
      for (const name of ['alice.dnna.test', 'nobody.dnna.test', 'core-b.dnna.test']) {
        const reply = await query(port, name);
        assert.strictEqual(reply.header.rcode, 2, name + ': SERVFAIL');
        assert.strictEqual(reply.answers.length, 0, name);
        assert.strictEqual(reply.authorities.length, 0, name + ': no SOA');
      }
    } finally {
      await server.stop();
    }
  });

  it('[DNNA2] a refresh without an answer keeps the runtime records, the core ids and the hosted sites', async function () {
    const { platform, state } = makePlatform();
    const server = makeServer(platform, 60_000);
    await server.start({ port: 0, ip: '127.0.0.1' });
    try {
      const { port } = server._getAddresses().udp;
      state.fail = true;
      await assert.rejects(server.refreshFromPlatform(), { name: 'RqliteNoAnswerError' });
      assert.deepStrictEqual(ips(await query(port, 'www.dnna.test')), ['192.0.2.50'], 'runtime record kept');
      assert.deepStrictEqual(ips(await query(port, 'core-b.dnna.test')), ['192.0.2.12'], 'core ids kept');
      assert.deepStrictEqual(ips(await query(port, 'docs.dnna.test')), ['192.0.2.11'], 'hosted site kept');
    } finally {
      await server.stop();
    }
  });

  it('[DNNA3] with the periodic refresh on, a start whose first read gets no answer goes on: misses are SERVFAIL until the records are read, retried every second', async function () {
    this.timeout(5000);
    const { platform, state } = makePlatform();
    state.failRecords = true;
    // A refresh interval far longer than the test: only the start retry can catch up.
    const server = makeServer(platform, 60_000);
    await server.start({ port: 0, ip: '127.0.0.1' });
    try {
      const { port } = server._getAddresses().udp;
      // The platform answers the lookups again, the records are not read yet.
      for (const name of ['www.dnna.test', 'nobody.dnna.test']) {
        const reply = await query(port, name);
        assert.strictEqual(reply.header.rcode, 2, name + ': SERVFAIL, not NXDOMAIN');
        assert.strictEqual(reply.authorities.length, 0, name + ': no SOA');
      }
      assert.deepStrictEqual(ips(await query(port, 'alice.dnna.test')), ['192.0.2.11'], 'an account found is answered');
      state.failRecords = false;
      await new Promise((resolve) => setTimeout(resolve, 1300));
      assert.deepStrictEqual(ips(await query(port, 'www.dnna.test')), ['192.0.2.50']);
      assert.strictEqual((await query(port, 'nobody.dnna.test')).header.rcode, 3, 'NXDOMAIN once the records are read');
    } finally {
      await server.stop();
    }
  });

  it('[DNNA4] without the periodic refresh, or on another failure, the start fails', async function () {
    const first = makePlatform();
    first.state.failRecords = true;
    const noTimer = makeServer(first.platform, 0);
    await assert.rejects(noTimer.start({ port: 0, ip: '127.0.0.1' }), { name: 'RqliteNoAnswerError' });
    await noTimer.stop();
    const second = makePlatform();
    second.state.recordsError = new Error('SQLITE_CORRUPT');
    const otherFailure = makeServer(second.platform, 50);
    await assert.rejects(otherFailure.start({ port: 0, ip: '127.0.0.1' }), /SQLITE_CORRUPT/);
    await otherFailure.stop();
  });
});
