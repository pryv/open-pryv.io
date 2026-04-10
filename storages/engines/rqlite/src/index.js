/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const DBrqlite = require('./DBrqlite');

let platformDB = null;

/**
 * Initialize the rqlite engine.
 * @param {Object} config - { url: 'http://localhost:4001' }
 */
function init (config) {
  platformDB = new DBrqlite(config.url);
}

/**
 * Create and return the PlatformDB instance.
 * @returns {DBrqlite}
 */
function createPlatformDB () {
  if (!platformDB) {
    platformDB = new DBrqlite();
  }
  return platformDB;
}

module.exports = {
  init,
  createPlatformDB
};
