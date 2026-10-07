/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createId: cuid } = require('@paralleldrive/cuid2');
const { hashResetToken } = require('../../../interfaces/baseStorage/PasswordResetRequests.ts');

const concurrentSafeWrite = require('./concurrentSafeWrite.ts');

import type { SqliteDb } from './types.ts';

const DEFAULT_MAX_AGE = 60 * 60 * 1000; // 1 hour

/**
 * SQLite implementation of PasswordResetRequests storage.
 * Backed by the shared `password_resets` table; `expires` is INTEGER (ms).
 * Rows are keyed by the sha256 of the token; the token itself is not stored.
 */
import type { PasswordResetDoc as ResetDoc, PasswordResetImportDoc as ImportDoc } from '../../../interfaces/baseStorage/PasswordResetRequests.ts';
type Cb<T = unknown> = (err: Error | null, res?: T) => void;
type ResetRow = { id: string; username: string; expires: number };

class PasswordResetRequestsSQLite {
  db: SqliteDb;
  options: { maxAge: number };

  constructor (database: { getDb: () => SqliteDb }, options?: { maxAge?: number }) {
    this.db = database.getDb();
    this.options = { maxAge: (options && options.maxAge) || DEFAULT_MAX_AGE };
  }

  get (token: string, username: string, callback: Cb<ResetDoc | null>): void {
    try {
      const row = this.db.prepare(
        'SELECT id, username, expires FROM password_resets WHERE id = ? AND username = ? AND expires > ?'
      ).get(hashResetToken(token), username, Date.now()) as ResetRow | undefined;
      callback(null, row ? toDoc(row) : null);
    } catch (err) {
      callback(err as Error);
    }
  }

  /**
   * Replaces any previous request of the same username and removes expired
   * ones, in one transaction. Returns the token.
   */
  generate (username: string, callback: Cb<string>): void {
    const token = cuid();
    const now = Date.now();
    const expires = now + this.options.maxAge;
    concurrentSafeWrite.execute(() => {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM password_resets WHERE username = ? OR expires <= ?').run(username, now);
        this.db.prepare('INSERT INTO password_resets (id, username, expires) VALUES (?, ?, ?)')
          .run(hashResetToken(token), username, expires);
      })();
    })
      .then(() => callback(null, token))
      .catch(callback);
  }

  consume (token: string, username: string, callback: Cb<ResetDoc | null>): void {
    let row: ResetRow | undefined;
    concurrentSafeWrite.execute(() => {
      row = this.db.prepare(
        'DELETE FROM password_resets WHERE id = ? AND username = ? AND expires > ? RETURNING id, username, expires'
      ).get(hashResetToken(token), username, Date.now()) as ResetRow | undefined;
    })
      .then(() => callback(null, row ? toDoc(row) : null))
      .catch(callback);
  }

  destroy (token: string, username: string, callback: Cb<unknown>): void {
    let res: unknown;
    concurrentSafeWrite.execute(() => {
      res = this.db.prepare('DELETE FROM password_resets WHERE id = ? AND username = ?').run(hashResetToken(token), username);
    })
      .then(() => callback(null, res))
      .catch(callback);
  }

  destroyAllForUser (username: string, callback: Cb<unknown>): void {
    let res: unknown;
    concurrentSafeWrite.execute(() => {
      res = this.db.prepare('DELETE FROM password_resets WHERE username = ?').run(username);
    })
      .then(() => callback(null, res))
      .catch(callback);
  }

  removeExpired (callback: Cb<unknown>): void {
    let res: unknown;
    concurrentSafeWrite.execute(() => {
      res = this.db.prepare('DELETE FROM password_resets WHERE expires <= ?').run(Date.now());
    })
      .then(() => callback(null, res))
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
      const rows = this.db.prepare('SELECT id, username, expires FROM password_resets').all() as ResetRow[];
      callback(null, rows.map(toDoc));
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

function toDoc (row: ResetRow): ResetDoc {
  return { _id: row.id, username: row.username, expires: new Date(row.expires) };
}

export { PasswordResetRequestsSQLite };
