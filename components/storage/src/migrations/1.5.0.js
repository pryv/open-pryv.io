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
