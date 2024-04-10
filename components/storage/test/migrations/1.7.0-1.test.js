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
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const { TAG_ROOT_STREAMID, TAG_PREFIX } = require('api-server/src/methods/helpers/backwardCompatibility');
const DOT = '.';
const mongoFolder = __dirname + '../../../../../var-pryv/mongodb-bin';

const { getVersions, compareIndexes } = require('./util');

describe('Migration - 1.7.x', function () {
  this.timeout(20000);

  let eventsCollection;
  let usersCollection;
  let streamsCollection;
  let accessesCollection;
  let webhooksCollection;

  before(async function () {
    if (database.isFerret) this.skip();
    eventsCollection = await database.getCollection({ name: 'events' });
    usersCollection = await database.getCollection({ name: 'users' });
    streamsCollection = await database.getCollection({ name: 'streams' });
    accessesCollection = await database.getCollection({ name: 'accesses' });
    webhooksCollection = await database.getCollection({ name: 'webhooks' });
  });

  after(async function () {
    if (database.isFerret) return;
    // erase all
    await eventsCollection.deleteMany({});
    await accessesCollection.deleteMany({});
  });

  it('[V8JR] must handle data migration from 1.6.21 to 1.7.1', async function () {
    const versions0 = getVersions('1.7.0');
    const versions1 = getVersions('1.7.1');
    const newIndexes = testData.getStructure('1.7.0').indexes;

    await bluebird.fromCallback(cb => testData.restoreFromDump('1.6.21', mongoFolder, cb));

    // get backup of users
    const usersCursor = usersCollection.find({});
    const users = await usersCursor.toArray();

    // for tags keeps info on existings tags & events
    const previousEventsWithTags = await eventsCollection.find({ tags: { $exists: true, $ne: [] } }).toArray();
    const previousAccessesWithTags = await accessesCollection.find({ 'permissions.tag': { $exists: true } }).toArray();

    // deleted
    const collectionsWithDelete = [eventsCollection, accessesCollection, streamsCollection, webhooksCollection];
    const previousItemsWithDelete = {};
    for (const collection of collectionsWithDelete) {
      previousItemsWithDelete[collection.namespace] = await collection.find({ deleted: { $type: 'date' } }).toArray();
    }

    // perform migration
    await versions0.migrateIfNeeded();
    await versions1.migrateIfNeeded();
    // verify that user accounts were migrated to events
    for (const user of users) {
      // we must verify that all system streamIds were translated to another prefix
      const eventsCursor = eventsCollection.find({
        // streamIds: {$in: userAccountStreamIds},
        userId: { $eq: user._id }
      });

      const events = await eventsCursor.toArray();

      const uniqueProperties = SystemStreamsSerializer.getUniqueAccountStreamsIdsWithoutPrefix();
      const UNIQUE_SUFFIX = '__unique';

      for (const event of events) {
        for (const streamId of event.streamIds) {
          assert.isFalse(streamId.startsWith(DOT), `streamId ${streamId} of event ${event} starts with a dot when it should not.`);
        }
        for (const uniqueProp of uniqueProperties) {
          assert.notExists(event[uniqueProp + UNIQUE_SUFFIX], 'unique property ');
        }
      }
    }

    const migratedIndexes = await bluebird.fromCallback(cb => eventsCollection.listIndexes({}).toArray(cb));
    compareIndexes(newIndexes.events, migratedIndexes);

    // ----------------- tag migrations
    const eventsWithTags = await eventsCollection.find({ tags: { $exists: true, $ne: [] } }).toArray();
    assert.equal(eventsWithTags.length, 0);
    for (const event of previousEventsWithTags) {
      const newEvent = await eventsCollection.findOne({ _id: event._id });
      // check if tags have been added to streamIds
      for (const tag of event.tags) {
        assert.include(newEvent.streamIds, TAG_PREFIX + tag);
        // check if stream exists for this user
        const stream = await streamsCollection.findOne({ userId: event.userId, streamId: TAG_PREFIX + tag });
        assert.exists(stream);
        assert.equal(stream.parentId, TAG_ROOT_STREAMID);
      }
    }

    // -- permissions
    const permissionsWithTags = await accessesCollection.find({ 'permissions.tag': { $exists: true } }).toArray();
    assert.equal(permissionsWithTags.length, 0);

    for (const previousAccess of previousAccessesWithTags) {
      const newAccess = await accessesCollection.findOne({ _id: previousAccess._id });
      const forcedStreamsPerms = newAccess.permissions.filter(p => (p.feature && p.feature === 'forcedStreams'));
      assert.equal(forcedStreamsPerms.length, 1);
      const forcedStreams = forcedStreamsPerms[0].streams;
      assert.isAbove(forcedStreams.length, 0);
      for (const permission of previousAccess.permissions) {
        if (permission.tag) { assert.include(forcedStreams, TAG_PREFIX + permission.tag); }
      }
    }

    // -----------------  deleted  migrations

    for (const collection of collectionsWithDelete) {
      const newItems = await collection.find({ deleted: { $type: 'date' } }).toArray();
      assert.equal(newItems.length, 0, collection.namespace + ' should have no item with deleted dates');

      for (const previousItem of previousItemsWithDelete[collection.namespace]) {
        const newItem = await collection.findOne({ _id: previousItem._id });
        assert.equal(newItem.deleted, previousItem.deleted.getTime() / 1000);
      }
    }
  });
});
