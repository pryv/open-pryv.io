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
var async = require('async'),
  toString = require('utils').toString;

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
