/**
 * Common converter helper functions for storage modules.
 */

var generateId = require('cuid'),
    timestamp = require('unix-timestamp');

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


