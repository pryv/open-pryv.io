/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const path = require('path');
const fs = require('fs');
const SQLite3 = require('better-sqlite3');
const { LRUCache: LRU } = require('lru-cache');

const concurrentSafeWrite = require('../concurrentSafeWrite.ts');
const { _internals } = require('../_internals.ts');

const CACHE_SIZE = 500;
const VERSION = '1.0.0';

/**
 * Per-user SQLite file holding the baseStorage tables
 * (accesses, profile, streams, webhooks) for a single user. File path:
 * `<userLocalDirectory>/<userId>/baseStorage-<version>.sqlite`.
 *
 * Schema per table — minimal, with id + (optional) headId + deleted as
 * proper columns for fast filtering, and everything else packed into a
 * JSON `data` TEXT column:
 *
 *   CREATE TABLE <name> (
 *     id      TEXT PRIMARY KEY,
 *     head_id TEXT,                    -- when withHeadId
 *     deleted INTEGER,                  -- when withDeleted
 *     data    TEXT NOT NULL
 *   );
 *   CREATE INDEX … ON <name>(deleted) WHEN withDeleted
 *   CREATE INDEX … ON <name>(head_id) WHEN withHeadId
 */
type SqliteDb = { prepare: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] }; close: () => void; [k: string]: unknown };
type UserDbLRU = {
  get: (key: string) => UserBaseStorageDb | undefined;
  set: (key: string, value: UserBaseStorageDb) => void;
  delete: (key: string) => void;
};

class UserBaseStorageDb {
  static cache: UserDbLRU = new LRU({
    max: CACHE_SIZE,
    dispose (db: UserBaseStorageDb, _key: string) { db.db?.close(); }
  });

  static async forUser (userId: string): Promise<UserBaseStorageDb> {
    let inst = UserBaseStorageDb.cache.get(userId);
    if (inst) return inst;
    const userDir = await _internals.userLocalDirectory.ensureUserDirectory(userId);
    const dbPath = path.join(userDir, `baseStorage-${VERSION}.sqlite`);
    inst = new UserBaseStorageDb(dbPath);
    await inst.init();
    UserBaseStorageDb.cache.set(userId, inst);
    return inst;
  }

  static evict (userId: string): void {
    UserBaseStorageDb.cache.delete(userId);
  }

  db!: SqliteDb;
  dbPath: string;
  knownTables: Set<string> = new Set();

  constructor (dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new SQLite3(dbPath);
  }

  async init (): Promise<void> {
    await concurrentSafeWrite.initWALAndConcurrentSafeWriteCapabilities(this.db);
  }

  async ensureTable (name: string, opts: { withDeleted: boolean, withHeadId: boolean }): Promise<void> {
    if (this.knownTables.has(name)) return;
    const cols: string[] = ['id TEXT PRIMARY KEY'];
    if (opts.withHeadId) cols.push('head_id TEXT');
    if (opts.withDeleted) cols.push('deleted INTEGER');
    cols.push('data TEXT NOT NULL');

    await concurrentSafeWrite.execute(() => {
      this.db.prepare(`CREATE TABLE IF NOT EXISTS ${name} (${cols.join(', ')})`).run();
    });
    if (opts.withDeleted) {
      await concurrentSafeWrite.execute(() => {
        this.db.prepare(`CREATE INDEX IF NOT EXISTS ${name}_deleted ON ${name}(deleted)`).run();
      });
    }
    if (opts.withHeadId) {
      await concurrentSafeWrite.execute(() => {
        this.db.prepare(`CREATE INDEX IF NOT EXISTS ${name}_head_id ON ${name}(head_id)`).run();
      });
    }
    this.knownTables.add(name);
  }

  close (): void {
    if (this.db) {
      this.db.close();
      this.db = null as unknown as SqliteDb;
    }
  }
}

export { UserBaseStorageDb };
