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

import type {} from 'node:fs';

class UsersLocalIndexPG {
  db: any;

  async init (): Promise<void> {
    const _internals = require('./_internals');
    this.db = _internals.databasePG;
    await this.db.ensureConnect();
  }

  async addUser (username: string, userId: string): Promise<void> {
    await this.db.query(
      'INSERT INTO users_index (username, user_id) VALUES ($1, $2)',
      [username, userId]
    );
  }

  async getIdForName (username: string): Promise<string | undefined> {
    const res = await this.db.query(
      'SELECT user_id FROM users_index WHERE username = $1',
      [username]
    );
    return res.rows.length > 0 ? res.rows[0].user_id : undefined;
  }

  async getNameForId (userId: string): Promise<string | undefined> {
    const res = await this.db.query(
      'SELECT username FROM users_index WHERE user_id = $1',
      [userId]
    );
    return res.rows.length > 0 ? res.rows[0].username : undefined;
  }

  async getAllByUsername (): Promise<Record<string, string>> {
    const res = await this.db.query('SELECT username, user_id FROM users_index');
    const result: Record<string, string> = {};
    for (const row of res.rows) {
      result[row.username] = row.user_id;
    }
    return result;
  }

  async deleteAll (): Promise<void> {
    await this.db.query('DELETE FROM users_index');
  }

  async deleteById (userId: string): Promise<void> {
    await this.db.query('DELETE FROM users_index WHERE user_id = $1', [userId]);
  }

  // -- Migration methods --

  async exportAll (): Promise<Record<string, string>> {
    return await this.getAllByUsername();
  }

  async importAll (data: Record<string, string>): Promise<void> {
    if (!data || Object.keys(data).length === 0) return;
    for (const [username, userId] of Object.entries(data)) {
      await this.db.query(
        'INSERT INTO users_index (username, user_id) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
        [username, userId]
      );
    }
  }

  async clearAll (): Promise<void> {
    await this.deleteAll();
  }
}

module.exports = UsersLocalIndexPG;
