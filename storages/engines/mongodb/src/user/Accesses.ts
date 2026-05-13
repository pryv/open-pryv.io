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
const { createId: generateId } = require('@paralleldrive/cuid2');
const { _internals } = require('../_internals.ts');
const logger = _internals.lazyLogger('storage:accesses');
const timestamp = require('unix-timestamp');

function createTokenIfMissing (access: any) {
  access.token = access.token || generateId();
  return access;
}

// Live rows MUST have an explicit BSON null `headId` — the unique-index
// partial filter (`$type: 'null'`) excludes documents where the field is
// absent. Setting null on insert keeps live rows in the unique-token set
// while history rows (headId = <base>, a string) are naturally excluded.
function setHeadIdNullIfMissing (access: any) {
  if (access.headId === undefined) access.headId = null;
  return access;
}

// Plan 66: `headId` is an internal storage marker — never surface it on
// the wire. History rows are reached via dedicated history queries.
function stripHeadId (access: any) {
  if (access != null) delete access.headId;
  return access;
}

const indexes = [
  {
    index: { token: 1 },
    options: {
      unique: true,
      partialFilterExpression: { deleted: { $type: 'null' }, headId: { $type: 'null' } }
    }
  },
  {
    index: { integrityBatchCode: 1 },
    options: {}
  },
  {
    index: { name: 1, type: 1, deviceName: 1 },
    options: {
      unique: true,
      partialFilterExpression: { deleted: { $type: 'null' }, headId: { $type: 'null' } }
    }
  },
  {
    index: { headId: 1 },
    options: {
      partialFilterExpression: { headId: { $type: 'string' } }
    }
  }
];

/**
 * DB persistence for accesses.
 *
 * @param integrityAccesses - { isActive, set } from business/integrity
 */
class Accesses extends BaseStorage {
  integrityAccesses: any;
  defaultOptions: any;

  constructor (database: any, integrityAccesses: any) {
    super(database);
    this.integrityAccesses = integrityAccesses || { isActive: false, set: () => {} };

    const self = this;
    function addIntegrity (accessData: any) {
      if (!self.integrityAccesses.isActive) return accessData;
      self.integrityAccesses.set(accessData);
      return accessData;
    }

    Object.assign(this.converters, {
      itemDefaults: [
        converters.createIdIfMissing,
        createTokenIfMissing,
        setHeadIdNullIfMissing
      ],
      itemToDB: [converters.deletionToDB, addIntegrity],
      itemsToDB: [
        function (items: any) {
          if (items == null) return null;
          const res = items.map((a: any) => addIntegrity(converters.deletionToDB(a)));
          return res;
        }
      ],
      itemFromDB: [converters.deletionFromDB, stripHeadId],
      queryToDB: [converters.idInOrClause]
    });

    this.defaultOptions = {
      sort: { name: 1 }
    };
  }

  /**
   * Plan 66 schema bootstrap. Idempotent. Drops the pre-Plan-66 unique indexes
   * whose partial filter did not include `headId`, then backfills existing
   * rows so the new `{ headId: { $type: 'null' } }` partial filter applies to
   * them. Called once from the engine's `initStorageLayer`.
   */
  async bootstrap () {
    await this.database.ensureConnect();
    const coll = this.database.db.collection('accesses');
    for (const name of ['token_1', 'name_1_type_1_deviceName_1']) {
      try {
        await coll.dropIndex(name);
      } catch (err: any) {
        // 26 = NamespaceNotFound (fresh DB, collection does not yet exist).
        // 27 = IndexNotFound (collection exists but no such index).
        if (err?.code !== 26 && err?.code !== 27 &&
            err?.codeName !== 'NamespaceNotFound' && err?.codeName !== 'IndexNotFound') {
          throw err;
        }
      }
    }
    await coll.updateMany(
      { headId: { $exists: false } },
      { $set: { headId: null } }
    );
  }

  findDeletions (userOrUserId: any, query: any, options: any, callback: any) {
    query = query || {};
    query.deleted = { $type: 'number' };

    this.database.find(
      this.getCollectionInfo(userOrUserId),
      query,
      this.applyOptionsToDB(options),
      (err: any, dbItems: any) => {
        if (err) {
          return callback(err);
        }
        callback(null, this.applyItemsFromDB(dbItems));
      }
    );
  }

  getCollectionInfo (userOrUserId: any) {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    return {
      name: 'accesses',
      indexes,
      useUserId: userId
    };
  }

  delete (userOrUserId: any, query: any, callback: any) {
    const update = {
      $set: { deleted: timestamp.now() }
    };
    const finalCallBack = getResetIntegrity(this, userOrUserId, update, callback);
    this.database.updateMany(this.getCollectionInfo(userOrUserId),
      this.applyQueryToDB(query), update, finalCallBack);
  }

  generateToken () {
    return generateId();
  }

  updateOne (userOrUserId: any, query: any, update: any, callback: any) {
    if (update.modified == null || !this.integrityAccesses.isActive) { // only if "modified" is set .. avoid `calls` + `lastUsed` updates
      super.findOneAndUpdate(userOrUserId, query, update, callback);
      return;
    }

    // unset eventually existing integrity field. Unless integrity is in set request
    if (update.integrity == null && update.$set?.integrity == null) {
      if (!update.$unset) update.$unset = {};
      update.$unset.integrity = 1;
    }

    const that = this;
    const cb = function callbackIntegrity (err: any, accessData: any) {
      if (err || (accessData?.id == null)) return callback(err, accessData);

      const integrityCheck = accessData.integrity;
      try {
        that.integrityAccesses.set(accessData, true);
      } catch (errIntegrity) {
        return callback(errIntegrity, accessData);
      }
      // only update if there is a mismatch of integrity
      if (integrityCheck !== accessData.integrity) {
        // could be optimized by using "updateOne" instead of findOne and update
        return BaseStorage.prototype.findOneAndUpdate.call(that, userOrUserId, { _id: accessData.id }, { integrity: accessData.integrity }, callback);
      }
      callback(err, accessData);
    };
    super.findOneAndUpdate(userOrUserId, query, update, cb);
  }

  /**
   * Plan 66: return the chronological history docs for a base id. Each
   * doc is a frozen pre-update snapshot; `serial` is the value that
   * doc was at before the update that produced the next version.
   * Sorted by `modified` ascending so caller iterates oldest-first.
   */
  async findHistory (userOrUserId: any, baseId: string): Promise<any[]> {
    await this.database.ensureConnect();
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const coll = this.database.db.collection('accesses');
    const docs = await coll.find({ userId, headId: baseId }).sort({ modified: 1 }).toArray();
    return docs.map((d: any) => {
      const out = this.applyItemFromDB(d);
      return out;
    }).filter((x: any) => x != null);
  }

  /**
   * Plan 66: snapshot the current live head document into a history doc.
   * Reads the head doc identified by `id`, clones every field, replaces
   * `_id` with a freshly-minted cuid and sets `headId` to the original
   * base. The unique-token partial filter (deleted: null && headId: null)
   * excludes the new history row, so duplicating the token is safe.
   *
   * Caller is expected to mutate the head doc immediately after this
   * call to bump `serial`.
   */
  async snapshotHead (userOrUserId: any, baseId: string): Promise<void> {
    await this.database.ensureConnect();
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const coll = this.database.db.collection('accesses');
    const head = await coll.findOne({ userId, _id: baseId, headId: null });
    if (head == null) {
      throw new Error('snapshotHead: no live head doc for access id ' + JSON.stringify(baseId));
    }
    const snapshot: any = Object.assign({}, head);
    snapshot._id = generateId();
    snapshot.headId = baseId;
    await coll.insertOne(snapshot);
  }

  /** Inserts an array of accesses; each item must have a valid id and data already. For tests only. */
  insertMany (userOrUserId: any, accesses: any, callback: any) {
    const accessesToCreate = accesses.map((a: any) => {
      if (a.deleted === undefined) return Object.assign({ deleted: null }, a);
      return a;
    });
    this.database.insertMany(
      this.getCollectionInfo(userOrUserId),
      this.applyItemsToDB(accessesToCreate),
      callback
    );
  }
}

export { Accesses };

/**
 * - Always unset 'integrity' of updated events by modifying the update query.
 * - If integrity is active for event, returns a callback to be executed after the update.
 *
 * @param update -- the update query to be modified
 * @returns either the original callback or a process to reset events' integrity
 */
function getResetIntegrity (accessesStore: any, userOrUserId: any, update: any, callback: any) {
  // anyway remove any integrity that might have existed
  if (!update.$unset) update.$unset = {};
  update.$unset.integrity = 1;

  // not active return the normal callback
  if (!accessesStore.integrityAccesses.isActive) return callback;

  // add a random "code" to the original update find out which events have been modified
  const integrityBatchCode = Math.random();
  if (!update.$set) update.$set = {};
  update.$set.integrityBatchCode = integrityBatchCode;

  // return a callback that will be executed after the update
  return function (err: any, res: any) {
    if (err) return callback(err);
    const initialModifiedCount = res.modifiedCount;

    // will be called for each updated item; we should remove the "integrityBatchCode"
    // that helped finding them out, and add the integrity value
    function updateIfNeeded (access: any) {
      delete access.integrityBatchCode; // remove integrity batch code for computation
      const previousIntegrity = access.integrity;
      accessesStore.integrityAccesses.set(access, true);
      if (previousIntegrity === access.integrity) return null;
      return {
        $unset: { integrityBatchCode: 1 },
        $set: { integrity: access.integrity }
      };
    }

    function doneCallBack (err2: any, res2: any) {
      if (err2) return callback(err2);
      if (res2.count !== initialModifiedCount) { // counts mismatch
        logger.error('Issue when adding integrity to updated events for ' + JSON.stringify(userOrUserId) + ' counts does not match');
      }
      return callback(err2, res2);
    }

    accessesStore.findAndUpdateIfNeeded(userOrUserId, { integrityBatchCode }, {}, updateIfNeeded, doneCallBack);
  };
}
