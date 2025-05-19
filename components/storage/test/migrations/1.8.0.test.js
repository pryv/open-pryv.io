/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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

const SystemStreamsSerializer = require('business/src/system-streams/serializer');

const { getVersions } = require('./util');

const { getUsersLocalIndex } = require('storage');

const { platform } = require('platform');

describe('Migration - 1.8.0', function () {
  this.timeout(20000);
  let initialEventsUsers;
  let usersIndex;

  before(async function () {
    if (database.isFerret) this.skip();
    const newVersion = getVersions('1.8.0');
    await SystemStreamsSerializer.init();
    await bluebird.fromCallback(cb => testData.restoreFromDump('1.7.5', mongoFolder, cb));

    // collect users from events
    initialEventsUsers = await getInitialEventsUsers();

    // --- user Index
    usersIndex = await getUsersLocalIndex();
    await usersIndex.deleteAll();

    // --- erase platform wide db
    await platform.init();
    await platform.deleteAll();

    // perform migration
    await newVersion.migrateIfNeeded();
  });

  after(async () => {});

  it('[WBIK] must handle userIndex/events  migration from 1.7.5 to 1.8.0', async () => {
    // check that all users are migrated
    const newUsers = await usersIndex.getAllByUsername();
    for (const [username, userId] of Object.entries(initialEventsUsers)) {
      if (newUsers[username]) {
        assert.equal(newUsers[username], userId, `User ${username} migrated but with wrong id`);
      } else {
        assert.fail(`User ${userId} not migrated`);
      }
      delete initialEventsUsers[username];
    }
    assert.isEmpty(Object.keys(initialEventsUsers), 'Not all users migrated');
  });

  it('[PH6C] must handle userIndex/repository migration from 1.7.5 to 1.8.0', async () => {
    const { errors } = await usersIndex.checkIntegrity();
    assert.isEmpty(errors, 'Found error(s) in the userIndex vs events check');
  });

  it('[URHS] must handle platfrom migration from 1.7.5 to 1.8.0', async () => {
    const { errors } = await platform.checkIntegrity();
    assert.isEmpty(errors, 'Found error(s) in the platform vs Users check');
  });
});

async function getInitialEventsUsers () {
  const eventsCollection = await database.getCollection({ name: 'events' });
  const query = { streamIds: { $in: [':_system:username'] } };
  const cursor = eventsCollection.find(query, { projection: { userId: 1, content: 1 } });

  const users = {};
  while (await cursor.hasNext()) {
    const user = await cursor.next();
    users[user.content] = user.userId;
  }
  return users;
}
