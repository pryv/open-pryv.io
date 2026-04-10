/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL implementation of UsersLocalIndexDB.
 * Uses the shared `users_index` table.
 */
class UsersLocalIndexPG {
  /** @type {import('./DatabasePG')} */
  db;

  async init () {
    const _internals = require('./_internals');
    this.db = _internals.databasePG;
    await this.db.ensureConnect();
  }

  async addUser (username, userId) {
    await this.db.query(
      'INSERT INTO users_index (username, user_id) VALUES ($1, $2)',
      [username, userId]
    );
  }

  async getIdForName (username) {
    const res = await this.db.query(
      'SELECT user_id FROM users_index WHERE username = $1',
      [username]
    );
    return res.rows.length > 0 ? res.rows[0].user_id : undefined;
  }

  async getNameForId (userId) {
    const res = await this.db.query(
      'SELECT username FROM users_index WHERE user_id = $1',
      [userId]
    );
    return res.rows.length > 0 ? res.rows[0].username : undefined;
  }

  async getAllByUsername () {
    const res = await this.db.query('SELECT username, user_id FROM users_index');
    const result = {};
    for (const row of res.rows) {
      result[row.username] = row.user_id;
    }
    return result;
  }

  async deleteAll () {
    await this.db.query('DELETE FROM users_index');
  }

  async deleteById (userId) {
    await this.db.query('DELETE FROM users_index WHERE user_id = $1', [userId]);
  }

  // -- Migration methods --

  async exportAll () {
    return await this.getAllByUsername();
  }

  async importAll (data) {
    if (!data || Object.keys(data).length === 0) return;
    for (const [username, userId] of Object.entries(data)) {
      await this.db.query(
        'INSERT INTO users_index (username, user_id) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
        [username, userId]
      );
    }
  }

  async clearAll () {
    await this.deleteAll();
  }
}

module.exports = UsersLocalIndexPG;
