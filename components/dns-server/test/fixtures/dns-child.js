/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Child-process harness for the server-level DNS tests. Starts a DnsServer on
 * an ephemeral 127.0.0.1 port with a mock config and platform described by the
 * DNS_CHILD_OPTS env var, then prints `READY {"udp":N,"tcp":N}`. Running the
 * server in its own process means a non-terminating parse shows up in the
 * parent as a query timeout and a thrown error shows up as the child exiting.
 *
 * DNS_SERVER_SRC may point at an alternative server module (used to measure the
 * behaviour of a previous implementation under the same harness).
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = require('path');

const srcPath = process.env.DNS_SERVER_SRC || path.resolve(import.meta.dirname, '../../src/index.ts');
const { createDnsServer } = require(srcPath);

const opts = JSON.parse(process.env.DNS_CHILD_OPTS || '{}');
const domain = opts.domain || 'test.pryv.me';
const ttl = opts.ttl || 60;
const rootRecords = opts.root || {
  a: ['1.2.3.4'],
  soa: { primary: 'ns1.' + domain, admin: 'admin.' + domain, serial: 1, refresh: 3600, retry: 600, expiration: 604800, minimum: 86400 }
};

const store = {
  'dns:domain': domain,
  'dns:defaultTTL': ttl,
  'dns:records:root': rootRecords,
  'dns:staticEntries': opts.staticEntries || {},
  'dns:tcpMaxConnections': opts.tcpMaxConnections || 64,
  'core:id': opts.coreId || 'core1',
  hostedSites: opts.hostedSites || {}
};

const userCores = opts.userCores || {};
const coreInfos = opts.coreInfos || [];

const config = { get (k) { return store[k]; } };
const logger = { info () {}, warn () {}, error () {} };
const platform = {
  async getUserCore (u) { return userCores[u] || null; },
  async getCoreInfo (id) { return coreInfos.find((c) => c.id === id) || null; },
  async getAllCoreInfos () { return coreInfos; }
};
if (opts.persisted) platform.getAllDnsRecords = async () => opts.persisted;

const server = createDnsServer({ config, platform, logger, platformRefreshIntervalMs: 0 });

async function shutdown () {
  try { await server.stop(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await server.start({ port: opts.port || 0, ip: '127.0.0.1', ip6: null });
const addrs = server._getAddresses();
process.stdout.write('READY ' + JSON.stringify({ udp: addrs.udp.port, tcp: addrs.tcp.port }) + '\n');
