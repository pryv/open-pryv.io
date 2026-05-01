/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const path = require('path');
const fs = require('fs/promises');
const { LRUCache: LRU } = require('lru-cache');

const UserDatabase = require('./UserDatabase');
const migrations = require('./migrations');
const _internals = require('../_internals');

const CACHE_SIZE = 500;
const VERSION = '1.0.0';

class SqliteStorage {
  initialized: boolean = false;
  userDBsCache: any = null;
  options: any = null;
  id: string;
  logger: any;

  async init (): Promise<this> {
    if (this.initialized) {
      throw new Error('Database already initalized');
    }
    this.initialized = true;
    await _internals.userLocalDirectory.init();
    await migrations.migrateUserDBsIfNeeded(this);
    this.logger.debug('DB initialized');
    return this;
  }

  constructor (id: string, options?: any) {
    this.id = id;
    this.logger = _internals.getLogger(this.id + ':storage');
    this.options = options || {};
    this.userDBsCache = new LRU({
      max: this.options.max || CACHE_SIZE,
      dispose: function (db: any, _key: any) { db.close(); }
    });
  }

  getVersion (): string {
    return VERSION;
  }

  /**
   * @throws if not initalized
   */
  checkInitialized (): void {
    if (!this.initialized) throw new Error('Initialize db component before using it');
  }

  /**
   * get the database relative to a specific user
   */
  async forUser (userId: string): Promise<any> {
    this.logger.debug('forUser: ' + userId);
    this.checkInitialized();
    return this.userDBsCache.get(userId) || (await open(this, userId, this.logger));
  }

  /**
   * close and delete the database relative to a specific user
   */
  async deleteUser (userId: string): Promise<void> {
    this.logger.info('deleteUser: ' + userId);
    const userDb = await this.forUser(userId);
    await userDb.close();
    this.userDBsCache.delete(userId);
    const dbPath = await this.dbgetPathForUser(userId);
    try {
      await fs.unlink(dbPath);
    } catch (err) {
      this.logger.debug('deleteUser: Error' + err);
      throw err;
    }
  }

  close (): void {
    this.checkInitialized();
    this.userDBsCache.clear();
  }

  async dbgetPathForUser (userId: string): Promise<string> {
    const userPath = await _internals.userLocalDirectory.ensureUserDirectory(userId);
    return path.join(userPath, this.id + '-' + this.getVersion() + '.sqlite');
  }
}

async function open (storage: SqliteStorage, userId: string, logger: any): Promise<any> {
  logger.debug('open: ' + userId);
  const db = new UserDatabase(logger, { dbPath: await storage.dbgetPathForUser(userId) });
  await db.init();
  storage.userDBsCache.set(userId, db);
  return db;
}

module.exports = SqliteStorage;
