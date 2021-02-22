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
const async = require('async');

/**
 * v1.5.0: Multiple streamIds per event
 *
 * - Changes Events.streamdId => Events.streamIds = [Events.streamdId]
 * // helpers: 
 * - find events with streamId property 
 * db.events.find({ "streamId": { $exists: true, $ne: null } }); 
 */
module.exports = function (context, callback) {
  console.log('V1.4.0 => v1.5.0 Migration started ');

  let eventCollection;
  let streamCollection;
  let eventsMigrated = 0;

  async.series([
    getEventsCollection,
    getStreamsCollection, 
    migrateEvents,
    migrateStreams,
    dropIndex,
    createIndex,
    function (done) {
      console.log('V1.4.0 => v1.5.0 Migrated ' + eventsMigrated + ' events.');
      done();
    }
  ], callback);

  function getEventsCollection(done) {
    console.log('Fetching events collection');
    context.database.getCollection({ name: 'events' }, function (err, collection) {
      eventCollection = collection;
      done(err);
    });
  }

  function getStreamsCollection(done) {
    console.log('Fetching events collection');
    context.database.getCollection({ name: 'streams' }, function (err, collection) {
      streamCollection = collection;
      done(err);
    });
  }

  function dropIndex(done) {
    console.log('Dropping previous indexes');
    eventCollection.dropIndex('userId_1_streamId_1', function () {
      done();
    });
  }

  function createIndex(done) {
    console.log('Building new indexes');
    eventCollection.createIndex({ userId: 1, streamIds: 1 }, {background: true}, done);
  }

  async function migrateEvents() {
    const cursor = await eventCollection.find({ streamId: { $exists: true, $ne: null } });
    let requests = [];
    let document;
    while (await cursor.hasNext()) {
      document = await cursor.next();
      eventsMigrated++;
      requests.push({
        'updateOne': {
          'filter': { '_id': document._id },
          'update': {
            '$set': { 'streamIds': [document.streamId] },
            '$unset': { 'streamId': ''}
          }
        }
      });

      if (requests.length === 1000) {
        //Execute per 1000 operations and re-init
        await eventCollection.bulkWrite(requests);
        console.log('Migrated ' + eventsMigrated + ' events');
        requests = [];
      }
    }

    if (requests.length > 0) {
      await eventCollection.bulkWrite(requests);
      console.log('Migrated ' + eventsMigrated + ' events');
    }
  }

  async function migrateStreams() {
    const res = await streamCollection.updateMany({ singleActivity: true }, { $unset: { singleActivity: '' }});
    console.log('Migrated', res.modifiedCount, 'streams');
  }

};
