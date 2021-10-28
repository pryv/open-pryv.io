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
const BaseStorage = require('./BaseStorage');
const converters = require('./../converters');
const timestamp = require('unix-timestamp');
const util = require('util');
const _ = require('lodash');
const ApplyEventsFromDbStream = require('./../ApplyEventsFromDbStream');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const integrity = require('business/src/integrity');
const logger = require('@pryv/boiler').getLogger('storage:events');

module.exports = Events;
/**
 * DB persistence for events.
 *
 * Note: period events are stored with both `duration` (exposed publicly) and `endTime`.
 * `endTime` is a computed (`time` + `duration`), storage-only field absent from retrieved events.
 * Callers can (and should) make use of `endTime` to simplify and optimize their "find" queries.
 *
 * @param {Database} database
 * @constructor
 */
function Events (database) {
  Events.super_.call(this, database);

  SystemStreamsSerializer.getSerializer(); // TODO remove to load it correctly in tests

  _.extend(this.converters, {
    itemDefaults: [converters.createIdIfMissing],
    itemToDB: [
      durationToEndTime,
      converters.deletionToDB,
      converters.stateToDB,
      addIntegrity,
    ],
    itemsToDB: [
      function (items) { 
        if (items == null) return null;  
        const res = items.map(e => addIntegrity(converters.stateToDB(converters.deletionToDB(durationToEndTime(e))))); 
        return res;
      }
    ],
    updateToDB: [
      endTimeUpdate,
      converters.stateUpdate,
      converters.getKeyValueSetUpdateFn('clientData'),
    ],
    itemFromDB: [
      endTimeToDuration,
      converters.deletionFromDB,
    ],
    itemsFromDB: [
      function (items) { 
        if (items == null) return null;  
        const res = items.map(e => converters.deletionFromDB(endTimeToDuration(e))); 
        return res;
      }
    ],
  });

  this.defaultOptions = {
    sort: { time: -1 },
  };
}
util.inherits(Events, BaseStorage);

function addIntegrity (eventData) {
  if (! integrity.events.isActive) return eventData;
  integrity.events.set(eventData); 
  return eventData;
}

function durationToEndTime (eventData) {
  if (eventData.endTime !== undefined ) {
    //console.log('endTime should no be defined ', {id: eventData.id, endTime: eventData.endTime, duration: eventData.duration});
    return eventData;
  }
  if (eventData.duration === null) { // exactly null 
    eventData.endTime = null;
  } else if (eventData.duration === undefined) { // (no undefined)
    // event.time is not defined for deleted events
    if (eventData.time != null) eventData.endTime = eventData.time;
  } else { // defined
    eventData.endTime = eventData.time + eventData.duration;
  }
  delete eventData.duration;
  return eventData;
}


function endTimeUpdate (update) {
  if (update.$set) {
    if (update.$set.duration === null) {
      update.$set.endTime = null;
    } else if (update.$set.duration != null) { // (no undefined)
      if (update.$set.time == null) {
        throw (new Error('Cannot update duration without known the time' + JSON.stringify(update)));
      }
      update.$set.endTime = update.$set.time + update.$set.duration;
    }
    delete update.$set.duration ;
  }
  return update;
}

function endTimeToDuration (event) {
  if (event == null) {
    return event;
  }
  if (event.endTime === null) {
    event.duration = null;
  } else if (event.endTime !== undefined) {
    const prevDuration = event.duration;
    event.duration = event.endTime - event.time;
    if (prevDuration != null && prevDuration != event.duration) {
      console.log('What !! ', new Error('Duration issue.. This should not thappen'));
    }
  }
  delete event.endTime;
  // force duration property undefined if 0
  if (event.duration === 0) { delete event.duration; }
  return event;
}

function getDbIndexes () {
  // TODO: review indexes against 1) real usage and 2) how Mongo actually uses them
  const indexes = [
    {
      index: { time: 1 },
      options: {},
    },
    {
      index: { streamIds: 1 },
      options: {},
    },
    {
      index: { tags: 1 },
      options: {},
    },
    {
      index: {integrityBatchCode: 1},
      options: {},
    },
    // no index by content until we have more actual usage feedback
    {
      index: { trashed: 1 },
      options: {},
    },
    {
      index: { modified: 1 },
      options: {},
    },
    {
      index: { endTime: 1 },
      options: { partialFilterExpression: { endTime: { $exists: true } } },
    }
  ];
  return indexes;
}


/**
 * Finds and updates atomically a single document matching the given query,
 * returning the updated document.
 * @param user
 * @param query
 * @param updatedData
 * @param callback
 */
Events.prototype.updateOne = function (userOrUserId, query, update, callback) {
  const that = this;

  // unset eventually existing integrity field. Unless integrity is in set request
  if (update.integrity == null && update.$set?.integrity == null) {
    if (! update.$unset) update.$unset = {};
    update.$unset.integrity = 1;
  }

  let cb = callback;
  if (integrity.events.isActive) {
    cb = function callbackIntegrity(err, eventData) {
      if (err || (eventData?.id == null)) return callback(err, eventData);
  
      const integrityCheck = eventData.integrity;
      try { 
        integrity.events.set(eventData, true);
      } catch (errIntegrity) {
        return callback(errIntegrity, eventData);
      }
      // only update if there is a mismatch of integrity
      if (integrityCheck != eventData.integrity) {
        // could be optimized by using "updateOne" instead of findOne and update
        return Events.super_.prototype.findOneAndUpdate.call(that, userOrUserId, {_id: eventData.id}, {integrity: eventData.integrity}, callback);
      } 
      callback(err, eventData);
    }
  }
  Events.super_.prototype.findOneAndUpdate.call(this, userOrUserId, query, update, cb);
};



/**
 * Updates the one or multiple document(s) matching the given query.
 *
 * @param user
 * @param query
 * @param update
 * @param callback
*/
Events.prototype.updateMany = function (userOrUserId, query, update, callback) {
  const finalCallBack = getResetIntegrity(this, userOrUserId, update, callback);;
  Events.super_.prototype.updateMany.call(this, userOrUserId, query, update, finalCallBack);
};

/**
 * Implementation.
 */
Events.prototype.getCollectionInfo = function (userOrUserId) {
  const userId = this.getUserIdFromUserOrUserId(userOrUserId);
  return {
    name: 'events',
    indexes: getDbIndexes(),
    useUserId: userId
  };
};

Events.prototype.getCollectionInfoWithoutUserId = function () {
  return {
    name: 'events',
    indexes: getDbIndexes()
  };
};

/**
 * Implementation
 */
Events.prototype.findStreamed = function (userOrUserId, query, options, callback) {
  query.deleted = null;
  // Ignore history of events for normal find.
  query.headId = null;

  this.database.findStreamed(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    this.applyOptionsToDB(options),
    function (err, dbStreamedItems) {
      if (err) {
        return callback(err);
      }
      callback(null,
        dbStreamedItems
          .pipe(new ApplyEventsFromDbStream(this.converters.itemFromDB))
      );
    }.bind(this)
  );
};

/**
 * Implementation
 */
Events.prototype.findHistory = function (userOrUserId, headId, options, callback) {
  this.database.find(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB({ headId: headId }),
    this.applyOptionsToDB(options),
    function (err, dbItems) {
      if (err) {
        return callback(err);
      }
      callback(null, this.applyItemsFromDB(dbItems));
    }.bind(this)
  );
};

/**
 * Implementation
 */
Events.prototype.findDeletionsStreamed = function (
  userOrUserId,
  deletedSince,
  options,
  callback
) {
  var query = { deleted: { $gt: deletedSince } };
  this.database.findStreamed(
    this.getCollectionInfo(userOrUserId),
    query,
    this.applyOptionsToDB(options),
    function (err, dbStreamedItems) {
      if (err) {
        return callback(err);
      }
      callback(null, dbStreamedItems.pipe(new ApplyEventsFromDbStream(this.converters.itemFromDB)));
    }.bind(this)
  );
};

Events.prototype.countAll = function (user, callback) {
  this.count(user, {}, callback);
};

/**
 * Implementation
 */
Events.prototype.minimizeEventsHistory = function (userOrUserId, headId, callback) {
  var update = {
    $unset: {
      streamIds: 1,
      time: 1,
      duration: 1,
      endTime: 1,
      type: 1,
      content: 1,
      tags: 1,
      description: 1,
      attachments: 1,
      clientData: 1,
      trashed: 1,
      created: 1,
      createdBy: 1,
      integrity: 1
    },
  };

  // if integrity for events in "ON" add extra check step after update
  const query = { headId: headId };
  let finalCallBack = getResetIntegrity(this, userOrUserId, update, callback);
  this.database.updateMany(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    update,
    finalCallBack
  );
};

/* jshint -W024 */
/**
 * Implementation.
 */
Events.prototype.delete = function (userOrUserId, query, deletionMode, callback) {
  // default
  var update = {
    $set: { deleted: Date.now() / 1000 },
  };

  switch (deletionMode) {
    case 'keep-nothing':
      update.$unset = {
        streamIds: 1,
        time: 1,
        duration: 1,
        endTime: 1,
        type: 1,
        content: 1,
        tags: 1,
        description: 1,
        attachments: 1,
        clientData: 1,
        trashed: 1,
        created: 1,
        createdBy: 1,
        modified: 1,
        modifiedBy: 1,
        integrity: 1,
      };
      break;
    case 'keep-authors':
      update.$unset = {
        streamIds: 1,
        time: 1,
        duration: 1,
        endTime: 1,
        type: 1,
        content: 1,
        tags: 1,
        description: 1,
        attachments: 1,
        clientData: 1,
        trashed: 1,
        created: 1,
        createdBy: 1,
        integrity: 1
      };
      break;
    default: // keep everything
      update.$unset = {
        integrity: 1,
      }
      break;
  }
  // if integrity for events in "ON" add extra check step after update
  const finalCallBack = getResetIntegrity(this, userOrUserId, update, callback);
  this.database.updateMany(
    this.getCollectionInfo(userOrUserId),
    this.applyQueryToDB(query),
    update,
    finalCallBack
  );
};

/**
 * - Allways unset 'integrity' of updated events by modifiying update query
 * - If integrity is active for event returns a callBack to be exectued at after the update
 * @param {Events} eventStore 
 * @param {User | userId} userOrUserId 
 * @param {Object} upddate -- the update query to be modified
 * @param {*} callback 
 * @returns either the original callback or a process to reset events' integrity
 */
function getResetIntegrity(eventStore, userOrUserId, update, callback) {
  // anyway remove any integrity that might have existed
  if (! update.$unset) update.$unset = {};
  update.$unset.integrity = 1;

  // not active return the normal callback
  if (! integrity.events.isActive) return callback;

  // add a random "code" to the original update find out which events have been modified
  const integrityBatchCode = Math.random();
  // hard coded cases when syntax changes .. to be evaluated 
  if(update['streamIds.$'] != null || update.$pull != null) {
    update.integrityBatchCode = integrityBatchCode;
  } else {
    if (update.$set == null) update.$set = {};
    update.$set.integrityBatchCode = integrityBatchCode;
  }

  // return a callback that will be executed after the update
  return function(err, res) {
    if (err) return callback(err);
    const initialModifiedCount = res.modifiedCount;

    // will be called for each updated item
    // we should remove the "integrityBatchCode" that helped finding them out 
    // and add the integrity value
    function updateIfNeeded(event) {
      delete event.integrityBatchCode; // remove integrity batch code for computation
      const previousIntegrity = event.integrity;
      integrity.events.set(event, true);
      if (previousIntegrity == event.integrity) return null;
      return {
        $unset: { integrityBatchCode: 1},
        $set: { integrity: event.integrity}
      }
    }

    function doneCallBack(err2, res2) {
      if (err2) return callback(err2);
      if (res2.count != initialModifiedCount) { // updated documents counts does not match
        logger.error('Issue when adding integrity to updated events for ' + JSON.stringify(userOrUserId) + ' counts does not match');
        // eventually throw an error here.. But this will not help the API client .. 
        // to be discussed !
      }
      return callback(err2, res2);
    }
    
    eventStore.findAndUpdateIfNeeded(userOrUserId, {integrityBatchCode: integrityBatchCode}, {}, updateIfNeeded, doneCallBack);
  }
}