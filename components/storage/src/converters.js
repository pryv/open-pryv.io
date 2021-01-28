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
/**
 * Common converter helper functions for storage modules.
 */

const generateId = require('cuid');
const timestamp = require('unix-timestamp');
const _ = require('lodash');

const SystemStreamsSerializer = require('business/src/system-streams/serializer');

exports.createIdIfMissing = function (item) {
  item.id = item.id || generateId();
  return item;
};

exports.getRenamePropertyFn = function (oldName, newName) {
  return function (item) {
    if (! item || ! item.hasOwnProperty(oldName)) {
      return item;
    }

    item[newName] = item[oldName];
    delete item[oldName];

    return item;
  };
};

/**
 * Converts the item's state to DB storage.
 * In our exposed API, items supporting state can carry a 'trashed' boolean field (true or false;
 * considered false if missing);
 * in the database, though, for optimization we only retain the 'trashed' field when it is true.
 */
exports.stateToDB = function (item) {
  if (item.trashed !== true) {
    delete item.trashed;
  }
  return item;
};

exports.stateUpdate = function (update) {
  if (update.$set.hasOwnProperty('trashed') && ! update.$set.trashed) {
    update.$unset.trashed = 1;
    delete update.$set.trashed;
  }
  return update;
};

exports.getKeyValueSetUpdateFn = function (propertyName) {
  propertyName = propertyName || 'clientData';
  return function (update) {
    var keyValueSet = update.$set[propertyName];
    if (keyValueSet) {
      Object.keys(keyValueSet).forEach(function (key) {
        if (keyValueSet[key] !== null) {
          update.$set[propertyName + '.' + key] = keyValueSet[key];
        } else {
          update.$unset[propertyName + '.' + key] = 1;
        }
      });
      delete update.$set[propertyName];
    }
    return update;
  };
};


exports.deletionToDB = function (item) {
  if (item.deleted != null) {
    item.deleted = timestamp.toDate(item.deleted);
  } else {
    item.deleted = null;
  }
  return item;
};

exports.deletionFromDB = function (dbItem) {
  if (dbItem == null) { return dbItem; }

  if (dbItem.deleted == null) {
    delete dbItem.deleted;
  }

  if (dbItem.deleted != null) {
    dbItem.deleted = timestamp.fromDate(dbItem.deleted);
  }
  return dbItem;
};

/**
 * Inside $or clauses, converts "id" to "_id"
 * @param {*} query 
 */
exports.idInOrClause = function (query) {
  if (query == null || query['$or'] == null) return query;
  const convertedOrClause = query['$or'].map(field => {
    if (field.id != null) {
      return { _id: field.id };
    }
    return field;
  });
  query['$or'] = convertedOrClause;
  return query;
}


exports.removeFieldsEnforceUniqueness = function (dbItem) {
  if (dbItem == null) { return dbItem; }

  Object.keys(dbItem).forEach(key => {
    if (key.endsWith('__unique')) delete dbItem[key];
  });

  return dbItem;
};

/**
 * If the event is marked as a trashed, remove fields that enforces uniqueness
 * so that trashed events would not conflict with new events
 * @param {} update 
 */
exports.addOrRemoveUniqueFieldIfNeeded = function (update) {
  if (update == null) { return update; }
  // deletion scenario
  if (update.$set?.trashed === true) {
    const uniqueStreamIdsList = SystemStreamsSerializer.getUniqueAccountStreamsIdsWithoutDot()
    uniqueStreamIdsList.forEach(uniqueKeys => {
      update['$unset'][`${uniqueKeys}__unique`] = 1;
    });
  } else if (update.$set?.streamIds) { // simple update scenario
    update.$set = addUniqueFieldIfNeeded(update.$set);
  }
  return update;
};

function addUniqueFieldIfNeeded(eventToDb) {
  if (eventToDb == null || eventToDb.deleted) { return eventToDb; }
  if (eventToDb?.streamIds.includes(SystemStreamsSerializer.options.STREAM_ID_UNIQUE)) {
    const allAccountStreams = Object.keys(SystemStreamsSerializer.getAllAccountStreams());
    const matchingAccountStreams = _.intersection(
      eventToDb.streamIds,
      allAccountStreams
    );
    if (matchingAccountStreams.length > 0) {
      const fieldName = SystemStreamsSerializer.removeDotFromStreamId(matchingAccountStreams[0]);
      eventToDb[`${fieldName}__unique`] = eventToDb.content;
    }
  }
  return eventToDb;
};
exports.addUniqueFieldIfNeeded = addUniqueFieldIfNeeded;
