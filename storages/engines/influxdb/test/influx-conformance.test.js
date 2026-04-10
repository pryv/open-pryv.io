/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const InfluxConnection = require('../src/influx_connection');
const conformanceTests = require('./conformance/InfluxConnection.test');

describe('[ICFM] InfluxConnection conformance', () => {
  conformanceTests(() => new InfluxConnection({ host: '127.0.0.1' }));
});
