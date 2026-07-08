/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const http = require('node:http');
const boiler = require('@pryv/boiler');
const helpers = require('../../../test/helpers');
helpers.state.config = helpers.getEngineConfig('influxdb', require('../manifest.json'));

/**
 * Gate-keeper for the InfluxDB engine tests.
 *
 * InfluxDB is an opt-in series engine — the default series engine ships without
 * an influxd daemon, so most runs (and CI) never start one. These tests talk to
 * influxd directly, so:
 *   - When InfluxDB is NOT the configured series engine, skip them entirely
 *     (they are irrelevant, and requiring a daemon would fail the whole matrix
 *     with cryptic ECONNREFUSED errors).
 *   - When InfluxDB IS the configured series engine but influxd is unreachable,
 *     fail fast with one clear, actionable message instead of N connection
 *     errors scattered across the suite.
 */
async function assertInfluxReachable (host, port) {
  await new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: '/ping', timeout: 2000 }, (res) => {
      res.resume();
      resolve();
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', (err) => reject(new Error(
      'InfluxDB is the configured series engine (storages:series:engine=influxdb) ' +
      `but influxd is not reachable at http://${host}:${port} (${err.message}). ` +
      'Start it with ./storages/engines/influxdb/scripts/start'
    )));
  });
}

before(async function () {
  const seriesEngine = boiler.getConfigUnsafe(true).get('storages:series:engine');
  if (seriesEngine !== 'influxdb') {
    this.skip();
    return;
  }
  const { host, port } = helpers.state.config;
  await assertInfluxReachable(host, port);
  await helpers.dependencies.init();
});
