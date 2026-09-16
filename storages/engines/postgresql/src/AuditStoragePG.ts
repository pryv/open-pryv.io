/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);

const { LRUCache: LRU } = require('lru-cache');
const { UserAuditDatabasePG } = require('./UserAuditDatabasePG.ts');
const { _internals } = require('./_internals.ts');

const CACHE_SIZE = 500;
const VERSION = '1.0.0';

type DbLike = {
  ensureConnect: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  close: () => Promise<void>;
};
type UserAuditDbLike = { init: () => Promise<void>; close: () => void };
type UserDbsLRU = {
  get: (key: string) => UserAuditDbLike | undefined;
  set: (key: string, value: UserAuditDbLike) => void;
  delete: (key: string) => void;
  clear: () => void;
};

class AuditStoragePG {
  initialized: boolean = false;
  userDBsCache: UserDbsLRU;
  db: DbLike;
  /**
   * Pool for STREAMED reads only, which hold a connection for the whole
   * response. Separate from `db` so a slow reader can never queue an audit
   * write behind it. Falls back to `db` when a caller builds this storage with
   * one pool (tests, and any embedder that predates the split).
   */
  readDb: DbLike;
  logger: Logger;

  constructor (db: DbLike, readDb?: DbLike) {
    this.db = db;
    this.readDb = readDb ?? db;
    this.logger = _internals.getLogger('audit-storage-pg');
    this.userDBsCache = new LRU({
      max: CACHE_SIZE,
      dispose: function (db: UserAuditDbLike) { db.close(); }
    });
  }

  async init (): Promise<this> {
    if (this.initialized) throw new Error('Database already initialized');
    this.initialized = true;
    await this.db.ensureConnect();
    if (this.readDb !== this.db) await this.readDb.ensureConnect();
    this.logger.info('Audit storage (PG) initialized');
    return this;
  }

  getVersion (): string {
    return VERSION;
  }

  checkInitialized (): void {
    if (!this.initialized) throw new Error('Initialize db component before using it');
  }

  async forUser (userId: string): Promise<UserAuditDbLike> {
    this.checkInitialized();
    let userDb = this.userDBsCache.get(userId);
    if (!userDb) {
      const fresh: UserAuditDbLike = new UserAuditDatabasePG(this.db, userId, this.logger, this.readDb);
      await fresh.init();
      this.userDBsCache.set(userId, fresh);
      userDb = fresh;
    }
    return userDb;
  }

  async deleteUser (userId: string): Promise<void> {
    this.logger.info('deleteUser: ' + userId);
    this.userDBsCache.delete(userId);
    await this.db.query('DELETE FROM audit_events WHERE user_id = $1', [userId]);
  }

  close (): void {
    this.checkInitialized();
    this.userDBsCache.clear();
    if (this.db) this.db.close().catch(() => {});
    if (this.readDb && this.readDb !== this.db) this.readDb.close().catch(() => {});
  }
}

export { AuditStoragePG };