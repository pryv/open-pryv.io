var async = require('async'),
    toString = require('components/utils').toString;

/**
 * v0.7.0:
 *
 * - Added deletions for events, streams & accesses, incl. update of unique index for streams
 */
module.exports = function (context, callback) {
  context.database.getCollection({name: 'users'}, function (err, usersCol) {
    if (err) { return callback(err); }

    usersCol.find({}).toArray(function (err, users) {
      if (err) { return callback(err); }

      async.forEachSeries(users, migrateUser, function (err) {
        if (err) { return callback(err); }

        context.logInfo('Data version is now 0.7.0');
        callback();
      });
    });
  });

  function migrateUser(user, callback) {
    context.logInfo('Migrating user ' + toString.user(user) + '...');
    async.series([
      function updateAccessesStructure(stepDone) {
        context.database.getCollection({name: user._id + '.accesses'}, function (err, accessesCol) {
          if (err) {
            context.logError(err, 'retrieving accesses collection');
            return stepDone(err);
          }

          accessesCol.dropIndexes(ignoreNSError.bind(null,
              context.stepCallbackFn('resetting indexes on accesses collection', stepDone)));
        });
      },
      function updateStreamsStructure(stepDone) {
        context.database.getCollection({name: user._id + '.streams'}, function (err, streamsCol) {
          if (err) {
            context.logError(err, 'retrieving streams collection');
            return stepDone(err);
          }

          streamsCol.dropIndexes(ignoreNSError.bind(null,
              context.stepCallbackFn('resetting indexes on streams collection', stepDone)));
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
