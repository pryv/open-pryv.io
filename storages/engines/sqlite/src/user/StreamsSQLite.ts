/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Callback, UserOrId, Query, UpdateData, FindOptions } from 'storages/interfaces/_shared/types.ts';
import type { StoredStream } from 'storages/interfaces/_shared/domain.ts';
import type { DbRow } from './BaseStorageSQLite.ts';

const require = createRequire(import.meta.url);

/** Storage item for this collection: the canonical stored shape plus the
 *  materialized-path field (`path`, stripped on read) and the legacy
 *  `singleActivity` flag this engine still round-trips. */
type StreamItem = StoredStream & { path?: string; singleActivity?: boolean };
type Options = FindOptions;
type Update = UpdateData;

const { BaseStorageSQLite } = require('./BaseStorageSQLite.ts') as typeof import('./BaseStorageSQLite.ts');
const { UserBaseStorageDb } = require('../userBaseStorage/UserBaseStorageDb.ts');
const timestamp = require('unix-timestamp');
const { treeUtils } = require('utils');
const { _internals } = require('../_internals.ts');

class StreamsSQLite extends BaseStorageSQLite<StreamItem> {
  constructor () {
    super();
    this.tableName = 'streams';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = false;
    this.defaultSort = `json_extract(data, '$.name') ASC`;
  }

  rowToItem (row: DbRow): StreamItem | null {
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

  find (userOrUserId: UserOrId, query: Query, options: Options, callback: Callback<StreamItem[]>): void {
    super.find(userOrUserId, query, options, (err: Error | null, items?: Array<StreamItem | null>) => {
      if (err) return callback(err);
      callback(null, treeUtils.buildTree(items));
    });
  }

  findIncludingDeletionsAndVersions (userOrUserId: UserOrId, query: Query, options: Options, callback: Callback<StreamItem[]>): void {
    super.findIncludingDeletionsAndVersions(userOrUserId, query, options, (err: Error | null, items?: Array<StreamItem | null>) => {
      if (err) return callback(err);
      callback(null, treeUtils.buildTree(items));
    });
  }

  countAll (userOrUserId: UserOrId, callback: Callback<number>): void {
    this.count(userOrUserId, {}, callback);
  }

  insertOne (userOrUserId: UserOrId, stream: StreamItem, callback: Callback<StreamItem | null>): void {
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

  updateOne (userOrUserId: UserOrId, query: Query, updatedData: Update & { parentId?: unknown }, callback: Callback<StreamItem | null>): void {
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

  async _computePath (userId: string, stream: StreamItem): Promise<void> {
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

  delete (userOrUserId: UserOrId, query: Query, callback: Callback<{ modifiedCount: number }>): void {
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

  insertMany (userOrUserId: UserOrId, items: StreamItem[], callback: Callback<void>): void {
    let flat: StreamItem[] = treeUtils.flattenTree(items);
    const pathMap: Record<string, string> = {};
    flat = flat.map((s: StreamItem) => {
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
