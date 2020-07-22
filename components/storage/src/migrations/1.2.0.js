var async = require('async'),
  toString = require('components/utils').toString;

/**
 * v1.2.0:
 *
 * - Removes 'deleted' index on Events, Streams and Accesses collections.
 *   This index was previously used to remove entries from the database
 *   after a defined expiration duration
 */
module.exports = function (context, callback) {
  context.database.getCollection({name: 'users'}, function (err, usersCol) {
    if (err) { return callback(err); }

    usersCol.find({}).toArray(function (err, users) {
      if (err) { return callback(err); }

      async.forEachSeries(users, migrateUser, function (err) {
        if (err) { return callback(err); }

        context.logInfo('Data version is now 1.2.0');
        callback();
      });
    });
  });

  const DELETED_INDEX_NAME = 'deleted_1';

  function migrateUser(user, callback) {
    context.logInfo('Migrating user ' + toString.user(user) + '...');
    async.series([
      function removeIndexFromEvents (stepDone) {
        context.database.getCollection({name: user._id + '.events'}, function (err, eventsCol) {
          if (err) {
            context.logError(err, 'retrieving events');
            return stepDone(err);
          }
          eventsCol.dropIndex(DELETED_INDEX_NAME, ignoreNSError.bind(null,
            context.stepCallbackFn('removing deleted index on events collection', stepDone)));
          });
      },
      function removeIndexFromStreams (stepDone) {
        context.database.getCollection({name: user._id + '.streams'}, function (err, streamsCol) {
          if (err) {
            context.logError(err, 'retrieving streams');
            return stepDone(err);
          }
          streamsCol.dropIndex(DELETED_INDEX_NAME, ignoreNSError.bind(null,
            context.stepCallbackFn('removing deleted index on streams collection', stepDone)));
        });
      },
      function removeIndexFromAccesses (stepDone) {
        context.database.getCollection({name: user._id + '.accesses'}, function (err, accessesCol) {
          if (err) {
            context.logError(err, 'retrieving accesses');
            return stepDone(err);
          }
          accessesCol.dropIndex(DELETED_INDEX_NAME, ignoreNSError.bind(null,
            context.stepCallbackFn('removing deleted index on accesses collection', stepDone)));
        });
      }
    ], function (err) {
      if (err) {
        context.logError(err, 'migrating user');
        return callback(err);
      }
      context.logInfo('Successfully migrated user ' + toString.user(user) + '.');
      callback();
    });
  }

  function ignoreNSError(callback, err) {
    if (! err || err.message.indexOf('ns not found') !== -1) {
      return callback();
    } else {
      return callback(err);
    }
  }
};
