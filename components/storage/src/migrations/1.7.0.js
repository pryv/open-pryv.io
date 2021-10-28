/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
const bluebird = require('bluebird');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const { UsersRepository, getUsersRepository, User } = require('business/src/users');

const { getLogger } = require('@pryv/boiler');
const { TAG_ROOT_STREAMID, TAG_PREFIX }: { TAG_ROOT_STREAMID: string, TAG_PREFIX: string } = require('api-server/src/methods/helpers/backwardCompatibility');
const DOT: string = '.';
/**
 * v1.7.0: 
 * - refactor streamId prefixes from '.' to ':_system:' and ':system'
 * - remove XX__unique properties from all events containing '.unique'
 * 
 * - remove tags and set them as "root streams" with the prefix "tag-"
 */
module.exports = async function (context, callback) {

  const logger = getLogger('migration-1.7.0');
  logger.info('V1.6.21 => v1.7.0 Migration started');

  const uniqueProperties: Array<string> = SystemStreamsSerializer.getUniqueAccountStreamsIdsWithoutPrefix();
  const uniquePropertiesToDelete: Array<string> = uniqueProperties.map(s => s + '__unique');
  const newSystemStreamIds: Array<string> = SystemStreamsSerializer.getAllSystemStreamsIds();
  const oldToNewStreamIdsMap: Map<string, string> = buildOldToNewStreamIdsMap(newSystemStreamIds);
  const eventsCollection = await bluebird.fromCallback(cb =>
    context.database.getCollection({ name: 'events' }, cb));
  const streamsCollection = await bluebird.fromCallback(cb =>
    context.database.getCollection({ name: 'streams' }, cb));
  const accessesCollection = await bluebird.fromCallback(cb =>
    context.database.getCollection({ name: 'accesses' }, cb));
  const userEventsStorage = new (require('../user/Events'))(context.database);
  
  await migrateAccounts(eventsCollection);
  await migrateTags(eventsCollection, streamsCollection);
  await migrateTagsAccesses(accessesCollection);

  logger.info('Accounts were migrated, now rebuilding the indexes');
  await rebuildIndexes(context.database, eventsCollection, userEventsStorage.getCollectionInfoWithoutUserId()),
  logger.info('V1.6.21 => v1.7.0 Migration finished');
  callback();


  async function migrateAccounts (eventsCollection): Promise<void> {
    const usernameCursor = await eventsCollection.find({ 
      streamIds: { $in: ['.username'] },
      deleted: null,
      headId: null,
    });

    let usersCounter: number = 0;
    while (await usernameCursor.hasNext()) {
      const usernameEvent = await usernameCursor.next();
      if (usersCounter % 200 === 0) {
        logger.info(`Migrating ${usersCounter + 1}st user`);
      }
      usersCounter++;
      await migrateUserEvents(usernameEvent, eventsCollection, oldToNewStreamIdsMap);
    }
  }


  async function migrateUserEvents(usernameEvent: {}, eventsCollection: {}, oldToNewStreamIdsMap: Map<string, string>, newSystemStreamIds: Array<string>): Promise<void> {
    const eventsCursor: {} = eventsCollection.find({ userId: usernameEvent.userId });
    const BUFFER_SIZE: number = 500;
    let requests: Array<{}> = [];
    while (await eventsCursor.hasNext()) {
      let event: Event = await eventsCursor.next();

      if (! isSystemEvent(event)) continue;

      const streamIds: Array<string> = translateStreamIdsIfNeeded(event.streamIds, oldToNewStreamIdsMap);

      const request = {
        updateOne: {
          filter: { '_id': event._id },
          update: {
            $set: { streamIds },
          }
        }
      }
      if (isUniqueEvent(event.streamIds)) request.updateOne.update['$unset'] = buildUniquePropsToDelete(event);

      //console.log('translated to', JSON.stringify(request,null,2));
      requests.push(request);
      if (requests.length > BUFFER_SIZE) requests = await flushToDb(requests, eventsCollection);
    }
    if (requests.length > 1) await flushToDb(requests, eventsCollection);

    function isUniqueEvent(streamIds: Array<string>): boolean {
      if (streamIds.indexOf('.unique') > -1) return true;
      return false;
    }

    function buildUniquePropsToDelete(event) {
      const unsets = {};
      for (const prop of uniquePropertiesToDelete) {
        if (event[prop] != null) unsets[prop] = 1;
      }
      return unsets;
    }

    function isSystemEvent(event: Event): boolean {
      if (event.streamIds == null) return false; // if event is deleted
      for (const streamId of event.streamIds) {
        if (streamId.startsWith('.')) return true; // can't use new check because it doesn't work with DOT anymore
      }
      return false;
    }

    async function flushToDb(events: Array<{}>, eventsCollection: {}): Promise<Array<{}>> {
      const result: {} = await eventsCollection.bulkWrite(events);
      logger.info(`flushed ${result.nModified} modifications into database`);
      return [];
    }

    function translateStreamIdsIfNeeded(streamIds: Array<string>, oldToNewMap: Map<string, string>): Array<string> {
      const translatedStreamIds: Array<string> = [];
      for (const streamId of streamIds) {
        translatedStreamIds.push(translateToNewOrNothing(streamId, oldToNewMap));
      }
      return translatedStreamIds;

      function translateToNewOrNothing(oldStreamId: string, oldToNewMap: Map<string, string>): string {
        return oldToNewMap[oldStreamId] ? oldToNewMap[oldStreamId] : oldStreamId;
      }
    }
  }

  function buildOldToNewStreamIdsMap(newSystemStreamIds: Array<string>): Map<string, string> {
    const oldToNewMap: {} = {};
    for (const newStreamId of newSystemStreamIds) {
      const oldStreamId: string = translateToOldPrefix(newStreamId);
      oldToNewMap[oldStreamId] = newStreamId;
    }
    return oldToNewMap;

    function translateToOldPrefix(streamId: string): string {
      return DOT + SystemStreamsSerializer.removePrefixFromStreamId(streamId);
    }
  }

  async function rebuildIndexes(database, eventsCollection, collectionInfo): Promise<void> {
    const indexCursor = await eventsCollection.listIndexes();
    while (await indexCursor.hasNext()) {
      const index = await indexCursor.next();
      if (index.name.endsWith('__unique_1')) {
        logger.info('dropping index', index.name);
        await eventsCollection.dropIndex(index.name);
      }
    }
  }

  //----------------- TAGS 

  
  async function migrateTags(eventsCollection, streamsCollection): Promise<void> { 
    
    const storageLayer = await require('storage').getStorageLayer();
    // get all users with tags 
    const usersWithTag = await eventsCollection.distinct('userId', {tags: { $exists: true, $ne: null }});
    for (userId of usersWithTag) {
      const now = Date.now() / 1000; 

      async function createStream(id, name, parentId) {
        try { 
          await bluebird.fromCallback(cb => storageLayer.streams.insertOne({id: userId}, {name: name, id: id, parentId: parentId, modifiedBy: 'migration', createdBy: 'migration', created: now, modified: now}, cb));
        } catch (e) {
          if (e.code !== 11000) throw(e)// already exists.. oK
        }
      }

      // create root stream
      await createStream(TAG_ROOT_STREAMID, 'Migrated Tags')
      // get all tags for user
      const tags = await eventsCollection.distinct('tags', {userId: userId});
      for (tag of tags) { 
        await createStream(TAG_PREFIX + tag, tag, TAG_ROOT_STREAMID);
        await migrateEvents(userId);
      }
      // migrate tags (add to streams for each event)
    }
  
    async function migrateEvents(userId) {
      eventsMigrated = 0;
      const cursor = await eventsCollection.find({ userId: userId, tags: { $exists: true, $ne: [] } });
      let requests = [];
      let event;
      while (await cursor.hasNext()) {
        event = await cursor.next();
        if (event.tags == null) continue;
        const newStreams = event.tags.filter(t => t != null).map(t => TAG_PREFIX + t);

        eventsMigrated++;
        requests.push({
          'updateOne': {
            'filter': { '_id': event._id },
            'update': {
              '$addToSet': { 'streamIds': { $each: newStreams }},
              '$unset': { 'tags': ''}
            }
          }
        });

        if (requests.length === 1000) {
          //Execute per 1000 operations and re-init
          await eventsCollection.bulkWrite(requests);
          console.log('Migrated ' + eventsMigrated + ' events for user ' + userId);
          requests = [];
        }
      }

      if (requests.length > 0) {
        await eventsCollection.bulkWrite(requests);
        console.log('Migrated ' + eventsMigrated + ' events for user ' + userId);
      }
    }
  }

  async function migrateTagsAccesses(accessesCollection): Promise<void> {
    console.log('a')
    const cursor = await accessesCollection.find({ 'permissions.tag': { $exists: true} });
    let requests = [];
    let accessesMigrated = 0;
    while (await cursor.hasNext()) {
      const access = await cursor.next();
      const newPermissions = [];
      const forcedStreams = [];
      for (const permission of access.permissions) {
        if (permission.tag == null) {
          newPermissions.push(permission);
          continue;
        }
        if (permission.level !== 'read') {
          const msg = 'Warning cannot migrate fully ' + JSON.stringify(permission) +' accessId: ' + access._id + ' userId: ' + access.userId;
          console.log(msg);
          //process.exit(0);
        }
        forcedStreams.push(TAG_PREFIX + permission.tag);
      }
      newPermissions.push({feature: 'forcedStreams', streams: forcedStreams});

      accessesMigrated++;
      requests.push({
        'updateOne': {
          'filter': { '_id': access._id },
          'update': {
            $set: { permissions: newPermissions }
          }
        }
      });
      
      if (requests.length === 1000) {
        //Execute per 1000 operations and re-init
        await accessesCollection.bulkWrite(requests);
        console.log('Migrated ' + accessesMigrated + ' accesses for user ' + userId);
        requests = [];
      }
    }
    if (requests.length > 0) {
      await accessesCollection.bulkWrite(requests);
      console.log('Migrated ' + accessesMigrated + ' accesses for user ' + userId);
    }
  }


};
