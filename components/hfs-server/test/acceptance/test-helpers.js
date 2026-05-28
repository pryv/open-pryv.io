/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const path = require('path');

// Pre-seed per-worker env vars BEFORE boiler.init below. Mirrors the
// block in `test-helpers/src/helpers-base.ts` — hfs-server tests
// bypass that file (they call boiler.init directly) so the mirror
// needs to be replicated here. Same gates: parallel-only,
// worker-only.
if (process.env.MOCHA_PARALLEL === '1' && process.env.MOCHA_WORKER_ID != null) {
  const wid = parseInt(process.env.MOCHA_WORKER_ID, 10);
  const stride = (Number.isFinite(wid) && wid >= 0 ? wid : 0) * 10;
  process.env.storages__engines__rqlite__url = `http://localhost:${4001 + stride}`;
  process.env.tcpBroker__port = String(4222 + stride);
  process.env.storages__engines__postgresql__database = `pryv-node-test-w${wid}`;
  process.env.storages__engines__mongodb__database = `pryv-node-test-w${wid}`;
}

require('@pryv/boiler').init({
  appName: 'hfs-server-tests',
  baseFilesDir: path.resolve(__dirname, '../../../../'),
  baseConfigDir: path.resolve(__dirname, '../../../../config/'),
  extraConfigs: [
    {
      scope: 'serviceInfo',
      key: 'service',
      urlFromKey: 'serviceInfoUrl'
    },
    {
      scope: 'defaults-paths',
      file: path.resolve(__dirname, '../../../../config/plugins/paths-config.js')
    },
    {
      pluginAsync: require('../../../../config/plugins/systemStreams')
    }
  ]
});
// Test helpers for all acceptance tests.
const logger = require('@pryv/boiler').getLogger('test-helpers');
const testHelpers = require('test-helpers');
const storage = require('storage');
// Returns the pre-initialized series connection from the storages barrel.
/**
 * @returns {Promise<any>}
 */
async function produceSeriesConnection () {
  const storages = require('storages');
  return storages.seriesConnection;
}
export { produceSeriesConnection };
/**
 * Extract deltaTime in seconds from a connection.query() time field.
 * InfluxDB returns INanoDate; PG returns delta_time * 1000.
 * @param {any} time
 * @returns {number}
 */
function getTimeDelta (time) {
  if (typeof time === 'number') return time / 1000;
  return Number(time.getNanoTime()) / 1e9;
}
export { getTimeDelta };
// Returns the StorageLayer instance (engine-agnostic).
/**
 * @returns {Promise<any>}
 */
async function produceConnection () {
  return await storage.getStorageLayer();
}
const produceStorageConnection = produceConnection;
export { produceConnection, produceStorageConnection };
// --------------------------------------------------------- prespawning servers
logger.debug('creating new spawn context');
const spawner = testHelpers.spawner;
const spawnContext = new spawner.SpawnContext('test/support/child_process');

after(() => {
  logger.debug('shutting down spawn context');
  spawnContext.shutdown();
});

export { spawnContext };
