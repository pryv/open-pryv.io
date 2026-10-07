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

const DEFAULT_MAX_AGE = 60 * 60 * 1000; // 1 hour

type PgDb = {
  query (sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};
import type { PasswordResetDoc as ResetDoc, PasswordResetImportDoc as ImportDoc } from '../../../interfaces/baseStorage/PasswordResetRequests.ts';
type ResetRow = { id: string; username: string; expires: Date };
type Cb<T = unknown> = (err: Error | null, result?: T) => void;

/**
 * PostgreSQL implementation of PasswordResetRequests storage.
 * Rows are keyed by the sha256 of the token; the token itself is not stored.
 */
class PasswordResetRequestsPG {
  db: PgDb;
  options: { maxAge: number };

  constructor (db: PgDb, options?: { maxAge?: number }) {
    this.db = db;
    this.options = { maxAge: (options && options.maxAge) || DEFAULT_MAX_AGE };
  }

  /**
   * Get the live password reset request matching a token and username.
   */
  get (token: string, username: string, callback: Cb<ResetDoc | null>): void {
    this.db.query(
      'SELECT id, username, expires FROM password_resets WHERE id = $1 AND username = $2 AND expires > $3',
      [hashResetToken(token), username, new Date()]
    )
      .then((res) => {
        const rows = res.rows as ResetRow[];
        if (rows.length === 0) return callback(null, null);
        callback(null, toDoc(rows[0]));
      })
      .catch(callback);
  }

  /**
   * Create a new password reset request, replacing any previous one of the
   * same username and removing expired ones. Returns the token.
   */
  generate (username: string, callback: Cb<string>): void {
    const token = cuid();
    const now = new Date();
    const expires = this.getNewExpirationDate();
    this.db.query(
      'WITH removed AS (DELETE FROM password_resets WHERE username = $2 OR expires <= $4) ' +
      'INSERT INTO password_resets (id, username, expires) VALUES ($1, $2, $3)',
      [hashResetToken(token), username, expires, now]
    )
      .then(() => callback(null, token))
      .catch(callback);
  }

  /**
   * Delete and return the live request matching a token and username.
   */
  consume (token: string, username: string, callback: Cb<ResetDoc | null>): void {
    this.db.query(
      'DELETE FROM password_resets WHERE id = $1 AND username = $2 AND expires > $3 RETURNING id, username, expires',
      [hashResetToken(token), username, new Date()]
    )
      .then((res) => {
        const rows = res.rows as ResetRow[];
        callback(null, rows.length === 0 ? null : toDoc(rows[0]));
      })
      .catch(callback);
  }

  /**
   * Delete a password reset request.
   */
  destroy (token: string, username: string, callback: Cb<unknown>): void {
    this.db.query(
      'DELETE FROM password_resets WHERE id = $1 AND username = $2',
      [hashResetToken(token), username]
    )
      .then((res: unknown) => callback(null, res))
      .catch(callback);
  }

  /**
   * Delete every password reset request of a username.
   */
  destroyAllForUser (username: string, callback: Cb<unknown>): void {
    this.db.query('DELETE FROM password_resets WHERE username = $1', [username])
      .then((res: unknown) => callback(null, res))
      .catch(callback);
  }

  /**
   * Delete expired password reset requests.
   */
  removeExpired (callback: Cb<unknown>): void {
    this.db.query('DELETE FROM password_resets WHERE expires <= $1', [new Date()])
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
        callback(null, rows.map(toDoc));
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

function toDoc (row: ResetRow): ResetDoc {
  return { _id: row.id, username: row.username, expires: row.expires };
}

export { PasswordResetRequestsPG };
