/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const BaseStoragePG = require('./BaseStoragePG');
const _internals = require('../_internals');
const timestamp = require('unix-timestamp');
const treeUtils = require('../../../../shared/treeUtils');

/**
 * PostgreSQL persistence for streams (StorageLayer component).
 *
 * Notes on tree handling:
 * - MongoDB stores streams flat and rebuilds the tree on read (treeUtils.buildTree).
 * - MongoDB flattens the tree on write (treeUtils.flattenTree).
 * - In PG, streams are stored flat with a `path` column for descendant queries.
 * - We still build/flatten the tree for API compatibility.
 */
class StreamsPG extends BaseStoragePG {
  constructor (db) {
    super(db);
    this.tableName = 'streams';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = false;
    this.defaultSort = 'name ASC';
  }

  /**
   * Override: strip PG-internal/non-API properties.
   * - `path` is used only for descendant queries, not part of the stream API.
   * - `trashed: false` — MongoDB omits trashed when false.
   * - Deleted streams: MongoDB only returns { id, deleted } after $unset of all other fields.
   */
  rowToItem (row) {
    const item = super.rowToItem(row);
    if (item) {
      delete item.path;
      if (item.trashed === false) delete item.trashed;
      if (item.singleActivity === false) delete item.singleActivity;
      // Deleted streams only have id + deleted in MongoDB
      if (item.deleted != null) {
        return { id: item.id, deleted: item.deleted };
      }
    }
    return item;
  }

  /** Override to return items as a tree structure (matching MongoDB Streams). */
  _findInternal (userId, query, options, callback) {
    const { select, excludeProps } = this.buildSelect(options);
    const where = this.buildWhere(userId, query);
    const orderBy = this.buildOrderBy(options);
    const { clause: limitOffset } = this.buildLimitOffset(options, where.params, where.nextIdx);

    const sql = `SELECT ${select} FROM ${this.tableName} ${where.text} ${orderBy}${limitOffset}`;
    this.db.query(sql, where.params)
      .then((res) => {
        const items = this.applyExclusions(this.rowsToItems(res.rows), excludeProps);
        callback(null, treeUtils.buildTree(items));
      })
      .catch(callback);
  }

  /** Count only non-deleted items (streams don't count headId). */
  countAll (userOrUserId, callback) {
    this.count(userOrUserId, {}, callback);
  }

  insertOne (userOrUserId, stream, callback) {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    _internals.cache.unsetUserData(userId);
    // Compute path for descendant queries if not provided
    if (!stream.path) {
      this._computePath(userId, stream)
        .then(() => super.insertOne(userOrUserId, stream, callback))
        .catch(callback);
      return;
    }
    super.insertOne(userOrUserId, stream, callback);
  }

  /**
   * Compute the hierarchical path for a stream.
   * Root streams: `id/`
   * Child streams: `parentPath + id/`
   */
  async _computePath (userId, stream) {
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

  updateOne (userOrUserId, query, updatedData, callback) {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    if (typeof updatedData.parentId !== 'undefined') {
      _internals.cache.unsetUserData(userId);
    } else {
      _internals.cache.unsetStreams(userId, 'local');
    }
    super.updateOne(userOrUserId, query, updatedData, callback);
  }

  /**
   * Override: soft-delete with aggressive field unsetting (matching MongoDB Streams.delete).
   */
  delete (userOrUserId, query, callback) {
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

  /**
   * Override insertMany: flatten tree and cleanup deletions (matching MongoDB Streams).
   */
  insertMany (userOrUserId, items, callback) {
    // Flatten tree structure to a flat array
    let flatItems = treeUtils.flattenTree(items);
    // Build paths from the tree structure and clean up deletions
    const pathMap = {};
    flatItems = flatItems.map((s) => {
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

module.exports = StreamsPG;
