/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);

const path = require('path');
const fs = require('fs');
const SQLite3 = require('better-sqlite3');

const concurrentSafeWrite = require('./concurrentSafeWrite.ts');
const { _internals } = require('./_internals.ts');

/**
 * Shared SQLite connection backing the cross-user baseStorage collections
 * (sessions, password reset requests). Per-user collections (accesses,
 * webhooks, profile, streams) use the userSQLite per-user file pattern via
 * SqliteStorage / UserDatabase.
 *
 * The shared file lives at `<sqlite.path>/_shared/baseStorage.sqlite`.
 */
import type { SqliteDb } from './types.ts';

class DatabaseSQLite {
  db!: SqliteDb;
  dbPath: string;
  logger: Logger;
  initialized: boolean = false;

  constructor () {
    this.logger = _internals.lazyLogger('sqlite:baseStorage');
    const base = _internals.config && _internals.config.path;
    if (!base) {
      throw new Error('SQLite engine config missing `path`');
    }
    const sharedDir = path.join(base, '_shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    this.dbPath = path.join(sharedDir, 'baseStorage.sqlite');
  }

  async init (): Promise<void> {
    if (this.initialized) return;
    this.db = new SQLite3(this.dbPath);
    await concurrentSafeWrite.initWALAndConcurrentSafeWriteCapabilities(this.db);

    await concurrentSafeWrite.execute(() => {
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          expires INTEGER NOT NULL
        )
      `).run();
    });

    await concurrentSafeWrite.execute(() => {
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS password_resets (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          expires INTEGER NOT NULL
        )
      `).run();
    });

    await concurrentSafeWrite.execute(() => {
      this.db.prepare('CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires)').run();
    });
    await concurrentSafeWrite.execute(() => {
      this.db.prepare('CREATE INDEX IF NOT EXISTS password_resets_username ON password_resets(username)').run();
    });

    this.initialized = true;
  }

  getDb (): SqliteDb {
    if (!this.initialized) throw new Error('DatabaseSQLite not initialized');
    return this.db;
  }

  async waitForConnection (): Promise<void> {
    if (!this.initialized) await this.init();
  }

  close (): void {
    if (this.db) {
      this.db.close();
      this.db = null as unknown as SqliteDb;
      this.initialized = false;
    }
  }
}

export { DatabaseSQLite };
