/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Filesystem storage engine plugin.
 *
 * Provides local filesystem-based event file attachment storage.
 * Currently delegates to existing EventLocalFiles implementation;
 * code will be physically moved here in a later cleanup phase.
 */

const _internals = require('./_internals');

/**
 * Receive host internals from the barrel.
 * @param {Object} config - Engine-specific configuration from manifest configKey
 * @param {Function} getLogger - Logger factory
 * @param {Object} internals - Map of name → value (remaining host internals)
 */
function init (config, getLogger, internals) {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- FileStorage --------------------------------------------------------

async function createFileStorage (_config, _internals) {
  const EventLocalFiles = require('./EventLocalFiles');
  return new EventLocalFiles();
}

module.exports = {
  init,
  createFileStorage
};
