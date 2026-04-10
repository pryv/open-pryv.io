/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

'use strict';

// Tests pertaining to storing data in a hf series.

const series = require('business').series;
const userStorage = require('test-helpers').dependencies.storage.user.events;
const Repository = series.Repository;
const DataMatrix = series.DataMatrix;

describe('[SREP] business.series.Repository', function () {
  describe('[SR01] with stubbed out connection', function () {
    const namespace = 'pryv-userdb.USER_ID'; // influx database
    const seriesName = 'event.EVENT_ID'; // influx measurement
    const data = new DataMatrix(['deltaTime', 'a', 'b'], [[0, 1, 2]]);
    // A test double for the actual connection:
    const influxConnection = {
      createDatabase: () => Promise.resolve(true),
      writeMeasurement: () => Promise.resolve(true),
      dropMeasurement: () => Promise.resolve(true)
    };
    it('[0UEA] should produce series objects for events', function () {
      const repository = new Repository(influxConnection, userStorage);
      const series = repository.get(namespace, seriesName);
      return series.then((series) => series.append(data));
    });
  });
});
