/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('assert');
const dns = require('dns');
const dgram = require('dgram');
const net = require('net');
const dns2 = require('dns2');
const { Packet } = dns2;
const { createDnsServer } = require('../src/index.ts');

const TEST_DOMAIN = 'test.pryv.me';
const TEST_TTL = 60;

// Mock platform
function createMockPlatform (opts = {}) {
  const userCores = opts.userCores || {};
  const coreInfos = opts.coreInfos || [];
  return {
    async getUserCore (username) {
      if (username === 'platform-failure') throw new Error('simulated platform failure');
      return userCores[username] || null;
    },
    async getCoreInfo (coreId) {
      return coreInfos.find(c => c.id === coreId) || null;
    },
    async getAllCoreInfos () {
      return coreInfos;
    }
  };
}

// Mock config
function createMockConfig (overrides = {}) {
  const store = {
    'dns:domain': TEST_DOMAIN,
    'dns:active': true,
    'dns:port': 0, // ephemeral
    'dns:ip': '127.0.0.1',
    'dns:ip6': null,
    'dns:defaultTTL': TEST_TTL,
    'dns:staticEntries': {
      www: { cname: 'web.example.com' },
      reg: { cname: 'register.example.com' },
      api: { a: ['5.6.7.8'] }
    },
    'dns:records:root': {
      a: ['1.2.3.4'],
      aaaa: ['::1'],
      ns: ['ns1.test.pryv.me', 'ns2.test.pryv.me'],
      mx: [{ exchange: 'mail.test.pryv.me', priority: 10 }],
      txt: ['v=spf1 ~all'],
      caa: [{ flags: 0, tag: 'issue', value: 'letsencrypt.org' }],
      soa: {
        primary: 'ns1.test.pryv.me',
        admin: 'admin.test.pryv.me',
        serial: 2026032001,
        refresh: 3600,
        retry: 600,
        expiration: 604800,
        minimum: 86400
      }
    },
    ...overrides
  };
  return {
    get (key) { return store[key]; }
  };
}

// Mock logger
function createMockLogger () {
  return {
    info () {},
    warn () {},
    error () {}
  };
}

// Raw UDP query for record types not exposed by dns.Resolver (SOA, CAA)
// and for NXDOMAIN checks (Resolver throws on NXDOMAIN instead of returning rcode)
// opts.z: raw Z/AD/CD header bits (2 = AD, as dig sets by default)
// opts.answers: records to smuggle into the query's answer section
// opts.host: server address (IPv6 literal switches to udp6)
let queryId = 1;
function buildQuery (name, type, opts = {}) {
  const typeValue = typeof type === 'number' ? type : Packet.TYPE[type];
  const q = new Packet();
  q.header.id = queryId++;
  q.header.rd = 1;
  q.header.z = opts.z || 0;
  q.header.tc = opts.tc || 0;
  q.questions.push({ name, type: typeValue, class: Packet.CLASS.IN });
  for (const a of (opts.answers || [])) q.answers.push(a);
  return q.toBuffer();
}

async function rawQuery (port, name, type, opts = {}) {
  const buf = buildQuery(name, type, opts);
  const host = opts.host || '127.0.0.1';

  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('DNS query timeout'));
    }, 5000);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(Packet.parse(msg));
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      sock.close();
      reject(err);
    });
    sock.send(buf, port, host);
  });
}

// Same query over TCP (RFC 1035 section 4.2.2: 2-byte length prefix).
async function rawTcpQuery (port, name, type, opts = {}) {
  const buf = buildQuery(name, type, opts);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(buf.length);

  return new Promise((resolve, reject) => {
    const chunks = [];
    const sock = net.connect({ port, host: opts.host || '127.0.0.1' }, () => {
      sock.write(Buffer.concat([len, buf]));
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('DNS TCP query timeout'));
    }, 5000);
    sock.on('data', (chunk) => chunks.push(chunk));
    sock.on('end', () => {
      clearTimeout(timer);
      const data = Buffer.concat(chunks);
      resolve(Packet.parse(data.subarray(2, 2 + data.readUInt16BE(0))));
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function assertSoaAuthority (res, ttl, label) {
  assert.strictEqual(res.answers.length, 0, label + ': answers');
  assert.strictEqual(res.authorities.length, 1, label + ': one SOA in authority');
  const soa = res.authorities[0];
  assert.strictEqual(soa.type, Packet.TYPE.SOA, label);
  assert.strictEqual(soa.name, TEST_DOMAIN, label);
  assert.strictEqual(soa.primary, 'ns1.test.pryv.me', label);
  assert.strictEqual(soa.ttl, ttl, label + ': negative TTL');
}

describe('[DNS] DNS Server', function () {
  this.timeout(30000);

  let server;
  let port;
  let tcpPort;
  let resolver;

  const coreInfos = [
    { id: 'core1', ip: '10.0.0.1', ipv6: '::ffff:10.0.0.1', cname: null },
    { id: 'core2', ip: '10.0.0.2', ipv6: null, cname: null },
    { id: 'core-cname', ip: null, ipv6: null, cname: 'core3.external.com' }
  ];

  const userCores = {
    alice: 'core1',
    bob: 'core2',
    charlie: 'core-cname'
  };

  before(async () => {
    const platform = createMockPlatform({ userCores, coreInfos });
    const config = createMockConfig();
    const logger = createMockLogger();

    server = createDnsServer({ config, platform, logger });

    // Use port 0 to get an ephemeral port
    await server.start({ port: 0, ip: '127.0.0.1', ip6: null });
    const addrs = server._getAddresses();
    port = addrs.udp.port;
    tcpPort = addrs.tcp.port;

    // Node.js dns.Resolver pointed at our test server
    resolver = new dns.promises.Resolver();
    resolver.setServers([`127.0.0.1:${port}`]);
  });

  after(async () => {
    if (server) await server.stop();
  });

  // --- Root domain queries (dns.Resolver) ---

  describe('Root domain (dns.Resolver)', () => {
    it('[DN01] must resolve A record for root domain', async () => {
      const addresses = await resolver.resolve4(TEST_DOMAIN);
      assert.deepStrictEqual(addresses, ['1.2.3.4']);
    });

    it('[DN02] must resolve AAAA record for root domain', async () => {
      const addresses = await resolver.resolve6(TEST_DOMAIN);
      assert.strictEqual(addresses.length, 1);
      // Node normalizes IPv6; accept any form of ::1
      assert.ok(
        addresses[0] === '::1' || addresses[0] === '0000:0000:0000:0000:0000:0000:0000:0001',
        `Expected ::1 but got ${addresses[0]}`
      );
    });

    it('[DN03] must resolve MX records for root domain', async () => {
      const records = await resolver.resolveMx(TEST_DOMAIN);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0].exchange, 'mail.test.pryv.me');
      assert.strictEqual(records[0].priority, 10);
    });

    it('[DN04] must resolve NS records for root domain', async () => {
      const records = await resolver.resolveNs(TEST_DOMAIN);
      assert.strictEqual(records.length, 2);
      assert.deepStrictEqual(records.sort(), ['ns1.test.pryv.me', 'ns2.test.pryv.me']);
    });

    it('[DN05] must resolve TXT records for root domain', async () => {
      const records = await resolver.resolveTxt(TEST_DOMAIN);
      assert.strictEqual(records.length, 1);
      assert.deepStrictEqual(records[0], ['v=spf1 ~all']);
    });
  });

  // --- Root domain (raw UDP for SOA/CAA) ---

  describe('Root domain (raw UDP)', () => {
    it('[DN06] must return SOA record for root domain', async () => {
      const res = await rawQuery(port, TEST_DOMAIN, 'SOA');
      const records = res.answers.filter(a => a.type === Packet.TYPE.SOA);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0].primary, 'ns1.test.pryv.me');
      assert.strictEqual(records[0].admin, 'admin.test.pryv.me');
      assert.strictEqual(records[0].serial, 2026032001);
      assert.strictEqual(res.authorities.length, 0, 'an SOA query answers the SOA in ANSWER, not AUTHORITY');
    });

    it('[DN07] must resolve CAA record for root domain', async () => {
      // dns2 can encode CAA but not decode — use Node's resolver which handles CAA
      const records = await resolver.resolveCaa(TEST_DOMAIN);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0].critical, 0);
      assert.strictEqual(records[0].issue, 'letsencrypt.org');
    });
  });

  // --- Static subdomains ---

  describe('Static subdomains', () => {
    it('[DN10] must resolve CNAME for www subdomain', async () => {
      const records = await resolver.resolveCname(`www.${TEST_DOMAIN}`);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0], 'web.example.com');
    });

    it('[DN11] reserved `reg` subdomain auto-resolves to all core IPs (ignoring staticEntries)', async () => {
    // `reg`, `access`, `mfa` are distribution-reserved
      // service subdomains. DnsServer shadows any staticEntries for these
      // names with A records pointing to every available core, so /service/info
      // lookups stay symmetric across the cluster. Even though the mock config
      // sets `reg: { cname: 'register.example.com' }`, the reserved-name
      // override wins.
      const addresses = await resolver.resolve4(`reg.${TEST_DOMAIN}`);
      assert.deepStrictEqual(addresses.sort(), ['10.0.0.1', '10.0.0.2'].sort());
    });

    it('[DN12] must resolve A record for static A subdomain', async () => {
      const addresses = await resolver.resolve4(`api.${TEST_DOMAIN}`);
      assert.deepStrictEqual(addresses, ['5.6.7.8']);
    });

    it('[DN13] a CNAME entry answers the CNAME for every query type', async () => {
      for (const type of ['AAAA', 'TXT', 'MX', 'CAA']) {
        const res = await rawQuery(port, `www.${TEST_DOMAIN}`, type);
        assert.strictEqual(res.header.rcode, 0, type);
        assert.strictEqual(res.answers.length, 1, type + ': expected exactly the CNAME');
        assert.strictEqual(res.answers[0].type, Packet.TYPE.CNAME, type);
        assert.strictEqual(res.answers[0].domain, 'web.example.com', type);
      }
    });

    it('[DN14] a CNAME entry never mixes other record types for the name', async () => {
      await server.updateStaticEntry('mixed', { cname: 'mixed.example.com', a: ['9.9.9.9'], txt: ['stray'] });
      for (const type of ['A', 'TXT', 'ANY']) {
        const res = await rawQuery(port, `mixed.${TEST_DOMAIN}`, type);
        assert.deepStrictEqual(res.answers.map(a => a.type), [Packet.TYPE.CNAME], type);
      }
    });
  });

  // --- Username resolution ---

  describe('Username resolution', () => {
    it('[DN20] must resolve username to core IP (A record)', async () => {
      const addresses = await resolver.resolve4(`alice.${TEST_DOMAIN}`);
      assert.deepStrictEqual(addresses, ['10.0.0.1']);
    });

    it('[DN21] must resolve username to different core IP', async () => {
      const addresses = await resolver.resolve4(`bob.${TEST_DOMAIN}`);
      assert.deepStrictEqual(addresses, ['10.0.0.2']);
    });

    it('[DN22] must resolve username via CNAME when core has no IP', async () => {
      const records = await resolver.resolveCname(`charlie.${TEST_DOMAIN}`);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0], 'core3.external.com');
    });

    it('[DN23] must return NXDOMAIN for unknown username', async () => {
      const res = await rawQuery(port, `unknown-user-xyz.${TEST_DOMAIN}`, 'A');
      assert.strictEqual(res.answers.length, 0);
      assert.strictEqual(res.header.rcode, 3); // NXDOMAIN
    });

    it('[DN24] must resolve username AAAA when core has IPv6', async () => {
      // dns2 may mangle IPv6-mapped IPv4 (::ffff:10.0.0.1 → ::255.255.0.16)
      // so use raw query to verify the server returns an AAAA answer
      const res = await rawQuery(port, `alice.${TEST_DOMAIN}`, 'AAAA');
      const records = res.answers.filter(a => a.type === Packet.TYPE.AAAA);
      assert.strictEqual(records.length, 1);
      // Verify we got an address back (exact format depends on dns2 serialization)
      assert.ok(records[0].address, 'Expected an AAAA address');
    });

    it('[DN25] a username on a CNAME-only core answers the CNAME for AAAA', async () => {
      const res = await rawQuery(port, `charlie.${TEST_DOMAIN}`, 'AAAA');
      assert.strictEqual(res.answers.length, 1);
      assert.strictEqual(res.answers[0].type, Packet.TYPE.CNAME);
      assert.strictEqual(res.answers[0].domain, 'core3.external.com');
    });
  });

  // --- Cluster discovery ---

  describe('Cluster discovery (lsc)', () => {
    it('[DN30] must return all core IPs for lsc.{domain}', async () => {
      const addresses = await resolver.resolve4(`lsc.${TEST_DOMAIN}`);
      assert.strictEqual(addresses.length, 2);
      assert.deepStrictEqual(addresses.sort(), ['10.0.0.1', '10.0.0.2']);
    });
  });

  // --- Per-core resolution ---

  describe('<coreId>.{domain} from PlatformDB', () => {
    it('[DN35] must resolve coreId to that core\'s A record', async () => {
      const addresses = await resolver.resolve4(`core1.${TEST_DOMAIN}`);
      assert.deepStrictEqual(addresses, ['10.0.0.1']);
    });

    it('[DN36] must resolve coreId via CNAME when core has no IP', async () => {
      const records = await resolver.resolveCname(`core-cname.${TEST_DOMAIN}`);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0], 'core3.external.com');
    });

    it('[DN38] a CNAME-only core answers the CNAME for TXT and AAAA', async () => {
      for (const type of ['TXT', 'AAAA']) {
        const res = await rawQuery(port, `core-cname.${TEST_DOMAIN}`, type);
        assert.strictEqual(res.answers.length, 1, type);
        assert.strictEqual(res.answers[0].type, Packet.TYPE.CNAME, type);
      }
    });

    it('[DN37] coreId branch must not shadow operator-provided staticEntries', async () => {
      // `api` is in staticEntries and not a coreId; the static A record wins.
      // (Conversely, if an operator declares a static entry whose name
      // collides with a coreId, the static entry takes precedence — see
      // dispatch order.)
      const addresses = await resolver.resolve4(`api.${TEST_DOMAIN}`);
      assert.deepStrictEqual(addresses, ['5.6.7.8']);
    });
  });

  // --- Dynamic runtime entry updates ---

  describe('updateStaticEntry', () => {
    it('[DN40] must update runtime entry for ACME challenge', async () => {
      await server.updateStaticEntry('_acme-challenge', { txt: ['acme-validation-token-123'] });

      const records = await resolver.resolveTxt(`_acme-challenge.${TEST_DOMAIN}`);
      assert.strictEqual(records.length, 1);
      assert.deepStrictEqual(records[0], ['acme-validation-token-123']);
    });

    it('[DN41] must reject updates that would shadow a config-static entry', async () => {
      // Config wins — admin cannot override infrastructure records.
      let caught = null;
      try {
        await server.updateStaticEntry('www', { a: ['99.99.99.99'] });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'Expected updateStaticEntry(www, ...) to throw');
      assert.match(caught.message, /config-static/);

      // www still resolves to the config value
      const records = await resolver.resolveCname(`www.${TEST_DOMAIN}`);
      assert.deepStrictEqual(records, ['web.example.com']);
    });
  });

  // --- Not our domain ---

  describe('Non-matching domain', () => {
    it('[DN50] must return REFUSED for queries outside our domain', async () => {
      const res = await rawQuery(port, 'example.com', 'A');
      assert.strictEqual(res.answers.length, 0);
      assert.strictEqual(res.header.rcode, 5); // REFUSED
      assert.strictEqual(res.header.aa, 0, 'not authoritative for a foreign zone');
      assert.strictEqual(res.authorities.length, 0, 'no SOA of ours for a foreign zone');
    });

    it('[DN51] a name that only ends with the domain string is out of zone', async () => {
      const res = await rawQuery(port, 'x' + TEST_DOMAIN, 'A');
      assert.strictEqual(res.header.rcode, 5);
      assert.strictEqual(res.answers.length, 0);
    });
  });

  // --- Header flags and RFC 2308 negative answers ---

  describe('Header flags', () => {
    it('[DN60] answers are authoritative and never echo the AD bit', async () => {
      const cases = [
        [TEST_DOMAIN, 'A', 0],
        [`api.${TEST_DOMAIN}`, 'AAAA', 0],
        [`unknown-user-xyz.${TEST_DOMAIN}`, 'A', 3]
      ];
      for (const [name, type, rcode] of cases) {
        const res = await rawQuery(port, name, type, { z: 2, tc: 1 });
        const label = `${name} ${type}`;
        assert.strictEqual(res.header.rcode, rcode, label);
        assert.strictEqual(res.header.aa, 1, label + ': aa');
        assert.strictEqual(res.header.z, 0, label + ': z (AD/CD) cleared');
        assert.strictEqual(res.header.tc, 0, label + ': tc not echoed');
        assert.strictEqual(res.header.ra, 0, label + ': ra');
        assert.strictEqual(res.header.rd, 1, label + ': rd echoed');
      }
    });

    it('[DN61] records carried in the query are not echoed back', async () => {
      const smuggled = { name: TEST_DOMAIN, type: Packet.TYPE.A, class: Packet.CLASS.IN, ttl: 1, address: '6.6.6.6' };
      const res = await rawQuery(port, `unknown-user-xyz.${TEST_DOMAIN}`, 'A', { answers: [smuggled] });
      assert.strictEqual(res.header.rcode, 3);
      assert.strictEqual(res.answers.length, 0);
    });
  });

  describe('Negative answers (RFC 2308)', () => {
    it('[DN62] NODATA answers carry the apex SOA with the negative TTL', async () => {
      const cases = [
        [TEST_DOMAIN, 'SRV'], // apex, type not configured
        [`api.${TEST_DOMAIN}`, 'AAAA'], // static entry without AAAA
        [`bob.${TEST_DOMAIN}`, 'AAAA'], // username on an IPv4-only core
        [`alice.${TEST_DOMAIN}`, 'TXT'], // username
        [`core2.${TEST_DOMAIN}`, 'AAAA'], // coreId
        [`lsc.${TEST_DOMAIN}`, 'TXT'], // cluster discovery
        [`reg.${TEST_DOMAIN}`, 'TXT'] // reserved service name
      ];
      for (const [name, type] of cases) {
        const res = await rawQuery(port, name, type);
        assert.strictEqual(res.header.rcode, 0, `${name} ${type}: NOERROR`);
        // min(defaultTTL 60, SOA minimum 86400)
        assertSoaAuthority(res, TEST_TTL, `${name} ${type}`);
      }
    });

    it('[DN63] NXDOMAIN answers carry the apex SOA', async () => {
      await server.deleteStaticEntry('_acme-challenge');
      for (const name of [`unknown-user-xyz.${TEST_DOMAIN}`, `_acme-challenge.${TEST_DOMAIN}`]) {
        const res = await rawQuery(port, name, 'TXT');
        assert.strictEqual(res.header.rcode, 3, name);
        assertSoaAuthority(res, TEST_TTL, name);
      }
    });

    it('[DN64] a platform failure answers SERVFAIL, not a cacheable negative answer', async () => {
      const res = await rawQuery(port, `platform-failure.${TEST_DOMAIN}`, 'A');
      assert.strictEqual(res.header.rcode, 2);
      assert.strictEqual(res.answers.length, 0);
      assert.strictEqual(res.authorities.length, 0);
    });

    it('[DN65] positive answers carry no authority records', async () => {
      for (const [name, type] of [[TEST_DOMAIN, 'A'], [`alice.${TEST_DOMAIN}`, 'A'], [`www.${TEST_DOMAIN}`, 'AAAA']]) {
        const res = await rawQuery(port, name, type);
        assert.ok(res.answers.length > 0, `${name} ${type}`);
        assert.strictEqual(res.authorities.length, 0, `${name} ${type}`);
      }
    });
  });

  // --- TCP (RFC 7766) ---

  describe('TCP', () => {
    it('[DN70] TCP answers match UDP for positive, NODATA and NXDOMAIN', async () => {
      const cases = [
        [`alice.${TEST_DOMAIN}`, 'A'],
        [`api.${TEST_DOMAIN}`, 'AAAA'],
        [`unknown-user-xyz.${TEST_DOMAIN}`, 'A'],
        ['example.com', 'A']
      ];
      for (const [name, type] of cases) {
        const viaUdp = await rawQuery(port, name, type, { z: 2 });
        const viaTcp = await rawTcpQuery(tcpPort, name, type, { z: 2 });
        const label = `${name} ${type}`;
        for (const k of ['rcode', 'aa', 'z', 'ra']) {
          assert.strictEqual(viaTcp.header[k], viaUdp.header[k], `${label}: header.${k}`);
        }
        assert.deepStrictEqual(viaTcp.answers, viaUdp.answers, label + ': answers');
        assert.deepStrictEqual(viaTcp.authorities, viaUdp.authorities, label + ': authorities');
      }
      const soa = await rawTcpQuery(tcpPort, `api.${TEST_DOMAIN}`, 'AAAA');
      assertSoaAuthority(soa, TEST_TTL, 'NODATA over TCP');
    });
  });
});

describe('[DNX] DNS Server: negative TTL, listeners and bind failures', function () {
  this.timeout(30000);

  const platform = createMockPlatform({ coreInfos: [{ id: 'core1', ip: '10.0.0.1' }], userCores: { alice: 'core1' } });

  it('[DNX1] the negative TTL is the SOA minimum when it is below the default TTL', async () => {
    const root = createMockConfig().get('dns:records:root');
    const config = createMockConfig({
      'dns:defaultTTL': 300,
      'dns:records:root': { ...root, soa: { ...root.soa, minimum: 30 } }
    });
    const server = createDnsServer({ config, platform, logger: createMockLogger() });
    await server.start({ port: 0, ip: '127.0.0.1', ip6: null });
    try {
      const res = await rawQuery(server._getAddresses().udp.port, `nobody.${TEST_DOMAIN}`, 'A');
      assert.strictEqual(res.header.rcode, 3);
      assertSoaAuthority(res, 30, 'min(300, 30)');
    } finally {
      await server.stop();
    }
  });

  it('[DNX2] without an apex SOA, negative answers have no authority and start() warns', async () => {
    const root = createMockConfig().get('dns:records:root');
    const warnings = [];
    const logger = { ...createMockLogger(), warn (msg) { warnings.push(msg); } };
    const config = createMockConfig({ 'dns:records:root': { ...root, soa: null } });
    const server = createDnsServer({ config, platform, logger });
    await server.start({ port: 0, ip: '127.0.0.1', ip6: null });
    try {
      assert.ok(warnings.some(w => /soa/i.test(w)), 'expected a warning about the missing SOA');
      const res = await rawQuery(server._getAddresses().udp.port, `nobody.${TEST_DOMAIN}`, 'A');
      assert.strictEqual(res.header.rcode, 3);
      assert.strictEqual(res.authorities.length, 0);
    } finally {
      await server.stop();
    }
  });

  it('[DNX3] with ip6 set, UDP6 and TCP6 listeners answer', async () => {
    const server = createDnsServer({ config: createMockConfig(), platform, logger: createMockLogger() });
    await server.start({ port: 0, ip: '127.0.0.1', ip6: '::1' });
    try {
      const addrs = server._getAddresses();
      const viaUdp6 = await rawQuery(addrs.udp6.port, `alice.${TEST_DOMAIN}`, 'A', { host: '::1' });
      const viaTcp6 = await rawTcpQuery(addrs.tcp6.port, `alice.${TEST_DOMAIN}`, 'A', { host: '::1' });
      for (const res of [viaUdp6, viaTcp6]) {
        assert.strictEqual(res.header.aa, 1);
        assert.deepStrictEqual(res.answers.map(a => a.address), ['10.0.0.1']);
      }
    } finally {
      await server.stop();
    }
    assert.deepStrictEqual(server._getAddresses(), {}, 'stop() closes every listener');
  });

  it('[DNX6] ip 0.0.0.0 and ip6 :: on the same port both bind (IPv6-only sockets)', async () => {
    // A port free for UDP and TCP on both families. On Linux a dual-stack '::'
    // UDP socket fails with EADDRINUSE next to 0.0.0.0 (macOS allows it).
    const holder = net.createServer();
    await new Promise((resolve) => holder.listen(0, '0.0.0.0', resolve));
    const port = holder.address().port;
    await new Promise((resolve) => holder.close(resolve));
    const server = createDnsServer({ config: createMockConfig(), platform, logger: createMockLogger() });
    await server.start({ port, ip: '0.0.0.0', ip6: '::' });
    try {
      const addrs = server._getAddresses();
      for (const kind of ['udp', 'tcp', 'udp6', 'tcp6']) assert.strictEqual(addrs[kind].port, port, kind);
      const viaUdp6 = await rawQuery(port, `alice.${TEST_DOMAIN}`, 'A', { host: '::1' });
      const viaUdp4 = await rawQuery(port, `alice.${TEST_DOMAIN}`, 'A', { host: '127.0.0.1' });
      for (const res of [viaUdp6, viaUdp4]) assert.deepStrictEqual(res.answers.map(a => a.address), ['10.0.0.1']);
    } finally {
      await server.stop();
    }
  });

  it('[DNX4] start() rejects, naming the port, when the TCP port is taken', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const takenPort = blocker.address().port;
    const server = createDnsServer({ config: createMockConfig(), platform, logger: createMockLogger() });
    try {
      await assert.rejects(
        server.start({ port: takenPort, ip: '127.0.0.1', ip6: null }),
        (err) => err.message.includes(String(takenPort)) && /tcp/.test(err.message)
      );
      // The UDP socket bound before the TCP failure must have been released.
      const probe = dgram.createSocket('udp4');
      await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.bind(takenPort, '127.0.0.1', resolve);
      });
      probe.close();
    } finally {
      await server.stop();
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('[DNX5] idle TCP connections are closed', async () => {
    const server = createDnsServer({ config: createMockConfig(), platform, logger: createMockLogger(), tcpIdleTimeoutMs: 100 });
    await server.start({ port: 0, ip: '127.0.0.1', ip6: null });
    try {
      const closedAfter = await new Promise((resolve, reject) => {
        const t0 = Date.now();
        const sock = net.connect({ port: server._getAddresses().tcp.port, host: '127.0.0.1' });
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('idle connection was not closed')); }, 3000);
        sock.on('error', () => {});
        sock.on('close', () => { clearTimeout(timer); resolve(Date.now() - t0); });
      });
      assert.ok(closedAfter < 3000);
    } finally {
      await server.stop();
    }
  });
});

// =============================================================================
// Persistent DNS records via PlatformDB
// Isolated describe block with its own DnsServer instance so the mock platform
// can expose setDnsRecord/getDnsRecord/getAllDnsRecords/deleteDnsRecord without
// interfering with the main suite above.
// =============================================================================

describe('[DNP] DNS Server — PlatformDB persistence', function () {
  this.timeout(30000);

  // In-memory mock PlatformDB backing store shared across all tests in this block.
  const mockPersistedRecords = new Map();

  function createPersistentPlatform () {
    return {
      async getUserCore () { return null; },
      async getCoreInfo () { return null; },
      async getAllCoreInfos () { return []; },
      async setDnsRecord (subdomain, records) {
        mockPersistedRecords.set(subdomain, records);
      },
      async getDnsRecord (subdomain) {
        return mockPersistedRecords.has(subdomain) ? mockPersistedRecords.get(subdomain) : null;
      },
      async getAllDnsRecords () {
        return Array.from(mockPersistedRecords.entries()).map(([subdomain, records]) => ({ subdomain, records }));
      },
      async deleteDnsRecord (subdomain) {
        mockPersistedRecords.delete(subdomain);
      }
    };
  }

  beforeEach(() => {
    mockPersistedRecords.clear();
  });

  it('[DNP01] must load persisted records from PlatformDB on start()', async () => {
    mockPersistedRecords.set('_acme-challenge', { txt: ['pre-existing-token'] });

    const server = createDnsServer({
      config: createMockConfig(),
      platform: createPersistentPlatform(),
      logger: createMockLogger(),
      platformRefreshIntervalMs: 0 // disable periodic refresh for deterministic test
    });
    await server.start({ port: 0, ip: '127.0.0.1', ip6: null });
    const port = server._getAddresses().udp.port;
    const resolver = new dns.promises.Resolver();
    resolver.setServers([`127.0.0.1:${port}`]);

    try {
      const records = await resolver.resolveTxt(`_acme-challenge.${TEST_DOMAIN}`);
      assert.strictEqual(records.length, 1);
      assert.deepStrictEqual(records[0], ['pre-existing-token']);
    } finally {
      await server.stop();
    }
  });

  it('[DNP02] updateStaticEntry must persist to PlatformDB', async () => {
    const platform = createPersistentPlatform();
    const server = createDnsServer({
      config: createMockConfig(),
      platform,
      logger: createMockLogger(),
      platformRefreshIntervalMs: 0
    });
    await server.start({ port: 0, ip: '127.0.0.1', ip6: null });

    try {
      await server.updateStaticEntry('_acme-new', { txt: ['fresh-token'] });
      const stored = await platform.getDnsRecord('_acme-new');
      assert.deepStrictEqual(stored, { txt: ['fresh-token'] });
    } finally {
      await server.stop();
    }
  });

  it('[DNP03] persisted records must survive a "restart"', async () => {
    // Boot server A, persist a record, stop it.
    const platform = createPersistentPlatform();
    const server1 = createDnsServer({
      config: createMockConfig(),
      platform,
      logger: createMockLogger(),
      platformRefreshIntervalMs: 0
    });
    await server1.start({ port: 0, ip: '127.0.0.1', ip6: null });
    await server1.updateStaticEntry('_acme-surv', { txt: ['survives-restart'] });
    await server1.stop();

    // Boot server B with the same platform — must see the record from its start().
    const server2 = createDnsServer({
      config: createMockConfig(),
      platform,
      logger: createMockLogger(),
      platformRefreshIntervalMs: 0
    });
    await server2.start({ port: 0, ip: '127.0.0.1', ip6: null });
    const port = server2._getAddresses().udp.port;
    const resolver = new dns.promises.Resolver();
    resolver.setServers([`127.0.0.1:${port}`]);

    try {
      const records = await resolver.resolveTxt(`_acme-surv.${TEST_DOMAIN}`);
      assert.strictEqual(records.length, 1);
      assert.deepStrictEqual(records[0], ['survives-restart']);
    } finally {
      await server2.stop();
    }
  });

  it('[DNP04] config-static entries MUST shadow PlatformDB records', async () => {
    // PlatformDB says www should point elsewhere — config must win.
    mockPersistedRecords.set('www', { a: ['66.66.66.66'] });

    const server = createDnsServer({
      config: createMockConfig(),
      platform: createPersistentPlatform(),
      logger: createMockLogger(),
      platformRefreshIntervalMs: 0
    });
    await server.start({ port: 0, ip: '127.0.0.1', ip6: null });
    const port = server._getAddresses().udp.port;
    const resolver = new dns.promises.Resolver();
    resolver.setServers([`127.0.0.1:${port}`]);

    try {
      // Config says www → web.example.com via CNAME.
      const cname = await resolver.resolveCname(`www.${TEST_DOMAIN}`);
      assert.deepStrictEqual(cname, ['web.example.com']);
    } finally {
      await server.stop();
    }
  });

  it('[DNP05] updateStaticEntry for a config-key must throw and leave PlatformDB untouched', async () => {
    const platform = createPersistentPlatform();
    const server = createDnsServer({
      config: createMockConfig(),
      platform,
      logger: createMockLogger(),
      platformRefreshIntervalMs: 0
    });
    await server.start({ port: 0, ip: '127.0.0.1', ip6: null });

    try {
      let caught = null;
      try {
        await server.updateStaticEntry('reg', { cname: 'evil.example.com' });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'Expected rejection');
      const stored = await platform.getDnsRecord('reg');
      assert.strictEqual(stored, null);
    } finally {
      await server.stop();
    }
  });

  it('[DNP06] periodic refresh must pick up records added after start() (multi-core propagation)', async () => {
    const platform = createPersistentPlatform();
    const server = createDnsServer({
      config: createMockConfig(),
      platform,
      logger: createMockLogger(),
      platformRefreshIntervalMs: 30 // poll aggressively for the test
    });
    await server.start({ port: 0, ip: '127.0.0.1', ip6: null });
    const port = server._getAddresses().udp.port;

    try {
      // Simulate another core writing to the shared PlatformDB.
      await platform.setDnsRecord('_acme-remote', { txt: ['from-remote-core'] });

      // Wait long enough for several timer ticks.
      await new Promise((resolve) => setTimeout(resolve, 100));

      let answers = [];
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const res = await rawQuery(port, `_acme-remote.${TEST_DOMAIN}`, 'TXT');
        answers = res.answers.filter(a => a.type === Packet.TYPE.TXT);
        if (answers.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(answers.length > 0, 'Remote record was not picked up by periodic refresh');
      // dns2 stores TXT data in `data` (string or array)
      const txt = answers[0].data;
      const value = Array.isArray(txt) ? txt[0] : txt;
      assert.strictEqual(value, 'from-remote-core');
    } finally {
      await server.stop();
    }
  });

  it('[DNP07] deleteStaticEntry must remove from PlatformDB and memory', async () => {
    const platform = createPersistentPlatform();
    const server = createDnsServer({
      config: createMockConfig(),
      platform,
      logger: createMockLogger(),
      platformRefreshIntervalMs: 0
    });
    await server.start({ port: 0, ip: '127.0.0.1', ip6: null });

    try {
      await server.updateStaticEntry('_acme-del', { txt: ['to-be-deleted'] });
      assert.deepStrictEqual(await platform.getDnsRecord('_acme-del'), { txt: ['to-be-deleted'] });

      await server.deleteStaticEntry('_acme-del');
      assert.strictEqual(await platform.getDnsRecord('_acme-del'), null);
    } finally {
      await server.stop();
    }
  });
});

// =============================================================================
// Hosted sites: a reserved name answered with the cores that advertise it
// =============================================================================

describe('[DN7H] DNS Server: hosted sites', function () {
  this.timeout(30000);

  async function startWith ({ coreInfos, hostedSites, coreId = 'core1', persisted = [], logger = createMockLogger() }) {
    const platform = createMockPlatform({ userCores: { sitedocs: 'core2' }, coreInfos });
    platform.getAllDnsRecords = async () => persisted;
    const overrides = { 'core:id': coreId };
    if (hostedSites) overrides.hostedSites = hostedSites;
    const server = createDnsServer({ config: createMockConfig(overrides), platform, logger, platformRefreshIntervalMs: 0 });
    await server.start({ port: 0, ip: '127.0.0.1', ip6: null });
    return { server, port: server._getAddresses().udp.port };
  }

  function addresses (res, type) {
    return res.answers.filter((a) => a.type === Packet.TYPE[type]).map((a) => a.address).sort();
  }

  it('[DN71] one of two cores advertises the site: one A record, the advertiser\'s', async () => {
    const { server, port } = await startWith({
      coreInfos: [
        { id: 'core1', ip: '10.0.0.1', sites: ['account'] },
        { id: 'core2', ip: '10.0.0.2' }
      ]
    });
    try {
      const res = await rawQuery(port, `account.${TEST_DOMAIN}`, 'A');
      assert.strictEqual(res.header.rcode, 0);
      assert.strictEqual(res.header.aa, 1);
      assert.deepStrictEqual(addresses(res, 'A'), ['10.0.0.1']);
    } finally {
      await server.stop();
    }
  });

  it('[DN72] both cores advertise the site: two A records; AAAA from ipv6 only', async () => {
    const { server, port } = await startWith({
      coreInfos: [
        { id: 'core1', ip: '10.0.0.1', ipv6: '2001:db8::1', sites: ['account'] },
        { id: 'core2', ip: '10.0.0.2', sites: ['account'] },
        { id: 'core3', ip: '10.0.0.3' },
        { id: 'core4', cname: 'core4.external.com', sites: ['account'] }
      ]
    });
    try {
      assert.deepStrictEqual(addresses(await rawQuery(port, `account.${TEST_DOMAIN}`, 'A'), 'A'), ['10.0.0.1', '10.0.0.2']);
      const aaaa = await rawQuery(port, `account.${TEST_DOMAIN}`, 'AAAA');
      assert.strictEqual(aaaa.answers.length, 1);
      assert.strictEqual(aaaa.answers[0].type, Packet.TYPE.AAAA);
    } finally {
      await server.stop();
    }
  });

  it('[DN73] a site configured here that no row advertises yet answers with this core', async () => {
    const { server, port } = await startWith({
      hostedSites: { account: { static: '/srv/account' } },
      coreInfos: [
        { id: 'core1', ip: '10.0.0.1' },
        { id: 'core2', ip: '10.0.0.2' }
      ]
    });
    try {
      assert.deepStrictEqual(addresses(await rawQuery(port, `account.${TEST_DOMAIN}`, 'A'), 'A'), ['10.0.0.1']);
    } finally {
      await server.stop();
    }
  });

  it('[DN74] a runtime record with the site name is shadowed, with a warning at start', async () => {
    const warnings = [];
    const logger = Object.assign(createMockLogger(), { warn (msg) { warnings.push(msg); } });
    const { server, port } = await startWith({
      coreInfos: [{ id: 'core1', ip: '10.0.0.1', sites: ['account'] }],
      persisted: [{ subdomain: 'account', records: { cname: 'pryv.github.io' } }],
      logger
    });
    try {
      const res = await rawQuery(port, `account.${TEST_DOMAIN}`, 'A');
      assert.deepStrictEqual(addresses(res, 'A'), ['10.0.0.1']);
      assert.ok(!res.answers.some((a) => a.type === Packet.TYPE.CNAME), 'the runtime CNAME must not be served');
      assert.ok(warnings.some((w) => w.includes("'account'") && w.includes('hosted site')), warnings.join('|'));
    } finally {
      await server.stop();
    }
  });

  it('[DN75] AAAA on IPv4-only advertisers is NODATA with the SOA', async () => {
    const { server, port } = await startWith({
      coreInfos: [{ id: 'core1', ip: '10.0.0.1', sites: ['account'] }]
    });
    try {
      const res = await rawQuery(port, `account.${TEST_DOMAIN}`, 'AAAA');
      assert.strictEqual(res.header.rcode, 0);
      assertSoaAuthority(res, TEST_TTL, 'account AAAA');
    } finally {
      await server.stop();
    }
  });

  it('[DN76] the site answer takes precedence over a username of the same name', async () => {
    // `sitedocs` is also mapped to core2 as a user in the mock platform
    const { server, port } = await startWith({
      coreInfos: [
        { id: 'core1', ip: '10.0.0.1', sites: ['sitedocs'] },
        { id: 'core2', ip: '10.0.0.2' }
      ]
    });
    try {
      assert.deepStrictEqual(addresses(await rawQuery(port, `sitedocs.${TEST_DOMAIN}`, 'A'), 'A'), ['10.0.0.1']);
      // a plain user is still resolved through its core
      const other = await rawQuery(port, `nobody-here.${TEST_DOMAIN}`, 'A');
      assert.strictEqual(other.header.rcode, 3);
    } finally {
      await server.stop();
    }
  });

  it('[DN77] a site name equal to a core id never takes over that core\'s name', async () => {
    const { server, port } = await startWith({
      coreInfos: [
        { id: 'core1', ip: '10.0.0.1', sites: ['core2'] },
        { id: 'core2', ip: '10.0.0.2' }
      ]
    });
    try {
      assert.deepStrictEqual(addresses(await rawQuery(port, `core2.${TEST_DOMAIN}`, 'A'), 'A'), ['10.0.0.2']);
    } finally {
      await server.stop();
    }
  });
});
