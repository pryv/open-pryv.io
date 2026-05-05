/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const { Database } = require('storages/engines/mongodb/src/Database');
const { config } = require('../../../../test/helpers');

describe('[DBSE] Database', () => {
  let connectionSettings;
  let database;
  beforeEach(async () => {
    connectionSettings = structuredClone(config);
    connectionSettings.name = 'pryv-node-test';
    database = new Database(connectionSettings);
    await database.ensureConnect();
  });
  describe('[DB01] #close()', () => {
    it('[BYRG] closes the database connection', async () => {
      await database.close();
    });
  });
  describe('[DB02] Mongo duplicate errors', () => {
    const collectionInfo = {
      name: 'duplicateTest',
      indexes: [
        {
          index: { name: 1, username: 1 },
          options: { unique: true }
        }
      ]
    };
    beforeEach((done) => {
      database.insertOne(collectionInfo, { name: 'toto', username: 'mrtoto', age: 17 }, (err) => {
        done(err);
      });
    });
    afterEach((done) => {
      // Drop Collection is OK here as it's self created in this test.
      database.dropCollection(collectionInfo, (err) => {
        done(err);
      });
    });
    it('[9UBA] must detect mongo duplicate errors with isDuplicateError', (done) => {
      database.insertOne(collectionInfo, { name: 'toto', username: 'mrtoto', age: 22 }, (err) => {
        assert.ok(err != null);
        assert.strictEqual(Database.isDuplicateError(err), true);
        done();
      });
    });
    it('[W1FO] must augment mongo duplicate errors with duplicate check utilities', (done) => {
      database.insertOne(collectionInfo, { name: 'toto', username: 'mrtoto', age: 22 }, (err) => {
        assert.ok(err != null);
        // we ensure that err contains the isDuplicate boolean with assert
        const isDuplicate = err.isDuplicate;
        assert.strictEqual(typeof isDuplicate, 'boolean');
        assert.strictEqual(isDuplicate, true);
        // we ensure that err contains the isDuplicateIndex function with assert
        const isDuplicateIndex = err.isDuplicateIndex;
        assert.strictEqual(typeof isDuplicateIndex, 'function');
        assert.strictEqual(err.isDuplicateIndex('name'), true);
        assert.strictEqual(err.isDuplicateIndex('username'), true);
        assert.strictEqual(err.isDuplicateIndex('age'), false);
        done();
      });
    });
    // This helps detecting if Mongo decides to change the error message format,
    // which may break our regular expression matchings, cf. GH issue #163.
    it('[D0EN] must fail if mongo duplicate error message changed', (done) => {
      const duplicateMsg = `E11000 duplicate key error collection: ${connectionSettings.name}.${collectionInfo.name} index: name_1_username_1 dup key:`;
      database.insertOne(collectionInfo, { name: 'toto', username: 'mrtoto', age: 22 }, (err) => {
        try {
          // we ensure that err contains the string errmsg with assert
          const errMsg = err.errmsg;
          assert.strictEqual(typeof errMsg, 'string');
          assert.ok(errMsg.includes(duplicateMsg), 'Mongo duplicate error message changed!');
          done();
        } catch (err) {
          done(err);
        }
      });
    });
  });
});
