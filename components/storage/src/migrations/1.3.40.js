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
const toString = require('utils').toString;

/**
 * v1.3.40:
 *
 * - Changes { token } and { name, type, deviceName } accesses indexes from sparse
 *    to having a partialFilter on the "deleted" field which is more performant.
 * - Reverses hack: renames deleted fields "_token", "_name", "_type", "_deviceName"
 *    to their previous names without the "_" prefix.
 */
module.exports = function (context, callback) {
  context.database.getCollection({name: 'users'}, function (err, usersCol) {
    if (err) { return callback(err); }

    usersCol.find({}).toArray(function (err, users) {
      if (err) { return callback(err); }

      async.forEachSeries(users, migrateUser, function (err) {
        if (err) { return callback(err); }

        context.logInfo('Data version is now 1.3.40');
        callback();
      });
    });
  });

  function migrateUser(user, callback) {
    context.logInfo('Migrating user ' + toString.user(user) + '...');
    async.series([
      function _updateAccessesStructure(stepDone) {
        context.database.getCollection({ name: user._id + '.accesses' }, function (err, accessesCol) {
          if (err) {
            context.logError(err, 'retrieving accesses collection');
            return stepDone(err);
          }

          accessesCol.dropIndexes(ignoreNSError.bind(null,
            context.stepCallbackFn('resetting indexes on accesses collection', stepDone)));
        });
      },
      function _updateAccessData(stepDone) {
        context.database.getCollection({ name: user._id + '.accesses' }, function (err, accessesCol) {
          if (err) {
            context.logError(err, 'retrieving accesses collection');
            return stepDone(err);
          }

          const accessesCursor = accessesCol.find();
          let completed = false;
          async.until(function () { return completed; }, migrateAccesss,
            context.stepCallbackFn('migrating accesss structure', stepDone));

          function migrateAccesss(accessDone) {
            accessesCursor.next(function (err, access) {
              if (err) { return setImmediate(accessDone.bind(null, err)); }
              if (access == null) {
                completed = true;
                return setImmediate(accessDone);
              }

              let update;
              
              if (access.deleted === undefined) {
                update = {
                  $set: {
                    deleted: null
                  }
                };
              } else {
                update = {
                  $rename: {
                    '_token': 'token',
                    '_type': 'type',
                    '_name': 'name',
                    '_deviceName': 'deviceName',
                  }
                };
              }

              accessesCol.updateOne({ _id: access._id }, update, function (err) {
                if (err) {
                  return accessDone(err);
                }
                accessDone();
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

  function ignoreNSError(callback, err) {
    if (! err || err.message.indexOf('ns not found') !== -1) {
      return callback();
    } else {
      return callback(err);
    }
  }
};
