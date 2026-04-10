/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const path = require('path');
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
      plugin: require('../../../../config/plugins/systemStreams')
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
exports.produceSeriesConnection = produceSeriesConnection;
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
exports.getTimeDelta = getTimeDelta;
// Returns the StorageLayer instance (engine-agnostic).
/**
 * @returns {Promise<any>}
 */
async function produceConnection () {
  return await storage.getStorageLayer();
}
exports.produceStorageConnection = produceConnection;
exports.produceConnection = produceConnection;
// --------------------------------------------------------- prespawning servers
logger.debug('creating new spawn context');
const spawner = testHelpers.spawner;
const spawnContext = new spawner.SpawnContext('test/support/child_process');

after(() => {
  logger.debug('shutting down spawn context');
  spawnContext.shutdown();
});

exports.spawnContext = spawnContext;
