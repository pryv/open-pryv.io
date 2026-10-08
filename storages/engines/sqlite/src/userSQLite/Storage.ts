/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import { fileIdentity } from '../fileIdentity.ts';
const require = createRequire(import.meta.url);

const path = require('path');
const fs = require('fs/promises');
const { LRUCache: LRU } = require('lru-cache');

const { UserDatabase } = require('./UserDatabase.ts');
const migrations = require('./migrations/index.ts');
const { _internals } = require('../_internals.ts');

const CACHE_SIZE = 500;
const VERSION = '1.0.0';

interface UserDbLike { close: () => Promise<void> | void; init: () => Promise<void>; fileId?: string | null }
interface SqliteStorageOptions { max?: number; [k: string]: unknown }
import type { Logger } from '@pryv/boiler';

class SqliteStorage {
  initialized: boolean = false;
  userDBsCache!: { get: (key: string) => UserDbLike | undefined; set: (key: string, value: UserDbLike) => void; delete: (key: string) => void; clear: () => void };
  options: SqliteStorageOptions;
  id: string;
  logger: Logger;
  /** Opens in progress, shared by concurrent callers for the same user. */
  pendingOpens: Map<string, Promise<UserDbLike>> = new Map();

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
   *
   * A cached handle is only reused while it still points at the file on
   * disk (see `fileIdentity`): when another process deleted or replaced the
   * user's file (account deletion, restore), the stale handle is closed and
   * the file opened again. Costs one `stat` per call.
   */
  async forUser (userId: string): Promise<UserDbLike> {
    this.logger.debug('forUser: ' + userId);
    this.checkInitialized();
    const cached = this.userDBsCache.get(userId);
    if (cached != null) {
      if (cached.fileId != null && await fileIdentity(this.existingPathForUser(userId)) === cached.fileId) return cached;
      // Another caller may have reopened it while we were checking.
      if (this.userDBsCache.get(userId) === cached) {
        this.logger.debug(`forUser: ${this.id} database of ${userId} was removed or replaced, reopening`);
        this.userDBsCache.delete(userId); // dispose closes the stale handle
      }
    }
    return await this.openShared(userId);
  }

  /**
   * Open the user's database once for all concurrent callers: two handles
   * opened in parallel would have the second `set` dispose (close) the
   * first while its caller still uses it.
   */
  openShared (userId: string): Promise<UserDbLike> {
    const current = this.userDBsCache.get(userId);
    if (current != null) return Promise.resolve(current);
    let pending = this.pendingOpens.get(userId);
    if (pending == null) {
      pending = open(this, userId, this.logger).finally(() => { this.pendingOpens.delete(userId); });
      this.pendingOpens.set(userId, pending);
    }
    return pending;
  }

  /**
   * close and delete the database relative to a specific user
   */
  async deleteUser (userId: string): Promise<void> {
    this.logger.info('deleteUser: ' + userId);
    this.checkInitialized();
    this.userDBsCache.delete(userId); // dispose closes the local handle
    const dbPath = this.existingPathForUser(userId);
    // A WAL left next to a database created later under the same path
    // would be replayed into it.
    for (const file of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
      try {
        await fs.unlink(file);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        this.logger.debug('deleteUser: Error' + err);
        throw err;
      }
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

  /** The database file path, without creating its directory. */
  existingPathForUser (userId: string): string {
    return path.join(_internals.userLocalDirectory.getPathForUser(userId), this.id + '-' + this.getVersion() + '.sqlite');
  }
}

async function open (storage: SqliteStorage, userId: string, logger: Logger): Promise<UserDbLike> {
  logger.debug('open: ' + userId);
  const dbPath = await storage.dbgetPathForUser(userId);
  const db = new UserDatabase(logger, { dbPath });
  await db.init();
  db.fileId = await fileIdentity(dbPath);
  storage.userDBsCache.set(userId, db);
  return db;
}

export { SqliteStorage };
