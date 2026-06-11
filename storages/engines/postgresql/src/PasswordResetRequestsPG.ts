/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createId: cuid } = require('@paralleldrive/cuid2');

const DEFAULT_MAX_AGE = 60 * 60 * 1000; // 1 hour

type PgDb = {
  query (sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};
import type { PasswordResetDoc as ResetDoc, PasswordResetImportDoc as ImportDoc } from '../../../interfaces/baseStorage/PasswordResetRequests.ts';
type ResetRow = { id: string; username: string; expires: Date };
type Cb<T = unknown> = (err: Error | null, result?: T) => void;

/**
 * PostgreSQL implementation of PasswordResetRequests storage.
 */
class PasswordResetRequestsPG {
  db: PgDb;
  options: { maxAge: number };

  constructor (db: PgDb, options?: { maxAge?: number }) {
    this.db = db;
    this.options = { maxAge: (options && options.maxAge) || DEFAULT_MAX_AGE };
  }

  /**
   * Get a password reset request by id and username.
   */
  get (id: string, username: string, callback: Cb<ResetDoc | null>): void {
    this.db.query(
      'SELECT id, username, expires FROM password_resets WHERE id = $1 AND username = $2',
      [id, username]
    )
      .then((res) => {
        const rows = res.rows as ResetRow[];
        if (rows.length === 0) return callback(null, null);
        const row = rows[0];
        if (new Date() >= new Date(row.expires)) {
          this.destroy(id, username, () => callback(null, null));
          return;
        }
        callback(null, { _id: row.id, username: row.username, expires: row.expires });
      })
      .catch(callback);
  }

  /**
   * Create a new password reset request.
   */
  generate (username: string, callback: Cb<string>): void {
    const id = cuid();
    const expires = this.getNewExpirationDate();
    this.db.query(
      'INSERT INTO password_resets (id, username, expires) VALUES ($1, $2, $3)',
      [id, username, expires]
    )
      .then(() => callback(null, id))
      .catch(callback);
  }

  /**
   * Delete a password reset request.
   */
  destroy (id: string, username: string, callback: Cb<unknown>): void {
    this.db.query(
      'DELETE FROM password_resets WHERE id = $1 AND username = $2',
      [id, username]
    )
      .then((res: unknown) => callback(null, res))
      .catch(callback);
  }

  /**
   * Delete all password reset requests.
   */
  clearAll (callback: Cb<unknown>): void {
    this.db.query('DELETE FROM password_resets')
      .then((res: unknown) => callback(null, res))
      .catch(callback);
  }

  getNewExpirationDate (): Date {
    return new Date(Date.now() + this.options.maxAge);
  }

  // -- Migration methods --

  exportAll (callback: Cb<ResetDoc[]>): void {
    this.db.query('SELECT id, username, expires FROM password_resets')
      .then((res) => {
        const rows = res.rows as ResetRow[];
        const docs = rows.map((r: ResetRow) => ({
          _id: r.id,
          username: r.username,
          expires: r.expires
        }));
        callback(null, docs);
      })
      .catch(callback);
  }

  importAll (data: ImportDoc[], callback: (err: Error | null) => void): void {
    if (!data || data.length === 0) return callback(null);
    const inserts = data.map((d: ImportDoc) =>
      this.db.query(
        'INSERT INTO password_resets (id, username, expires) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [d._id || d.id, d.username, d.expires]
      )
    );
    Promise.all(inserts)
      .then(() => callback(null))
      .catch(callback);
  }
}

export { PasswordResetRequestsPG };