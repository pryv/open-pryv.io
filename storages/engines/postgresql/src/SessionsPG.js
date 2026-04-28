/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { createId: cuid } = require('@paralleldrive/cuid2');

const DEFAULT_MAX_AGE = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * PostgreSQL implementation of Sessions storage.
 * Callback-based API matching the MongoDB Sessions interface.
 */
class SessionsPG {
  /** @type {import('./DatabasePG')} */
  db;
  options;

  constructor (db, options) {
    this.db = db;
    this.options = { maxAge: (options && options.maxAge) || DEFAULT_MAX_AGE };
  }

  /**
   * Get session data by id.
   * Destroys expired sessions on access.
   */
  get (id, callback) {
    this.db.query('SELECT data, expires FROM sessions WHERE id = $1', [id])
      .then((res) => {
        if (res.rows.length === 0) return callback(null, null);
        const row = res.rows[0];
        if (new Date() >= new Date(row.expires)) {
          this.destroy(id, () => callback(null, null));
          return;
        }
        callback(null, row.data);
      })
      .catch(callback);
  }

  /**
   * Find session by matching data fields.
   * Returns the session id if found and not expired.
   */
  getMatching (data, callback) {
    this.db.query('SELECT id, expires FROM sessions WHERE data @> $1', [JSON.stringify(data)])
      .then((res) => {
        if (res.rows.length === 0) return callback(null, null);
        const row = res.rows[0];
        if (new Date() >= new Date(row.expires)) {
          this.destroy(row.id, () => callback(null, null));
          return;
        }
        callback(null, row.id);
      })
      .catch(callback);
  }

  /**
   * Create a new session.
   * Returns the generated session id via callback.
   */
  generate (data, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const id = cuid();
    const sessionData = (data && typeof data === 'object') ? data : {};
    const expires = this.getNewExpirationDate();
    this.db.query(
      'INSERT INTO sessions (id, data, expires) VALUES ($1, $2, $3)',
      [id, JSON.stringify(sessionData), expires]
    )
      .then(() => callback(null, id))
      .catch(callback);
  }

  /**
   * Renew expiration for a session.
   */
  touch (id, callback) {
    const expires = this.getNewExpirationDate();
    this.db.query('UPDATE sessions SET expires = $1 WHERE id = $2', [expires, id])
      .then((res) => callback(null, res))
      .catch(callback);
  }

  /**
   * Force-expire a session (for tests).
   */
  expireNow (id, callback) {
    this.db.query('UPDATE sessions SET expires = $1 WHERE id = $2', [new Date(), id])
      .then((res) => callback(null, res))
      .catch(callback);
  }

  /**
   * Delete a session.
   */
  destroy (id, callback) {
    this.db.query('DELETE FROM sessions WHERE id = $1', [id])
      .then((res) => callback(null, res))
      .catch(callback);
  }

  /**
   * Delete all sessions.
   */
  clearAll (callback) {
    this.db.query('DELETE FROM sessions')
      .then((res) => callback(null, res))
      .catch(callback);
  }

  /**
   * Delete sessions whose data matches the given fields.
   * @param {{ [field: string]: string }} query — plain key/value to match inside data JSONB
   */
  remove (query, callback) {
    const keys = Object.keys(query);
    if (keys.length === 0) return this.clearAll(callback);
    const conditions = keys.map((k, i) => `data->>'${k}' = $${i + 1}`);
    const values = keys.map((k) => String(query[k]));
    this.db.query(`DELETE FROM sessions WHERE ${conditions.join(' AND ')}`, values)
      .then((res) => callback(null, res))
      .catch(callback);
  }

  getNewExpirationDate () {
    return new Date(Date.now() + this.options.maxAge);
  }

  // -- Migration methods --

  exportAll (callback) {
    this.db.query('SELECT id, data, expires FROM sessions')
      .then((res) => {
        const docs = res.rows.map((r) => ({
          _id: r.id,
          data: r.data,
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
        'INSERT INTO sessions (id, data, expires) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [d._id || d.id, JSON.stringify(d.data), d.expires]
      )
    );
    Promise.all(inserts)
      .then(() => callback(null))
      .catch(callback);
  }
}

module.exports = SessionsPG;
