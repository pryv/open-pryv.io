/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Callback, UserOrId, Query } from '../../../../interfaces/_shared/types.ts';
import type { StoredWebhook } from '../../../../interfaces/_shared/domain.ts';
const require = createRequire(import.meta.url);

const { BaseStorageSQLite } = require('./BaseStorageSQLite.ts') as typeof import('./BaseStorageSQLite.ts');
const { duplicateIndexError } = require('./AccessesSQLite.ts') as typeof import('./AccessesSQLite.ts');
const { createId: generateId } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');

class WebhooksSQLite extends BaseStorageSQLite<StoredWebhook> {
  constructor () {
    super();
    this.tableName = 'webhooks';
    this.hasDeletedCol = true;
    this.hasHeadIdCol = false;
  }

  applyDefaults (item: Partial<StoredWebhook>): StoredWebhook {
    const copy = Object.assign({}, item) as StoredWebhook;
    copy.id = copy.id || generateId();
    if (copy.deleted === undefined) copy.deleted = null;
    return copy;
  }

  /**
   * Enforce the uniqueness invariant the PG engine gets from UNIQUE INDEX
   * `idx_webhook_url` ON (user_id, access_id, url) WHERE deleted IS NULL.
   * SQLite stores webhook fields inside a JSON `data` TEXT column, so the
   * check happens at the JS layer before INSERT; the thrown error mimics
   * PG's shape so api-server's `err.isDuplicateIndex('url')` branch matches.
   */
  insertOne (userOrUserId: UserOrId, item: Partial<StoredWebhook>, callback: Callback<StoredWebhook | null>): void {
    const userId = this.getUserIdFromUserOrUserId(userOrUserId);
    const prepared = this.applyDefaults(item);
    this.findIncludingDeletionsAndVersions(userId, { deleted: null }, null, (err: Error | null, existing?: Array<StoredWebhook | null>) => {
      if (err) return callback(err);
      for (const ex of (existing || [])) {
        if (ex == null || ex.id === prepared.id) continue;
        if (ex.url != null && ex.url === prepared.url &&
            (ex.accessId ?? null) === (prepared.accessId ?? null)) {
          return callback(duplicateIndexError(['url'], { url: prepared.url }));
        }
      }
      super.insertOne(userId, prepared, callback);
    });
  }

  delete (userOrUserId: UserOrId, query: Query, callback: Callback<{ modifiedCount: number }>): void {
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

export { WebhooksSQLite };
