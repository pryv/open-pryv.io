/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
process.env.NODE_ENV = 'test';
process.on('unhandledRejection', unhandledRejection);
const { getLogger } = require('@pryv/boiler');
const logger = getLogger('test-helpers');
// Handles promise rejections that aren't caught somewhere. This is very useful
// for debugging.
/**
 * @returns {void}
 */
function unhandledRejection (reason, promise) {
  logger.warn(

    'Unhandled promise rejection:', promise, 'reason:', reason.stack || reason);
}
// Set up a context for spawning api-servers.
const { SpawnContext } = require('test-helpers').spawner;
const context = new SpawnContext();

after(async () => {
  await context.shutdown();
});
const storage = require('storage');
/**
 * Returns the StorageLayer instance (engine-agnostic).
 * @returns {Promise<any>}
 */
async function produceConnection () {
  return await storage.getStorageLayer();
}
/**
 * Returns the pre-initialized series connection from the storages barrel.
 * @returns {Promise<any>}
 */
async function produceSeriesConnection () {
  const storages = require('storages');
  return storages.seriesConnection;
}
module.exports = {
  context,
  produceStorageConnection: produceConnection,
  produceConnection,
  produceSeriesConnection
};
