/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { BaseStoragePG } = require('./BaseStoragePG');

/**
 * PostgreSQL persistence for profile sets.
 */
class ProfilePG extends BaseStoragePG {
  constructor (db: any) {
    super(db);
    this.tableName = 'profile';
    this.hasDeletedCol = false;
    this.hasHeadIdCol = false;
  }
}

export { ProfilePG };