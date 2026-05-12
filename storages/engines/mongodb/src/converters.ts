/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Common converter helper functions for storage modules.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createId: generateId } = require('@paralleldrive/cuid2');

function createIdIfMissing (item: any) {
  item.id = item.id || generateId();
  return item;
}

function getRenamePropertyFn (oldName: any, newName: any) {
  return function (item: any) {
    if (!item || item[oldName] == null) {
      return item;
    }

    item[newName] = item[oldName];
    delete item[oldName];

    return item;
  };
}

function stateUpdate (update: any) {
  if (update.$set.trashed != null && !update.$set.trashed) {
    update.$unset.trashed = 1;
    delete update.$set.trashed;
  }
  return update;
}

function getKeyValueSetUpdateFn (propertyName: any) {
  propertyName = propertyName || 'clientData';
  return function (update: any) {
    const keyValueSet = update.$set[propertyName];
    if (keyValueSet) {
      Object.keys(keyValueSet).forEach(function (key) {
        if (keyValueSet[key] !== null) {
          update.$set[propertyName + '.' + key] = keyValueSet[key];
        } else {
          update.$unset[propertyName + '.' + key] = 1;
        }
      });
      delete update.$set[propertyName];
    }
    return update;
  };
}

function deletionToDB (item: any) {
  if (item.deleted === undefined) { // undefined => null
    item.deleted = null;
  }
  return item;
}

function deletionFromDB (dbItem: any) {
  if (dbItem == null) { return dbItem; }

  if (dbItem.deleted == null) { // undefined or null
    delete dbItem.deleted;
  }
  return dbItem;
}

/**
 * Inside $or clauses, converts "id" to "_id"
 */
function idInOrClause (query: any) {
  if (query == null || query.$or == null) return query;
  const convertedOrClause = query.$or.map((field: any) => {
    if (field.id != null) {
      return { _id: field.id };
    }
    return field;
  });
  query.$or = convertedOrClause;
  return query;
}

export {
  createIdIfMissing,
  getRenamePropertyFn,
  stateUpdate,
  getKeyValueSetUpdateFn,
  deletionToDB,
  deletionFromDB,
  idInOrClause
};
