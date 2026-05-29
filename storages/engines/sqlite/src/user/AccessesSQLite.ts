/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { BaseStorageSQLite } = require('./BaseStorageSQLite.ts');
const { UserBaseStorageDb } = require('../userBaseStorage/UserBaseStorageDb.ts');
const { createId: generateId } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');

class AccessesSQLite extends BaseStorageSQLite {
  integrityAccesses: any;

  constructor (integrityAccesses?: any) {
    super();
    this.tableName = 'accesses';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = true;
    this.defaultSort = `json_extract(data, '$.name') ASC`;
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
    const q = Object.assign({}, query || {}, { deleted: { $ne: null } });
    this.findIncludingDeletionsAndVersions(userOrUserId, q, options, callback);
  }

  delete (userOrUserId: any, query: any, callback: (err: any, res?: any) => void): void {
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
      const initial = res.modifiedCount;
      const updateIfNeeded = (access: any): any => {
        delete access.integrityBatchCode;
        const prev = access.integrity;
        this.integrityAccesses.set(access, true);
        if (prev === access.integrity) return null;
        return {
          $unset: { integrityBatchCode: 1 },
          $set: { integrity: access.integrity }
        };
      };
      this.findAndUpdateIfNeeded(userOrUserId, { integrityBatchCode }, {}, updateIfNeeded, (err2: any, res2: any) => {
        if (err2) return callback(err2);
        callback(null, { modifiedCount: initial, integrityRecomputed: res2?.count ?? 0 });
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
    this.findOneAndUpdate(userOrUserId, query, update, (err: any, accessData: any) => {
      if (err || accessData?.id == null) return callback(err, accessData);
      const before = accessData.integrity;
      try {
        this.integrityAccesses.set(accessData, true);
      } catch (eInt) {
        return callback(eInt, accessData);
      }
      if (before !== accessData.integrity) {
        return this.findOneAndUpdate(userOrUserId, { id: accessData.id },
          { integrity: accessData.integrity }, callback);
      }
      callback(err, accessData);
    });
  }

  async findHistory (userOrUserId: any, baseId: string): Promise<any[]> {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const udb = await UserBaseStorageDb.forUser(userId);
    await udb.ensureTable(this.tableName, { withDeleted: this.hasDeletedCol, withHeadId: this.hasHeadIdCol });
    const rows = udb.db.prepare(
      `SELECT * FROM ${this.tableName} WHERE head_id = ? ORDER BY json_extract(data, '$.modified') ASC`
    ).all(baseId);
    return rows.map((r: any) => this.rowToItem(r)).filter((x: any) => x != null);
  }

  snapshotHead (userOrUserId: any, baseId: string, callback: (err: any) => void): void {
    this.findOne(userOrUserId, { id: baseId }, null, (err: any, head: any) => {
      if (err) return callback(err);
      if (head == null) return callback(new Error('snapshotHead: no live head row for access id ' + JSON.stringify(baseId)));
      const snapshot = Object.assign({}, head);
      snapshot.id = generateId();
      snapshot.headId = baseId;
      delete snapshot.integrity;
      delete snapshot.apiEndpoint;
      this.insertOne(userOrUserId, snapshot, (err2: any) => callback(err2 || null));
    });
  }

  insertMany (userOrUserId: any, accesses: any[], callback: (err: any) => void): void {
    const prepared = accesses.map((a) => {
      if (a.deleted === undefined) return Object.assign({ deleted: null }, a);
      return a;
    });
    super.insertMany(userOrUserId, prepared, callback);
  }
}

export { AccessesSQLite };
