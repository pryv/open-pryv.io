/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const cuid = require('cuid');

const DEFAULT_MAX_AGE = 60 * 60 * 1000; // 1 hour

/**
 * PostgreSQL implementation of PasswordResetRequests storage.
 * Callback-based API matching the MongoDB PasswordResetRequests interface.
 */
class PasswordResetRequestsPG {
  /** @type {import('./DatabasePG')} */
  db;
  options;

  constructor (db, options) {
    this.db = db;
    this.options = { maxAge: (options && options.maxAge) || DEFAULT_MAX_AGE };
  }

  /**
   * Get a password reset request by id and username.
   * Destroys expired requests on access.
   */
  get (id, username, callback) {
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
   * Returns the generated id via callback.
   */
  generate (username, callback) {
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
  destroy (id, username, callback) {
    this.db.query(
      'DELETE FROM password_resets WHERE id = $1 AND username = $2',
      [id, username]
    )
      .then((res) => callback(null, res))
      .catch(callback);
  }

  /**
   * Delete all password reset requests.
   */
  clearAll (callback) {
    this.db.query('DELETE FROM password_resets')
      .then((res) => callback(null, res))
      .catch(callback);
  }

  getNewExpirationDate () {
    return new Date(Date.now() + this.options.maxAge);
  }

  // -- Migration methods --

  exportAll (callback) {
    this.db.query('SELECT id, username, expires FROM password_resets')
      .then((res) => {
        const docs = res.rows.map((r) => ({
          _id: r.id,
          username: r.username,
          expires: r.expires
        }));
        callback(null, docs);
      })
      .catch(callback);
  }

  importAll (data, callback) {
    if (!data || data.length === 0) return callback(null);
    const inserts = data.map((d) =>
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
