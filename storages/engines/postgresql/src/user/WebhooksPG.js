/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const BaseStoragePG = require('./BaseStoragePG');
const generateId = require('cuid');
const timestamp = require('unix-timestamp');

/**
 * PostgreSQL persistence for webhooks.
 */
class WebhooksPG extends BaseStoragePG {
  constructor (db) {
    super(db);
    this.tableName = 'webhooks';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = false;
  }

  applyDefaults (item) {
    const copy = Object.assign({}, item);
    copy.id = copy.id || generateId();
    if (copy.deleted === undefined) copy.deleted = null;
    return copy;
  }

  /**
   * Override: on soft-delete, unset all fields except id and deleted
   * (matching the MongoDB Webhooks.delete behaviour).
   */
  delete (userOrUserId, query, callback) {
    this.updateMany(userOrUserId, query, {
      $set: { deleted: timestamp.now() },
      $unset: {
        accessId: 1,
        url: 1,
        state: 1,
        runCount: 1,
        failCount: 1,
        lastRun: 1,
        runs: 1,
        currentRetries: 1,
        maxRetries: 1,
        minIntervalMs: 1,
        created: 1,
        createdBy: 1,
        modified: 1,
        modifiedBy: 1
      }
    }, callback);
  }

  /**
   * Override insertOne to return item without the deleted field (matching MongoDB).
   */
  insertOne (userOrUserId, item, callback, options) {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const prepared = this.applyDefaults(item);

    const cols = ['user_id'];
    const vals = [userId];
    const placeholders = ['$1'];
    let idx = 2;

    for (const [prop, val] of Object.entries(prepared)) {
      const colName = prop === 'id' ? this.idField : this.toCol(prop);
      cols.push(colName);
      vals.push(this.toPGValue(colName, val));
      placeholders.push(`$${idx}`);
      idx++;
    }

    const sql = `INSERT INTO ${this.tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
    this.db.query(sql, vals)
      .then((res) => {
        const result = this.rowToItem(res.rows[0]);
        delete result.deleted;
        callback(null, result);
      })
      .catch((err) => {
        const DatabasePG = require('../DatabasePG');
        DatabasePG.handleDuplicateError(err);
        callback(err);
      });
  }
}

module.exports = WebhooksPG;
