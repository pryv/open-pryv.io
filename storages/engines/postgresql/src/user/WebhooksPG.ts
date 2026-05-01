/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type {} from 'node:fs';

const BaseStoragePG = require('./BaseStoragePG');
const { createId: generateId } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');

/**
 * PostgreSQL persistence for webhooks.
 */
class WebhooksPG extends BaseStoragePG {
  constructor (db: any) {
    super(db);
    this.tableName = 'webhooks';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = false;
  }

  applyDefaults (item: any): any {
    const copy = Object.assign({}, item);
    copy.id = copy.id || generateId();
    if (copy.deleted === undefined) copy.deleted = null;
    return copy;
  }

  delete (userOrUserId: any, query: any, callback: (err: any, res?: any) => void): void {
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

  insertOne (userOrUserId: any, item: any, callback: (err: any, item?: any) => void, _options?: any): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const prepared = this.applyDefaults(item);

    const cols: string[] = ['user_id'];
    const vals: any[] = [userId];
    const placeholders: string[] = ['$1'];
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
      .then((res: any) => {
        const result = this.rowToItem(res.rows[0]);
        delete result.deleted;
        callback(null, result);
      })
      .catch((err: any) => {
        const DatabasePG = require('../DatabasePG');
        DatabasePG.handleDuplicateError(err);
        callback(err);
      });
  }
}

module.exports = WebhooksPG;
