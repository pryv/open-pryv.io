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

export { WebhooksSQLite };
