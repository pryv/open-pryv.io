/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { BaseStoragePG } = require('./BaseStoragePG.ts');
const { createId: generateId } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');

type UserOrId = string | { id: string };
type WebhookItem = Record<string, unknown> & { id?: string; deleted?: number | null };
type Query = Record<string, unknown>;

/**
 * PostgreSQL persistence for webhooks.
 */
class WebhooksPG extends BaseStoragePG {
  constructor (db: unknown) {
    super(db);
    this.tableName = 'webhooks';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = false;
  }

  applyDefaults (item: WebhookItem): WebhookItem {
    const copy = Object.assign({}, item);
    copy.id = copy.id || generateId();
    if (copy.deleted === undefined) copy.deleted = null;
    return copy;
  }

  delete (userOrUserId: UserOrId, query: Query, callback: (err: Error | null, res?: unknown) => void): void {
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

  insertOne (userOrUserId: UserOrId, item: WebhookItem, callback: (err: Error | null, item?: WebhookItem) => void, _options?: unknown): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const prepared = this.applyDefaults(item);

    const cols: string[] = ['user_id'];
    const vals: unknown[] = [userId];
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
      .then((res: { rows: Array<Record<string, unknown>> }) => {
        const result = this.rowToItem(res.rows[0]) as WebhookItem;
        delete result.deleted;
        callback(null, result);
      })
      .catch((err: Error) => {
        const { DatabasePG } = require('../DatabasePG.ts');
        DatabasePG.handleDuplicateError(err);
        callback(err);
      });
  }
}

export { WebhooksPG };