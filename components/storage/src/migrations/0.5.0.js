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
    _ = require('lodash');

/**
 * v0.5.0:
 *
 * - Changed event `attachments` structure
 */
module.exports = function (context, callback) {
  context.database.getCollection({name: 'users'}, function (err, usersCol) {
    if (err) { return callback(err); }

    usersCol.find({}).toArray(function (err, users) {
      if (err) { return callback(err); }

      async.forEachSeries(users, migrateUser, function (err) {
        if (err) { return callback(err); }

        context.logInfo('Data version is now 0.5.0');
        callback();
      });
    });
  });

  function migrateUser(user, callback) {
    context.logInfo('Migrating user ' + toString.user(user) + '...');
    var collectionNames;
    async.series([
      function migrateEventsStructure(stepDone) {
        context.database.getCollection({name: user._id + '.events'}, function (err, eventsCol) {
          if (err) {
            context.logError(err, 'retrieving events collection');
            return stepDone(err);
          }

          var eventsCursor = eventsCol.find(),
              completed = false;
          async.until(function () { return completed; }, migrateEvent,
              context.stepCallbackFn('migrating events structure', stepDone));

          function migrateEvent(eventDone) {
            eventsCursor.nextObject(function (err, event) {
              if (err) { return setImmediate(eventDone.bind(null, err)); }
              if (! event) {
                completed = true;
                return setImmediate(eventDone);
              }

              if (! event.attachments) { return setImmediate(eventDone); }

              var newAttachments = [];
              Object.keys(event.attachments).forEach(function (key) {
                var att = event.attachments[key];
                att.id = att.fileName;
                newAttachments.push(att);
              });

              var update = {
                $set: {
                  attachments: newAttachments
                }
              };
	      eventsCol.updateOne({_id: event._id}, update, eventDone);
            });
          }
        });
      },
      function retrieveCollectionNames(stepDone) {
        context.database.db.collectionNames({namesOnly: true}, function (err, names) {
          if (err) {
            context.logError(err, 'retrieving collection names');
            return stepDone(err);
          }

          names = names.map(function (name) { return name.substr(name.indexOf('.') + 1); });
          collectionNames = _.object(names, names);
          stepDone();
        });
      },
      function renameBookmarksCollection(stepDone) {
        var colName = user._id + '.bookmarks';
        if (! collectionNames[colName]) {
          context.logInfo('Skipping bookmarks collection rename (cannot find collection)');
          return stepDone();
        }

        context.database.getCollection({name: colName}, function (err, bookmarksCol) {
          if (err) {
            context.logError(err, 'retrieving bookmarks collection');
            return stepDone(err);
          }

          bookmarksCol.rename(user._id + '.followedSlices',
              context.stepCallbackFn('renaming bookmarks collection', stepDone));
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
};
