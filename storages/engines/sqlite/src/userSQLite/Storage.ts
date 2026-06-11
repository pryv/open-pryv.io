/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const path = require('path');
const fs = require('fs/promises');
const { LRUCache: LRU } = require('lru-cache');

const { UserDatabase } = require('./UserDatabase.ts');
const migrations = require('./migrations/index.ts');
const { _internals } = require('../_internals.ts');

const CACHE_SIZE = 500;
const VERSION = '1.0.0';

interface UserDbLike { close: () => Promise<void> | void; init: () => Promise<void> }
interface SqliteStorageOptions { max?: number; [k: string]: unknown }
import type { Logger } from '@pryv/boiler';

class SqliteStorage {
  initialized: boolean = false;
  userDBsCache!: { get: (key: string) => UserDbLike | undefined; set: (key: string, value: UserDbLike) => void; delete: (key: string) => void; clear: () => void };
  options: SqliteStorageOptions;
  id: string;
  logger: Logger;

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

  constructor (id: string, options?: SqliteStorageOptions) {
    this.id = id;
    this.logger = _internals.getLogger(this.id + ':storage');
    this.options = options || {};
    this.userDBsCache = new LRU({
      max: this.options.max || CACHE_SIZE,
      dispose: function (db: UserDbLike, _key: string) { db.close(); }
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
  async forUser (userId: string): Promise<UserDbLike> {
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

async function open (storage: SqliteStorage, userId: string, logger: Logger): Promise<UserDbLike> {
  logger.debug('open: ' + userId);
  const db = new UserDatabase(logger, { dbPath: await storage.dbgetPathForUser(userId) });
  await db.init();
  storage.userDBsCache.set(userId, db);
  return db;
}

export { SqliteStorage };
