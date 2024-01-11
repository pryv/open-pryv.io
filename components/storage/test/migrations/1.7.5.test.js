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

/**
 * Tests data migration between versions.
 */

/* global assert */

const bluebird = require('bluebird');
const helpers = require('test-helpers');
const storage = helpers.dependencies.storage;
const database = storage.database;
const testData = helpers.data;

const mongoFolder = __dirname + '../../../../../var-pryv/mongodb-bin';

const { getVersions } = require('./util');

describe('Migration - 1.7.5', function () {
  this.timeout(20000);

  let accessesCollection;

  before(async function () {
    accessesCollection = await database.getCollection({ name: 'accesses' });
  });

  after(async function () {
    // erase all
    await accessesCollection.deleteMany({});
  });

  it('[MA7J] must handle data migration from 1.7.1 to 1.7.5', async function () {
    const newVersion = getVersions('1.7.5');

    await bluebird.fromCallback(cb => testData.restoreFromDump('1.7.1', mongoFolder, cb));

    // verify accesses afterwards
    const previousAccessesWithSystemStreamPermissions = await accessesCollection.find({ 'permissions.streamId': { $regex: /^\./ } }).toArray();
    const accessToCheck = previousAccessesWithSystemStreamPermissions[0];
    // perform migration
    await newVersion.migrateIfNeeded();

    // verify that accesses were migrated
    let isAccessToCheckProcessed = false;

    const accesses = await accessesCollection.find({}).toArray();
    for (const access of accesses) {
      if (access.type === 'personal') continue;
      if (access._id === accessToCheck._id) isAccessToCheckProcessed = true;
      for (const permission of access.permissions) {
        if (permission.streamId != null) {
          assert.isFalse(hasDotStreamId(permission.streamId));
        }
      }
    }
    assert.isTrue(isAccessToCheckProcessed);

    function hasDotStreamId (streamId) {
      return streamId.indexOf('.') > -1;
    }
  });
});
