/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createId: cuid } = require('@paralleldrive/cuid2');

const concurrentSafeWrite = require('./concurrentSafeWrite.ts');

import type { SqliteDb } from './types.ts';

const DEFAULT_MAX_AGE = 60 * 60 * 1000; // 1 hour

/**
 * SQLite implementation of PasswordResetRequests storage.
 * Backed by the shared `password_resets` table; `expires` is INTEGER (ms).
 */
type Cb<T = unknown> = (err: Error | null, res?: T) => void;
type ResetDoc = { _id: string; username: string; expires: Date };
type ImportDoc = { _id?: string; id?: string; username: string; expires: Date | number };

class PasswordResetRequestsSQLite {
  db: SqliteDb;
  options: { maxAge: number };

  constructor (database: { getDb: () => SqliteDb }, options?: { maxAge?: number }) {
    this.db = database.getDb();
    this.options = { maxAge: (options && options.maxAge) || DEFAULT_MAX_AGE };
  }

  get (id: string, username: string, callback: Cb<ResetDoc | null>): void {
    try {
      const row = this.db.prepare(
        'SELECT id, username, expires FROM password_resets WHERE id = ? AND username = ?'
      ).get(id, username) as { id: string; username: string; expires: number } | undefined;
      if (!row) return callback(null, null);
      if (Date.now() >= row.expires) {
        this.destroy(id, username, () => callback(null, null));
        return;
      }
      callback(null, { _id: row.id, username: row.username, expires: new Date(row.expires) });
    } catch (err) {
      callback(err as Error);
    }
  }

  generate (username: string, callback: Cb<string>): void {
    const id = cuid();
    const expires = Date.now() + this.options.maxAge;
    concurrentSafeWrite.execute(() => {
      this.db.prepare('INSERT INTO password_resets (id, username, expires) VALUES (?, ?, ?)')
        .run(id, username, expires);
    })
      .then(() => callback(null, id))
      .catch(callback);
  }

  destroy (id: string, username: string, callback: Cb<unknown>): void {
    concurrentSafeWrite.execute(() => {
      return this.db.prepare('DELETE FROM password_resets WHERE id = ? AND username = ?').run(id, username);
    })
      .then((res: unknown) => callback(null, res))
      .catch(callback);
  }

  clearAll (callback: Cb<unknown>): void {
    concurrentSafeWrite.execute(() => {
      return this.db.prepare('DELETE FROM password_resets').run();
    })
      .then((res: unknown) => callback(null, res))
      .catch(callback);
  }

  // -- Migration methods --

  exportAll (callback: Cb<ResetDoc[]>): void {
    try {
      const rows = this.db.prepare('SELECT id, username, expires FROM password_resets').all() as Array<{ id: string; username: string; expires: number }>;
      const docs = rows.map(r => ({
        _id: r.id,
        username: r.username,
        expires: new Date(r.expires)
      }));
      callback(null, docs);
    } catch (err) {
      callback(err as Error);
    }
  }

  importAll (data: ImportDoc[], callback: (err: Error | null) => void): void {
    if (!data || data.length === 0) return callback(null);
    concurrentSafeWrite.execute(() => {
      const stmt = this.db.prepare(
        'INSERT INTO password_resets (id, username, expires) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING'
      );
      const tx = this.db.transaction((items: ImportDoc[]) => {
        for (const d of items) {
          const id = d._id || d.id;
          const expires = d.expires instanceof Date ? d.expires.getTime() : Number(d.expires);
          stmt.run(id, d.username, expires);
        }
      });
      tx(data);
    })
      .then(() => callback(null))
      .catch(callback);
  }
}

export { PasswordResetRequestsSQLite };
