/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { LRUCache: LRU } = require('lru-cache');
const UserAuditDatabasePG = require('./UserAuditDatabasePG');
const _internals = require('./_internals');

const CACHE_SIZE = 500;
const VERSION = '1.0.0';

class AuditStoragePG {
  initialized = false;
  userDBsCache = null;
  db = null;
  logger = null;

  constructor (db) {
    this.db = db;
    this.logger = _internals.getLogger('audit-storage-pg');
    this.userDBsCache = new LRU({
      max: CACHE_SIZE,
      dispose: function (db) { db.close(); }
    });
  }

  async init () {
    if (this.initialized) throw new Error('Database already initialized');
    this.initialized = true;
    await this.db.ensureConnect();
    this.logger.info('Audit storage (PG) initialized');
    return this;
  }

  getVersion () {
    return VERSION;
  }

  checkInitialized () {
    if (!this.initialized) throw new Error('Initialize db component before using it');
  }

  async forUser (userId) {
    this.checkInitialized();
    let userDb = this.userDBsCache.get(userId);
    if (!userDb) {
      userDb = new UserAuditDatabasePG(this.db, userId, this.logger);
      await userDb.init();
      this.userDBsCache.set(userId, userDb);
    }
    return userDb;
  }

  async deleteUser (userId) {
    this.logger.info('deleteUser: ' + userId);
    this.userDBsCache.delete(userId);
    await this.db.query('DELETE FROM audit_events WHERE user_id = $1', [userId]);
  }

  close () {
    this.checkInitialized();
    this.userDBsCache.clear();
    // Close the dedicated audit pool
    if (this.db) this.db.close().catch(() => {});
  }
}

module.exports = AuditStoragePG;
