/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { BaseStorageSQLite } = require('./BaseStorageSQLite.ts');
const { createId: generateId } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');

class WebhooksSQLite extends BaseStorageSQLite {
  constructor () {
    super();
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

  /**
   * Override `insertOne` to enforce the same uniqueness invariant the PG
   * engine gets from UNIQUE INDEX `idx_webhook_url` on
   * `(user_id, access_id, url) WHERE deleted IS NULL`. SQLite stores
   * webhook fields inside a JSON `data` TEXT column, so we can't lean on
   * a SQLite-side UNIQUE constraint; check at the JS layer before
   * INSERT and throw an error shaped like PG's so api-server's
   * `err.isDuplicateIndex('url')` branch keeps matching and emits 409.
   * Mirrors the AccessesSQLite.insertOne pattern.
   */
  insertOne (userOrUserId: any, item: any, callback: (err: any, item?: any) => void): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const prepared = this.applyDefaults(Object.assign({ deleted: null }, item));
    this.find(userId, { deleted: null }, null, (err: any, existing: any[]) => {
      if (err) return callback(err);
      for (const ex of (existing || [])) {
        if (ex.id === prepared.id) continue; // same row — defensive
        if (ex.accessId === prepared.accessId && ex.url === prepared.url) {
          return callback(duplicateIndexError(['url'], { url: prepared.url }));
        }
      }
      super.insertOne(userId, prepared, callback);
    });
  }

  delete (userOrUserId: any, query: any, callback: (err: any, res?: any) => void): void {
    this.updateMany(userOrUserId, query, {
      $set: { deleted: timestamp.now() },
      $unset: {
        accessId: 1, url: 1, state: 1, runCount: 1, failCount: 1,
        lastRun: 1, runs: 1, currentRetries: 1, maxRetries: 1,
        minIntervalMs: 1, created: 1, createdBy: 1, modified: 1, modifiedBy: 1
      }
    }, callback);
  }
}

/**
 * Build a duplicate-key error that mimics the shape attached by
 * `DatabasePG.handleDuplicateError`. The api-server methods only call
 * `err.isDuplicateIndex(key)`, so a thin shim is enough. Identical
 * shape to the AccessesSQLite helper of the same name.
 */
function duplicateIndexError (constraintKeys: string[], data: Record<string, any>): any {
  const err: any = new Error('duplicate key');
  err.isDuplicate = true;
  err.duplicateKeys = constraintKeys;
  err.data = data;
  err.isDuplicateIndex = (key: string): boolean => {
    return constraintKeys.includes(key);
  };
  return err;
}

export { WebhooksSQLite };
