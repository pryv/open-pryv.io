/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
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
 * 
 */
var async = require('async'),
  toString = require('utils').toString,
  _ = require('lodash'),
  isDuplicateError = require('../Database').isDuplicateError;

/**
 * v0.7.1:
 *
 * - Fixes streams with parentId='' to parentId=null
 */
module.exports = function (context, callback) {
  context.database.getCollection({name: 'users'}, function (err, usersCol) {
    if (err) { return callback(err); }

    usersCol.find({}).toArray(function (err, users) {
      if (err) { return callback(err); }

      async.forEachSeries(users, migrateUser, function (err) {
        if (err) { return callback(err); }

        context.logInfo('Data version is now 0.7.1');
        callback();
      });
    });
  });

  function migrateUser(user, callback) {
    context.logInfo('Migrating user ' + toString.user(user) + '...');
    async.series([
      function updateStreamsStructure(stepDone) {
        context.database.getCollection({name: user._id + '.streams'}, function (err, streamsCol) {
          if (err) {
            context.logError(err, 'retrieving streams collection');
            return stepDone(err);
          }

          var streamsCursor = streamsCol.find(),
            completed = false;
          async.until(function () { return completed; }, migrateStreams,
            context.stepCallbackFn('migrating streams structure', stepDone));

          function migrateStreams(streamDone) {
            streamsCursor.nextObject(function (err, stream) {
              if (err) { return setImmediate(streamDone.bind(null, err)); }
              if (! stream) {
                completed = true;
                return setImmediate(streamDone);
              }

              if (stream.parentId !== '') {
                return setImmediate(streamDone);
              }

              var update = {
                $set: {
                  parentId: null
                }
              };
              streamsCol.update({_id: stream._id}, update, function (err) {
                if (err) {
                  if (isDuplicateError(err)) {
                    return updateConflictingNameRecursively(streamsCol, stream, update, streamDone);
                  } else {
                    return streamDone(err);
                  }
                }
                streamDone();
              });

            });
          }
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

  // Applies predefined update with a "-2" added to the name (recursively)
  // as long as there exist duplicate siblings
  function updateConflictingNameRecursively(streamsCol, stream, update, callback) {
    stream.name = stream.name + '-2';
    _.extend(update.$set, {name: stream.name});
    streamsCol.update({_id: stream._id}, update, function (err) {
      if (err) {
        if (isDuplicateError(err)) {
          return updateConflictingNameRecursively(streamsCol, stream, update, callback);
        } else {
          return callback(err);
        }
      }
      callback();
    });
  }
};
