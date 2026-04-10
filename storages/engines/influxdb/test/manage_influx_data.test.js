/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');

// Tests pertaining to managing influx data - acceptance tests that actually write.

const helpers = require('../../../test/helpers');
const influx = require('influx');
const series = require('business').series;
const Repository = series.Repository;
const DataMatrix = series.DataMatrix;
const userStorage = helpers.dependencies.storage.user.events;
const accountStreams = helpers.accountStreams;
describe('[MXDB] Manage InfluxDB data (business.series.*)', function () {
  const connection = new influx.InfluxDB({
    host: '127.0.0.1'
  });
  before(async () => {
    accountStreams.init();
  });
  // TODO beforeEach delete the measurement
  it('[8GFH] should allow writing to a series', function () {
    const seriesName = 'series1';
    const repository = new Repository(connection, userStorage);
    const series = repository.get('test.manage_influx_data', seriesName);
    const toNano = (v) => v * 1000 * 1000 * 1000;
    const data = new DataMatrix(['deltaTime', 'value'], [
      [toNano(0), 10],
      [toNano(1), 20]
    ]);
    return series.then((series) => {
      return series
        .append(data)
        .then(() => series.query({ from: 0, to: 2 }))
        .then((data) => {
          assert.equal(data.length, 2);
          assert.deepEqual(data.columns, ['deltaTime', 'value']);
          assert.deepEqual(data.at(0), [0, 10]);
          assert.deepEqual(data.at(1), [1, 20]);
        });
    });
  });
});
