/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const BaseStoragePG = require('./BaseStoragePG');

/**
 * PostgreSQL persistence for profile sets.
 *
 * The MongoDB Profile uses `convertIdToItemId: 'profileId'` — meaning
 * the public `id` field is stored as `profileId` in MongoDB.
 * In PG, the column is just `id` (primary key), so no remapping is needed.
 */
class ProfilePG extends BaseStoragePG {
  constructor (db) {
    super(db);
    this.tableName = 'profile';
    this.hasDeletedCol = false;
    this.hasHeadIdCol = false;
  }
}

module.exports = ProfilePG;
