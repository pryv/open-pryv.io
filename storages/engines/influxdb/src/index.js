/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * InfluxDB storage engine plugin.
 *
 * Provides the series connection backed by InfluxDB.
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

// -- SeriesStorage ----------------------------------------------------------

/**
 * @param {Object} config - { host, port } from influxdb config section
 * @returns {Object} InfluxConnection instance
 */
function createSeriesConnection (config) {
  const InfluxConnection = require('./influx_connection');
  return new InfluxConnection({ host: config.host, port: config.port });
}

module.exports = {
  init,
  createSeriesConnection
};
