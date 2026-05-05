/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { BaseStoragePG } = require('./BaseStoragePG');
const { _internals } = require('../_internals');
const timestamp = require('unix-timestamp');
const treeUtils = require('../../../../shared/treeUtils');

/**
 * PostgreSQL persistence for streams.
 */
class StreamsPG extends BaseStoragePG {
  constructor (db: any) {
    super(db);
    this.tableName = 'streams';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = false;
    this.defaultSort = 'name ASC';
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

  _findInternal (userId: string, query: any, options: any, callback: (err: any, items?: any) => void): void {
    const { select, excludeProps } = this.buildSelect(options);
    const where = this.buildWhere(userId, query);
    const orderBy = this.buildOrderBy(options);
    const { clause: limitOffset } = this.buildLimitOffset(options, where.params, where.nextIdx);

    const sql = `SELECT ${select} FROM ${this.tableName} ${where.text} ${orderBy}${limitOffset}`;
    this.db.query(sql, where.params)
      .then((res: any) => {
        const items = this.applyExclusions(this.rowsToItems(res.rows), excludeProps);
        callback(null, treeUtils.buildTree(items));
      })
      .catch(callback);
  }

  countAll (userOrUserId: any, callback: (err: any, n?: number) => void): void {
    this.count(userOrUserId, {}, callback);
  }

  insertOne (userOrUserId: any, stream: any, callback: (err: any, item?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    _internals.cache.unsetUserData(userId);
    if (!stream.path) {
      this._computePath(userId, stream)
        .then(() => super.insertOne(userOrUserId, stream, callback))
        .catch(callback);
      return;
    }
    super.insertOne(userOrUserId, stream, callback);
  }

  async _computePath (userId: string, stream: any): Promise<void> {
    if (stream.parentId) {
      const res = await this.db.query(
        'SELECT path FROM streams WHERE user_id = $1 AND id = $2',
        [userId, stream.parentId]
      );
      const parentPath = res.rows.length > 0 ? res.rows[0].path : '';
      stream.path = parentPath + stream.id + '/';
    } else {
      stream.path = stream.id + '/';
    }
  }

  updateOne (userOrUserId: any, query: any, updatedData: any, callback: (err: any, item?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    if (typeof updatedData.parentId !== 'undefined') {
      _internals.cache.unsetUserData(userId);
    } else {
      _internals.cache.unsetStreams(userId, 'local');
    }
    super.updateOne(userOrUserId, query, updatedData, callback);
  }

  delete (userOrUserId: any, query: any, callback: (err: any, res?: any) => void): void {
    const userId = (typeof userOrUserId === 'string') ? userOrUserId : userOrUserId.id;
    _internals.cache.unsetUserData(userId);
    this.updateMany(userOrUserId, query, {
      $set: { deleted: timestamp.now() },
      $unset: {
        name: 1,
        parentId: 1,
        clientData: 1,
        trashed: 1,
        created: 1,
        createdBy: 1,
        modified: 1,
        modifiedBy: 1
      }
    }, callback);
  }

  insertMany (userOrUserId: any, items: any[], callback: (err: any) => void): void {
    let flatItems: any[] = treeUtils.flattenTree(items);
    const pathMap: Record<string, string> = {};
    flatItems = flatItems.map((s: any) => {
      const copy = Object.assign({}, s);
      if (copy.deleted) {
        delete copy.parentId;
      }
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
    super.insertMany(userOrUserId, flatItems, callback);
  }
}

export { StreamsPG };