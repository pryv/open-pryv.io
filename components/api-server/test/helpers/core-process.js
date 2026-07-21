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
 *   CORE_PORT       — HTTP port to listen on
 *   CORE_ID         — core identifier (e.g. 'core-a')
 *   CORE_IP         — IP for this core (e.g. '127.0.0.1')
 *   DNS_DOMAIN      — domain (e.g. 'test-2core.pryv.li')
 *   RQLITE_URL      — rqlite HTTP endpoint (e.g. 'http://localhost:14001')
 *   ADMIN_KEY       — auth:adminAccessKey
 *
 * Sends IPC 'ready' message when server is listening.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const path = require('node:path');

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
  const rqliteUrl = process.env.RQLITE_URL || 'http://localhost:4001';
  const adminKey = process.env.ADMIN_KEY || 'test-admin-key';

  config.set('http:port', port);
  config.set('http:ip', '127.0.0.1');
  config.set('core:id', coreId);
  config.set('core:ip', coreIp);
  config.set('core:available', true);
  config.set('dns:domain', domain);
  config.set('auth:adminAccessKey', adminKey);
  // platform.piiMode defaults to "hashed" since 2.0.0-rc.3; multi-core child
  // cores must share the same pepper as the parent. Same fixed test pepper as
  // components/test-helpers/src/helpers-c.ts so HMAC tokens collide.
  config.set('platform:piiHmacKey', process.env.PII_HMAC_KEY || 'WLthDQK7GoYZINg7uIeWN9eANnj2BSh4zEZmRPyR5y0=');
  config.set('storages:platform:engine', 'rqlite');
  config.set('storages:engines:rqlite:url', rqliteUrl);
  config.set('dnsLess:publicUrl', `http://127.0.0.1:${port}`);
  // service:api format needed by api-endpoint.js for building apiEndpoints
  if (domain) {
    config.set('service:api', `http://{username}.${domain}/`);
  } else {
    config.set('service:api', `http://127.0.0.1:${port}/{username}/`);
  }
  config.set('service:register', `http://127.0.0.1:${port}/reg/`);
  config.set('audit:active', false);
  config.set('webhooks:inProcess', false);
  config.set('http:ssl:backloop.dev', false);
  config.set('http:ssl:keyFile', null);

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
  await require('api-server/src/methods/profile.ts').default(app.api);
  await require('api-server/src/methods/streams.ts').default(app.api);
  await require('api-server/src/methods/events.ts').default(app.api);

  // Start HTTP server
  const httpServer = http.createServer(app.expressApp);
  await new Promise((resolve, reject) => {
    httpServer.listen(port, '127.0.0.1', () => resolve());
    httpServer.once('error', reject);
  });

  // Signal ready to parent
  if (process.send) {
    process.send({ type: 'ready', port, coreId });
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
