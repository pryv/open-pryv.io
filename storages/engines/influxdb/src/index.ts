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

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { _internals } = require('./_internals');

/**
 * Receive host internals from the barrel.
 */
function init (config: Record<string, any>, getLogger: (name: string) => any, internals: Record<string, any>): void {
  _internals.set('config', config);
  _internals.set('getLogger', getLogger);
  for (const [key, value] of Object.entries(internals)) {
    _internals.set(key, value);
  }
}

// -- SeriesStorage ----------------------------------------------------------

/**
 * @param config — { host, port } from influxdb config section
 */
function createSeriesConnection (config: { host: string, port: number }): any {
  const { InfluxConnection } = require('./influx_connection');
  return new InfluxConnection({ host: config.host, port: config.port });
}

export { init, createSeriesConnection };
