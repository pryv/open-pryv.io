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
