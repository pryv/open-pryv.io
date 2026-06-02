/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Callback, UserOrId } from 'storages/interfaces/_shared/types.ts';

const require = createRequire(import.meta.url);

type Stream = {
  id: string;
  parentId?: string | null;
  name?: string;
  path?: string;
  deleted?: number | null;
  trashed?: boolean;
  singleActivity?: boolean;
  [k: string]: unknown;
};
type StreamRow = Record<string, unknown>;
type Query = Record<string, unknown>;
type Options = Record<string, unknown> | null;
type Update = Record<string, unknown>;
type PgDb = { query (sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };

const { BaseStoragePG } = require('./BaseStoragePG.ts');
const { _internals } = require('../_internals.ts');
const timestamp = require('unix-timestamp');
const { treeUtils } = require('utils');

/**
 * PostgreSQL persistence for streams.
 */
class StreamsPG extends BaseStoragePG {
  declare db: PgDb;
  constructor (db: PgDb) {
    super(db);
    this.tableName = 'streams';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = false;
    this.defaultSort = 'name ASC';
  }

  rowToItem (row: StreamRow): Stream | null {
    const item = super.rowToItem(row) as Stream | null;
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

  _findInternal (userId: string, query: Query, options: Options, callback: Callback<Stream[]>): void {
    const { select, excludeProps } = this.buildSelect(options);
    const where = this.buildWhere(userId, query);
    const orderBy = this.buildOrderBy(options);
    const { clause: limitOffset } = this.buildLimitOffset(options, where.params, where.nextIdx);

    const sql = `SELECT ${select} FROM ${this.tableName} ${where.text} ${orderBy}${limitOffset}`;
    this.db.query(sql, where.params)
      .then((res: { rows: StreamRow[] }) => {
        const items = this.applyExclusions(this.rowsToItems(res.rows), excludeProps);
        callback(null, treeUtils.buildTree(items));
      })
      .catch(callback);
  }

  countAll (userOrUserId: UserOrId, callback: Callback<number>): void {
    this.count(userOrUserId, {}, callback);
  }

  insertOne (userOrUserId: UserOrId, stream: Stream, callback: Callback<Stream>): void {
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

  async _computePath (userId: string, stream: Stream): Promise<void> {
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

  updateOne (userOrUserId: UserOrId, query: Query, updatedData: Update & { parentId?: unknown }, callback: Callback<Stream>): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    if (typeof updatedData.parentId !== 'undefined') {
      _internals.cache.unsetUserData(userId);
    } else {
      _internals.cache.unsetStreams(userId, 'local');
    }
    super.updateOne(userOrUserId, query, updatedData, callback);
  }

  delete (userOrUserId: UserOrId, query: Query, callback: Callback<unknown>): void {
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

  insertMany (userOrUserId: UserOrId, items: Stream[], callback: Callback<unknown>): void {
    let flatItems: Stream[] = treeUtils.flattenTree(items);
    const pathMap: Record<string, string> = {};
    flatItems = flatItems.map((s: Stream) => {
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