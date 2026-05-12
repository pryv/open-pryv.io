/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { BaseStorage } = require('./BaseStorage.ts');
const converters = require('./../converters.ts');
const { _internals } = require('../_internals.ts');
const treeUtils = require('../../../../shared/treeUtils.ts');
const timestamp = require('unix-timestamp');

function cleanupDeletions (streams: any) {
  streams.forEach(function (s: any) {
    if (s.deleted) {
      delete s.parentId;
    }
  });
  return streams;
}

const indexes = [
  {
    index: { streamId: 1 },
    options: { unique: true }
  },
  {
    index: { name: 1 },
    options: {}
  },
  {
    index: { name: 1, parentId: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        deleted: { $type: 'null' }
      }
    }
  },
  {
    index: { trashed: 1 },
    options: {}
  }
];

/**
 * DB persistence for event streams.
 */
class Streams extends BaseStorage {
  defaultOptions: any;

  constructor (database: any) {
    super(database);

    Object.assign(this.converters, {
      itemDefaults: [],
      itemToDB: [
        // converters.deletionToDB,
      ],
      itemsToDB: [
        treeUtils.flattenTree,
        cleanupDeletions
      ],
      updateToDB: [
        converters.stateUpdate,
        converters.getKeyValueSetUpdateFn('clientData')
      ],
      itemFromDB: [converters.deletionFromDB],
      itemsFromDB: [treeUtils.buildTree],
      convertIdToItemId: 'streamId'
    });

    this.defaultOptions = {
      sort: { name: 1 }
    };
  }

  getCollectionInfo (userOrUserId: any) {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    return {
      name: 'streams',
      indexes,
      useUserId: userId
    };
  }

  countAll (user: any, callback: any) {
    this.count(user, {}, callback);
  }

  /** Override importAll: convert canonical backup format `id` → MongoDB `streamId`. */
  importAll (userOrUserId: any, items: any, callback: any) {
    const mapped = items.map((item: any) => {
      const doc = Object.assign({}, item);
      if (doc.id != null && doc.streamId == null) {
        doc.streamId = doc.id;
        delete doc.id;
      }
      return doc;
    });
    super.importAll(userOrUserId, mapped, callback);
  }

  insertOne (user: any, stream: any, callback: any) {
    _internals.cache.unsetUserData(user.id);
    super.insertOne(user, stream, callback);
  }

  updateOne (user: any, query: any, updatedData: any, callback: any) {
    if (typeof updatedData.parentId !== 'undefined') { // clear ALL when a stream is moved
      _internals.cache.unsetUserData(user.id);
    } else { // only stream Structure
      _internals.cache.unsetStreams(user.id, 'local');
    }
    super.updateOne(user, query, updatedData, callback);
  }

  delete (userOrUserId: any, query: any, callback: any) {
    const userId = userOrUserId.id || userOrUserId;
    _internals.cache.unsetUserData(userId);
    const update = {
      $set: { deleted: timestamp.now() },
      $unset: {
        name: 1,
        parentId: 1,
        clientData: 1,
        children: 1,
        trashed: 1,
        created: 1,
        createdBy: 1,
        modified: 1,
        modifiedBy: 1
      }
    };
    this.database.updateMany(this.getCollectionInfo(userOrUserId),
      this.applyQueryToDB(query), update, callback);
  }
}

export { Streams };
