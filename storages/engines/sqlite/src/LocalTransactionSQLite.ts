/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const concurrentSafeWrite = require('./concurrentSafeWrite.ts');

/**
 * Per-call transaction wrapper for the shared SQLite baseStorage DB.
 * SQLite's BEGIN/COMMIT/ROLLBACK is process-wide on the connection;
 * concurrentSafeWrite serializes the body so the BEGIN window is exclusive.
 */
type SqliteDb = { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };

class LocalTransactionSQLite {
  db: SqliteDb;

  constructor (db: SqliteDb) {
    this.db = db;
  }

  async run<T> (fn: (db: SqliteDb) => Promise<T> | T): Promise<T> {
    return await concurrentSafeWrite.execute(async () => {
      this.db.prepare('BEGIN').run();
      try {
        const out = await fn(this.db);
        this.db.prepare('COMMIT').run();
        return out;
      } catch (err) {
        try { this.db.prepare('ROLLBACK').run(); } catch (_) { /* swallow */ }
        throw err;
      }
    });
  }
}

export { LocalTransactionSQLite };
