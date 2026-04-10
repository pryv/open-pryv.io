/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const _ = require('lodash');
const async = require('async');

const Versions = require('storages/engines/mongodb/src/Versions');
const helpers = require('../../../../test/helpers');
const storage = helpers.dependencies.storage;
const database = storage.database;

module.exports = {
  compareIndexes,
  getVersions,
  applyPreviousIndexes
};

function compareIndexes (expected, actual) {
  expected.forEach((index) => {
    index.index = _.extend(index.index, { userId: 1 });
  });
  expected.push({ index: { userId: 1 }, options: {} });

  expected.forEach((expectedItem) => {
    let found = false;
    const expectedKeys = Object.keys(expectedItem.index);
    actual.forEach((index) => {
      const actualKeys = Object.keys(index.key);
      if ((_.difference(expectedKeys, actualKeys).length + _.difference(actualKeys, expectedKeys).length) === 0) {
        found = true;
      }
    });
    if (!found) {
      throw new Error('Index expected not found:' + JSON.stringify(expectedItem));
    }
  });
}

function getVersions (/* migration1Id, migration2Id, ... */) {
  const pickArgs = [].slice.call(arguments);
  pickArgs.unshift(helpers.migrations);
  const pickedMigrations = _.pick.apply(_, pickArgs);
  return new Versions(database,
    helpers.getLogger('versions'),
    pickedMigrations);
}

function applyPreviousIndexes (collectionName, indexes, callback) {
  async.forEachSeries(indexes, ensureIndex, function (err) {
    if (err) { return callback(err); }
    database.initializedCollections[collectionName] = true;
    callback();
  });

  function ensureIndex (item, itemCallback) {
    database.db.collection(collectionName)
      .createIndex(item.index, item.options, itemCallback);
  }
}
