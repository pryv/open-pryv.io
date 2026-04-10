/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const BaseStoragePG = require('./BaseStoragePG');
const generateId = require('cuid');
const _internals = require('../_internals');
const timestamp = require('unix-timestamp');

const logger = _internals.lazyLogger('storage:accesses-pg');

/**
 * PostgreSQL persistence for accesses.
 */
class AccessesPG extends BaseStoragePG {
  constructor (db, integrityAccesses) {
    super(db);
    this.tableName = 'accesses';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = false;
    this.defaultSort = 'name ASC';
    this.integrityAccesses = integrityAccesses || { isActive: false, set: () => {} };
  }

  /**
   * Override: shared accesses always have deviceName: null (set by API
   * during creation). PG stores it as NULL in the column but BaseStoragePG
   * strips null values to match MongoDB behaviour. Re-add it for shared.
   */
  rowToItem (row) {
    const item = super.rowToItem(row);
    if (item && item.type === 'shared' && !('deviceName' in item)) {
      item.deviceName = null;
    }
    return item;
  }

  applyDefaults (item) {
    const copy = Object.assign({}, item);
    copy.id = copy.id || generateId();
    copy.token = copy.token || generateId();
    if (copy.deleted === undefined) copy.deleted = null;
    // apiEndpoint is a computed field — not stored in PG
    delete copy.apiEndpoint;
    // Compute integrity
    if (this.integrityAccesses.isActive) {
      this.integrityAccesses.set(copy);
    }
    return copy;
  }

  /** Exposed for convenience. */
  generateToken () {
    return generateId();
  }

  /**
   * Override: findDeletions for accesses uses deleted IS NOT NULL
   * (the MongoDB version uses $type: 'number').
   */
  findDeletions (userOrUserId, query, options, callback) {
    query = query || {};
    query.deleted = { $ne: null };
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    this._findInternal(userId, query, options, callback);
  }

  /**
   * Override: soft-delete with integrity reset.
   */
  delete (userOrUserId, query, callback) {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const now = timestamp.now();

    // Build the update
    const updateData = {
      $set: { deleted: now },
      $unset: { integrity: 1 }
    };

    if (!this.integrityAccesses.isActive) {
      return this.updateMany(userOrUserId, query, updateData, callback);
    }

    // With integrity active: update, then recompute integrity on affected rows
    const integrityBatchCode = Math.random();
    updateData.$set.integrityBatchCode = integrityBatchCode;

    this.updateMany(userOrUserId, query, updateData, (err, res) => {
      if (err) return callback(err);
      const initialModifiedCount = res.modifiedCount;

      const updateIfNeeded = (access) => {
        delete access.integrityBatchCode;
        const previousIntegrity = access.integrity;
        this.integrityAccesses.set(access, true);
        if (previousIntegrity === access.integrity) return null;
        return {
          $unset: { integrityBatchCode: 1 },
          $set: { integrity: access.integrity }
        };
      };

      this.findAndUpdateIfNeeded(userOrUserId, { integrityBatchCode }, {}, updateIfNeeded, (err2, res2) => {
        if (err2) return callback(err2);
        if (res2.count !== initialModifiedCount) {
          logger.error('Issue when adding integrity to updated accesses for ' +
            JSON.stringify(userId) + ' counts does not match');
        }
        callback(err2, res2);
      });
    });
  }

  /**
   * Override: updateOne with integrity recomputation.
   */
  updateOne (userOrUserId, query, update, callback) {
    if (update.modified == null || !this.integrityAccesses.isActive) {
      return this.findOneAndUpdate(userOrUserId, query, update, callback);
    }

    // Unset integrity unless it's being explicitly set
    if (update.integrity == null && update.$set?.integrity == null) {
      if (!update.$unset) update.$unset = {};
      update.$unset.integrity = 1;
    }

    const that = this;
    this.findOneAndUpdate(userOrUserId, query, update, (err, accessData) => {
      if (err || accessData?.id == null) return callback(err, accessData);

      const integrityCheck = accessData.integrity;
      try {
        this.integrityAccesses.set(accessData, true);
      } catch (errIntegrity) {
        return callback(errIntegrity, accessData);
      }
      if (integrityCheck !== accessData.integrity) {
        return that.findOneAndUpdate(userOrUserId, { id: accessData.id },
          { integrity: accessData.integrity }, callback);
      }
      callback(err, accessData);
    });
  }

  /**
   * Override: insertMany sets deleted=null on items missing it.
   */
  insertMany (userOrUserId, accesses, callback) {
    const accessesToCreate = accesses.map((a) => {
      if (a.deleted === undefined) return Object.assign({ deleted: null }, a);
      return a;
    });
    super.insertMany(userOrUserId, accessesToCreate, callback);
  }
}

module.exports = AccessesPG;
