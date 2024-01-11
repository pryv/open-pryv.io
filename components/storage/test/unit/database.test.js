/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

const chai = require('chai');
const assert = chai.assert;
const Database = require('../../src/Database');

describe('Database', () => {
  const connectionSettings = {
    host: '127.0.0.1',
    port: 27017,
    name: 'pryv-node-test'
  };
  let database;
  beforeEach(async () => {
    database = new Database(connectionSettings);
    await database.ensureConnect();
  });
  describe('#close()', () => {
    it('[BYRG] closes the database connection', async () => {
      await database.close();
    });
  });
  describe('Mongo duplicate errors', () => {
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
      database.dropCollection(collectionInfo, (err) => {
        done(err);
      });
    });
    it('[9UBA] must detect mongo duplicate errors with isDuplicateError', (done) => {
      database.insertOne(collectionInfo, { name: 'toto', username: 'mrtoto', age: 22 }, (err) => {
        assert.isNotNull(err);
        assert.isTrue(Database.isDuplicateError(err));
        done();
      });
    });
    it('[W1FO] must augment mongo duplicate errors with duplicate check utilities', (done) => {
      database.insertOne(collectionInfo, { name: 'toto', username: 'mrtoto', age: 22 }, (err) => {
        assert.isNotNull(err);
        // we ensure that err contains the isDuplicate boolean with assert
        const isDuplicate = err.isDuplicate;
        assert.isBoolean(isDuplicate);
        assert.isTrue(isDuplicate);
        // we ensure that err contains the isDuplicateIndex function with assert
        const isDuplicateIndex = err.isDuplicateIndex;
        assert.isFunction(isDuplicateIndex);
        assert.isTrue(isDuplicateIndex('name'));
        assert.isTrue(isDuplicateIndex('username'));
        assert.isFalse(isDuplicateIndex('age'));
        done();
      });
    });
    // This helps detecting if Mongo decides to change the error message format,
    // which may break our regular expression matchings, cf. GH issue #163.
    it('[D0EN] must fail if mongo duplicate error message changed', (done) => {
      const duplicateMsg = `E11000 duplicate key error collection: ${connectionSettings.name}.${collectionInfo.name} index: name_1_username_1 dup key:`;
      database.insertOne(collectionInfo, { name: 'toto', username: 'mrtoto', age: 22 }, (err) => {
        // we ensure that err contains the string errmsg with assert
        const errMsg = err.errmsg;
        assert.isString(errMsg);
        assert.include(errMsg, duplicateMsg, 'Mongo duplicate error message changed!');
        done();
      });
    });
  });
});
