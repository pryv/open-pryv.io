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
const timestamp = require('unix-timestamp');
const treeUtils = require('../../../../shared/treeUtils.ts');
const { _internals } = require('../_internals.ts');

class StreamsSQLite extends BaseStorageSQLite {
  constructor () {
    super();
    this.tableName = 'streams';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = false;
    this.defaultSort = `json_extract(data, '$.name') ASC`;
  }

  rowToItem (row: any): any | null {
    const item = super.rowToItem(row);
    if (item) {
      delete item.path;
      if (item.trashed === false) delete item.trashed;
      if (item.singleActivity === false) delete item.singleActivity;
      if (item.deleted != null) {
        return { id: item.id, deleted: item.deleted };
      }
    }
    return item;
  }

  find (userOrUserId: any, query: any, options: any, callback: (err: any, items?: any[]) => void): void {
    super.find(userOrUserId, query, options, (err: any, items?: any[]) => {
      if (err) return callback(err);
      callback(null, treeUtils.buildTree(items));
    });
  }

  findIncludingDeletionsAndVersions (userOrUserId: any, query: any, options: any, callback: (err: any, items?: any[]) => void): void {
    super.findIncludingDeletionsAndVersions(userOrUserId, query, options, (err: any, items?: any[]) => {
      if (err) return callback(err);
      callback(null, treeUtils.buildTree(items));
    });
  }

  countAll (userOrUserId: any, callback: (err: any, n?: number) => void): void {
    this.count(userOrUserId, {}, callback);
  }

  insertOne (userOrUserId: any, stream: any, callback: (err: any, item?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    if (_internals.cache) _internals.cache.unsetUserData(userId);
    if (!stream.path) {
      this._computePath(userId, stream)
        .then(() => super.insertOne(userOrUserId, stream, callback))
        .catch(callback);
      return;
    }
    super.insertOne(userOrUserId, stream, callback);
  }

  updateOne (userOrUserId: any, query: any, updatedData: any, callback: (err: any, item?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    if (_internals.cache) {
      if (typeof updatedData.parentId !== 'undefined') {
        _internals.cache.unsetUserData(userId);
      } else {
        _internals.cache.unsetStreams(userId, 'local');
      }
    }
    super.updateOne(userOrUserId, query, updatedData, callback);
  }

  async _computePath (userId: string, stream: any): Promise<void> {
    if (stream.parentId) {
      const udb = await UserBaseStorageDb.forUser(userId);
      await udb.ensureTable(this.tableName, { withDeleted: this.hasDeletedCol, withHeadId: this.hasHeadIdCol });
      const row = udb.db.prepare(
        `SELECT * FROM ${this.tableName} WHERE id = ?`
      ).get(stream.parentId);
      let parentPath = '';
      if (row && row.data) {
        const parsed = JSON.parse(row.data);
        parentPath = parsed.path || '';
      }
      stream.path = parentPath + stream.id + '/';
    } else {
      stream.path = stream.id + '/';
    }
  }

  delete (userOrUserId: any, query: any, callback: (err: any, res?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    if (_internals.cache) _internals.cache.unsetUserData(userId);
    this.updateMany(userOrUserId, query, {
      $set: { deleted: timestamp.now() },
      $unset: {
        name: 1, parentId: 1, clientData: 1, trashed: 1,
        created: 1, createdBy: 1, modified: 1, modifiedBy: 1
      }
    }, callback);
  }

  insertMany (userOrUserId: any, items: any[], callback: (err: any) => void): void {
    let flat: any[] = treeUtils.flattenTree(items);
    const pathMap: Record<string, string> = {};
    flat = flat.map((s: any) => {
      const copy = Object.assign({}, s);
      if (copy.deleted) delete copy.parentId;
      if (!copy.path) {
        if (copy.parentId && pathMap[copy.parentId]) {
          copy.path = pathMap[copy.parentId] + copy.id + '/';
        } else {
          copy.path = copy.id + '/';
        }
      }
      pathMap[copy.id] = copy.path;
      return copy;
    });
    super.insertMany(userOrUserId, flat, callback);
  }
}

export { StreamsSQLite };
