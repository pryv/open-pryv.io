/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { BaseStoragePG } = require('./BaseStoragePG');
const { createId: generateId } = require('@paralleldrive/cuid2');
const { _internals } = require('../_internals');
const timestamp = require('unix-timestamp');

const logger = _internals.lazyLogger('storage:accesses-pg');

/**
 * PostgreSQL persistence for accesses.
 */
class AccessesPG extends BaseStoragePG {
  integrityAccesses: any;

  constructor (db: any, integrityAccesses?: any) {
    super(db);
    this.tableName = 'accesses';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = false;
    this.defaultSort = 'name ASC';
    this.integrityAccesses = integrityAccesses || { isActive: false, set: () => {} };
  }

  rowToItem (row: any): any | null {
    const item = super.rowToItem(row);
    if (item && item.type === 'shared' && !('deviceName' in item)) {
      item.deviceName = null;
    }
    return item;
  }

  applyDefaults (item: any): any {
    const copy = Object.assign({}, item);
    copy.id = copy.id || generateId();
    copy.token = copy.token || generateId();
    if (copy.deleted === undefined) copy.deleted = null;
    delete copy.apiEndpoint;
    if (this.integrityAccesses.isActive) {
      this.integrityAccesses.set(copy);
    }
    return copy;
  }

  generateToken (): string {
    return generateId();
  }

  findDeletions (userOrUserId: any, query: any, options: any, callback: (err: any, items?: any) => void): void {
    query = query || {};
    query.deleted = { $ne: null };
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    this._findInternal(userId, query, options, callback);
  }

  delete (userOrUserId: any, query: any, callback: (err: any, res?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const now = timestamp.now();

    const updateData: any = {
      $set: { deleted: now },
      $unset: { integrity: 1 }
    };

    if (!this.integrityAccesses.isActive) {
      return this.updateMany(userOrUserId, query, updateData, callback);
    }

    const integrityBatchCode = Math.random();
    updateData.$set.integrityBatchCode = integrityBatchCode;

    this.updateMany(userOrUserId, query, updateData, (err: any, res: any) => {
      if (err) return callback(err);
      const initialModifiedCount = res.modifiedCount;

      const updateIfNeeded = (access: any): any => {
        delete access.integrityBatchCode;
        const previousIntegrity = access.integrity;
        this.integrityAccesses.set(access, true);
        if (previousIntegrity === access.integrity) return null;
        return {
          $unset: { integrityBatchCode: 1 },
          $set: { integrity: access.integrity }
        };
      };

      this.findAndUpdateIfNeeded(userOrUserId, { integrityBatchCode }, {}, updateIfNeeded, (err2: any, res2: any) => {
        if (err2) return callback(err2);
        if (res2.count !== initialModifiedCount) {
          logger.error('Issue when adding integrity to updated accesses for ' +
            JSON.stringify(userId) + ' counts does not match');
        }
        callback(err2, res2);
      });
    });
  }

  updateOne (userOrUserId: any, query: any, update: any, callback: (err: any, item?: any) => void): void {
    if (update.modified == null || !this.integrityAccesses.isActive) {
      return this.findOneAndUpdate(userOrUserId, query, update, callback);
    }

    if (update.integrity == null && update.$set?.integrity == null) {
      if (!update.$unset) update.$unset = {};
      update.$unset.integrity = 1;
    }

    const that = this;
    this.findOneAndUpdate(userOrUserId, query, update, (err: any, accessData: any) => {
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

  insertMany (userOrUserId: any, accesses: any[], callback: (err: any) => void): void {
    const accessesToCreate = accesses.map((a) => {
      if (a.deleted === undefined) return Object.assign({ deleted: null }, a);
      return a;
    });
    super.insertMany(userOrUserId, accessesToCreate, callback);
  }
}

export { AccessesPG };