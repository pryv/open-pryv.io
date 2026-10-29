/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Boots a service-core API server in a child process for integration testing.
 *
 * Env vars consumed:
 *   CORE_PORT:      HTTP port to listen on
 *   CORE_ID:        core identifier (e.g. 'core-a')
 *   CORE_IP:        IP for this core (e.g. '127.0.0.1')
 *   DNS_DOMAIN:     domain (e.g. 'test-2core.pryv.li'). When set, the core
 *                     runs MULTI-core: `core.url` is `http://127.0.0.1:<CORE_PORT>`,
 *                     given to boiler through the environment before it loads,
 *                     so the core-identity plugin sees it. Without it, the core
 *                     is a single-core node.
 *   CORE_HOSTING:   optional `core:hosting`; a registration posted with
 *                     `hosting: <it>` is placed on this core.
 *   CORE_DATA_NAME: optional (e.g. '2core-a'): this core's own user data,
 *                     PostgreSQL database `pryv-node-test-<name>` (set with
 *                     `config.set`; the caller creates it before the boot and
 *                     drops it after) and local directory `var-pryv/users-<name>`
 *                     (SQLite storage, users index, attachments). Absent: the
 *                     test configuration's database and directory.
 *   RQLITE_URL:     rqlite HTTP endpoint (e.g. 'http://localhost:14001')
 *   ADMIN_KEY:      auth:adminAccessKey
 *   storages__<kind>__engine: the test run's storage engines; pass
 *                     `childStorageEngineEnv()` (test-helpers) so the core uses
 *                     the same engines as the test process.
 *   HOSTED_SITES_JSON: optional `hostedSites` block (JSON). When set, the core
 *                     runs the DNS topology (dnsLess off, sites matched by Host),
 *                     applies the same boot checks as the api-server (exit 1 on
 *                     a missing folder) and serves the sites in front of express.
 *
 * Sends IPC 'ready' message when server is listening.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const path = require('node:path');

// The fork's IPC channel leads to the test runner, not to a cluster master.
// Left visible, cluster_kv sends its requests there, nobody answers, and every
// call times out (a 500 on POST /reg/access). Hide it from the core and keep it
// for the ready signal only.
const sendToParent = typeof process.send === 'function' ? process.send.bind(process) : null;
process.send = undefined;

// Multi-core identity, known BEFORE boiler init: the core-identity config
// plugin decides `core:url` and `core:isSingleCore` once, while boiler loads,
// and a later `config.set` does not revisit that decision. Boiler reads the
// environment with `__` as the key separator, as production reaches the
// plugin with its config. With an explicit `core.url` and dnsLess off, the
// core runs multi-core and advertises that URL to the others.
if (process.env.DNS_DOMAIN) {
  process.env.core__id = process.env.CORE_ID || 'single';
  process.env.core__url = 'http://127.0.0.1:' + (process.env.CORE_PORT || '3000');
  process.env.dns__domain = process.env.DNS_DOMAIN;
}

// Boiler init — must happen before any other require
require('@pryv/boiler').init({
  appName: 'core-' + (process.env.CORE_ID || 'test'),
  baseFilesDir: path.resolve(__dirname, '../../../../'),
  baseConfigDir: path.resolve(__dirname, '../../../../config/'),
  extraConfigs: [{
    scope: 'defaults-paths',
    file: path.resolve(__dirname, '../../../../config/plugins/paths-config.js')
  }, {
    pluginAsync: require('../../../../config/plugins/systemStreams')
  }, {
    plugin: require('../../../../config/plugins/core-identity')
  }]
});

const { getConfig } = require('@pryv/boiler');
const { getApplication } = require('api-server/src/application.ts');
const http = require('node:http');

(async () => {
  const config = await getConfig();

  // Override config with env vars
  const port = parseInt(process.env.CORE_PORT || '3000');
  const coreId = process.env.CORE_ID || 'single';
  const coreIp = process.env.CORE_IP || '127.0.0.1';
  const domain = process.env.DNS_DOMAIN || null;
  const rqliteUrl = process.env.RQLITE_URL || config.get('storages:engines:rqlite:url');
  const adminKey = process.env.ADMIN_KEY || 'test-admin-key';

  config.set('http:port', port);
  config.set('http:ip', '127.0.0.1');
  config.set('core:id', coreId);
  config.set('core:ip', coreIp);
  config.set('core:available', true);
  if (process.env.CORE_HOSTING) config.set('core:hosting', process.env.CORE_HOSTING);
  config.set('dns:domain', domain);
  config.set('auth:adminAccessKey', adminKey);
  // platform.piiMode defaults to "hashed" since 2.0.0-rc.3; multi-core child
  // cores must share the same pepper as the parent. Same fixed test pepper as
  // components/test-helpers/src/helpers-c.ts so HMAC tokens collide.
  config.set('platform:piiHmacKey', process.env.PII_HMAC_KEY || 'WLthDQK7GoYZINg7uIeWN9eANnj2BSh4zEZmRPyR5y0=');
  config.set('storages:platform:engine', 'rqlite');
  config.set('storages:engines:rqlite:url', rqliteUrl);
  // This core's own user data, as on a real cluster (the platform store
  // stays shared). Read at `storages.init()` / first use, both inside
  // `app.initiate()` below.
  const dataName = process.env.CORE_DATA_NAME || null;
  if (dataName != null) {
    config.set('storages:engines:postgresql:database', 'pryv-node-test-' + dataName);
    config.set('storages:engines:sqlite:path', path.resolve(__dirname, '../../../../var-pryv/users-' + dataName));
  }
  config.set('dnsLess:publicUrl', `http://127.0.0.1:${port}`);
  // service:api format needed by api-endpoint.js for building apiEndpoints
  if (domain) {
    config.set('service:api', `http://{username}.${domain}/`);
  } else {
    config.set('service:api', `http://127.0.0.1:${port}/{username}/`);
  }
  config.set('service:register', `http://127.0.0.1:${port}/reg/`);
  // The event-types dictionary of the test runs (this process does not load
  // the service-info file): without it the core boots degraded, on the
  // embedded fallback, refusing every type that is not in it.
  config.set('service:eventTypes', require('../../../../test/service-info.json').eventTypes);
  // CMC retry loop timings, so a queued notice goes out within a test.
  if (process.env.CMC_RETRY_INTERVAL_MS) config.set('cmc:retryLoop:intervalMs', Number(process.env.CMC_RETRY_INTERVAL_MS));
  if (process.env.CMC_DELIVERY_BACKOFF_BASE_MS) {
    require('cmc/src/retryQueue.ts').setDeliveryBackoffBaseMsForTests(Number(process.env.CMC_DELIVERY_BACKOFF_BASE_MS));
  }
  // Calls to a peer account (CMC) go to `http://{username}.<domain>/`, which
  // only the suite's own DNS server resolves: with CMC_PEERS_VIA_PLATFORM,
  // answer them from the core that hosts the account (the platform says
  // which), at its listening URL. This replaces the guarded peer client
  // (its URL checks still run).
  if (domain && process.env.CMC_PEERS_VIA_PLATFORM === '1') {
    const { setPeerTransportForTests } = require('business/src/outbound/peerFetch.ts');
    const { getPlatform } = require('platform');
    const suffix = '.' + domain;
    setPeerTransportForTests(async (rawUrl, init) => {
      const u = new URL(rawUrl);
      if (u.hostname.endsWith(suffix)) {
        const username = u.hostname.slice(0, -suffix.length);
        const platform = await getPlatform();
        const peerCoreId = await platform.getUserCore(username);
        const info = peerCoreId != null ? await platform.getCoreInfo(peerCoreId) : null;
        if (info?.url != null) return await fetch(info.url.replace(/\/$/, '') + '/' + username + u.pathname + u.search, init);
      }
      return await fetch(rawUrl, init);
    });
  }
  config.set('audit:active', false);
  config.set('webhooks:inProcess', false);
  config.set('http:ssl:backloop.dev', false);
  config.set('http:ssl:keyFile', null);
  const hostedSitesJson = process.env.HOSTED_SITES_JSON || null;
  let sites = null;
  if (hostedSitesJson != null) {
    config.set('hostedSites', JSON.parse(hostedSitesJson));
    config.set('dnsLess:isActive', false);
    // Folders first, before the platform registration advertises the sites
    const { parseHostedSites } = require('business/src/hostedSites.ts');
    const { checkStaticSiteFolders } = require('api-server/src/hostedSitesIngress.ts');
    sites = parseHostedSites(config);
    const folderProblems = checkStaticSiteFolders(sites);
    if (folderProblems.length > 0) throw new Error('Hosted sites cannot be served: ' + folderProblems.join('; '));
  }

  // Boot application
  const app = getApplication(true);
  await app.initiate();

  // Register API methods directly on the Application instance
  await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
  await require('api-server/src/methods/utility.ts').default(app.api);
  await require('api-server/src/methods/auth/login.ts').default(app.api);
  await require('api-server/src/methods/auth/register.ts').default(app.api);
  await require('api-server/src/methods/auth/delete.ts').default(app.api);
  await require('api-server/src/methods/mfa.ts').default(app.api);
  await require('api-server/src/methods/accesses.ts').default(app.api);
  require('api-server/src/methods/service.ts').default(app.api);
  await require('api-server/src/methods/webhooks.ts').default(app.api);
  await require('api-server/src/methods/shared-secrets.ts').default(app.api);
  await require('api-server/src/methods/trackingFunctions.ts').default(app.api);
  await require('api-server/src/methods/account.ts').default(app.api);
  await require('api-server/src/methods/externalIds.ts').default(app.api);
  await require('api-server/src/methods/accountAutoDeletion.ts').default(app.api);
  await require('api-server/src/methods/profile.ts').default(app.api);
  await require('api-server/src/methods/streams.ts').default(app.api);
  await require('api-server/src/methods/events.ts').default(app.api);

  // Hosted sites in front of express, with the api-server's boot checks
  let requestHandler = app.expressApp;
  if (sites != null) {
    const { buildHostedSitesIngress, checkHostedSitesAtBoot } = require('api-server/src/hostedSitesIngress.ts');
    const { getUsersRepository } = require('business/src/users/index.ts');
    const { getPlatform } = require('platform');
    const problems = await checkHostedSitesAtBoot(sites, await getUsersRepository(), await getPlatform());
    if (problems.length > 0) throw new Error('Hosted sites cannot be served: ' + problems.join('; '));
    const dispatch = buildHostedSitesIngress({ sites, domain, dnsLess: false, logger: { debug () {}, info () {}, warn () {}, error () {} } });
    requestHandler = (req, res) => dispatch(req, res, app.expressApp);
  }

  // Start HTTP server
  const httpServer = http.createServer(requestHandler);
  await new Promise((resolve, reject) => {
    httpServer.listen(port, '127.0.0.1', () => resolve());
    httpServer.once('error', reject);
  });

  // Signal ready to parent
  if (sendToParent != null) {
    sendToParent({
      type: 'ready',
      port,
      coreId,
      baseEngine: config.get('storages:base:engine'),
      isSingleCore: config.get('core:isSingleCore'),
      coreUrl: config.get('core:url'),
      hosting: config.get('core:hosting') ?? null,
      rqliteUrl: config.get('storages:engines:rqlite:url'),
      pgDatabase: config.get('storages:engines:postgresql:database'),
      sqlitePath: config.get('storages:engines:sqlite:path')
    });
  }
  console.log(`[${coreId}] listening on http://127.0.0.1:${port}`);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    httpServer.close(() => process.exit(0));
  });
})().catch(err => {
  console.error('Core process boot failed:', err);
  process.exit(1);
});
