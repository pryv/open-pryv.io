/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { InfluxConnection } = require('../src/influx_connection.ts');
const conformanceTests = require('./conformance/InfluxConnection.test').default;
const helpers = require('../../../test/helpers');

// Read host/port from config so checkouts running several influxd instances
// on offset ports don't silently hit each other's data.
const engineConfig = helpers.getEngineConfig('influxdb', require('../manifest.json'));

describe('[ICFM] InfluxConnection conformance', () => {
  conformanceTests(() => new InfluxConnection({ host: engineConfig.host, port: engineConfig.port }));
});
