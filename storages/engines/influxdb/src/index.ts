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
import type { InfluxConnection as InfluxConnectionT } from './influx_connection.ts';
const require = createRequire(import.meta.url);

const { _internals } = require('./_internals.ts');

type Logger = { debug?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
type ConfigLike = { get: (key: string) => unknown };

/**
 * Receive host internals from the barrel.
 */
function init (config: ConfigLike, getLogger: (name: string) => Logger, internals: Record<string, unknown>): void {
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
function createSeriesConnection (config: { host: string, port: number }): InfluxConnectionT {
  const { InfluxConnection } = require('./influx_connection.ts');
  return new InfluxConnection({ host: config.host, port: config.port });
}

export { init, createSeriesConnection };
