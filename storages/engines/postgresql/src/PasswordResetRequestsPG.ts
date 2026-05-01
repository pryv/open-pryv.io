/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type {} from 'node:fs';

const { createId: cuid } = require('@paralleldrive/cuid2');

const DEFAULT_MAX_AGE = 60 * 60 * 1000; // 1 hour

/**
 * PostgreSQL implementation of PasswordResetRequests storage.
 */
class PasswordResetRequestsPG {
  db: any;
  options: { maxAge: number };

  constructor (db: any, options?: any) {
    this.db = db;
    this.options = { maxAge: (options && options.maxAge) || DEFAULT_MAX_AGE };
  }

  /**
   * Get a password reset request by id and username.
   */
  get (id: string, username: string, callback: (err: any, result?: any) => void): void {
    this.db.query(
      'SELECT id, username, expires FROM password_resets WHERE id = $1 AND username = $2',
      [id, username]
    )
      .then((res) => {
        if (res.rows.length === 0) return callback(null, null);
        const row = res.rows[0];
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
  generate (username: string, callback: (err: any, id?: string) => void): void {
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
  destroy (id: string, username: string, callback: (err: any, res?: any) => void): void {
    this.db.query(
      'DELETE FROM password_resets WHERE id = $1 AND username = $2',
      [id, username]
    )
      .then((res: any) => callback(null, res))
      .catch(callback);
  }

  /**
   * Delete all password reset requests.
   */
  clearAll (callback: (err: any, res?: any) => void): void {
    this.db.query('DELETE FROM password_resets')
      .then((res: any) => callback(null, res))
      .catch(callback);
  }

  getNewExpirationDate (): Date {
    return new Date(Date.now() + this.options.maxAge);
  }

  // -- Migration methods --

  exportAll (callback: (err: any, docs?: any[]) => void): void {
    this.db.query('SELECT id, username, expires FROM password_resets')
      .then((res: any) => {
        const docs = res.rows.map((r: any) => ({
          _id: r.id,
          username: r.username,
          expires: r.expires
        }));
        callback(null, docs);
      })
      .catch(callback);
  }

  importAll (data: any[], callback: (err: any) => void): void {
    if (!data || data.length === 0) return callback(null);
    const inserts = data.map((d: any) =>
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

module.exports = PasswordResetRequestsPG;
