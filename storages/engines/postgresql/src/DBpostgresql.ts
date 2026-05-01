/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL implementation of PlatformDB.
 * Uses `platform_unique_fields` and `platform_indexed_fields` tables.
 */

import type {} from 'node:fs';

class DBpostgresql {
  db: any;
  closed: boolean = false;

  async init (): Promise<void> {
    const _internals = require('./_internals');
    this.db = _internals.databasePG;
    await this.db.ensureConnect();
    this.closed = false;
  }

  async setUserUniqueField (username: string, field: string, value: string): Promise<void> {
    // Upsert: if (field, value) exists, update username
    await this.db.query(
      `INSERT INTO platform_unique_fields (field, value, username)
       VALUES ($1, $2, $3)
       ON CONFLICT (field, value) DO UPDATE SET username = $3`,
      [field, value, username]
    );
  }

  async setUserUniqueFieldIfNotExists (username: string, field: string, value: string): Promise<boolean> {
    // Atomic: INSERT only if no row exists for (field, value), or if same username
    const result = await this.db.query(
      `INSERT INTO platform_unique_fields (field, value, username)
       VALUES ($1, $2, $3)
       ON CONFLICT (field, value) DO NOTHING
       RETURNING field`,
      [field, value, username]
    );
    if (result.rows.length > 0) return true; // inserted
    // Check if the existing row is for the same user
    const existing = await this.db.query(
      'SELECT username FROM platform_unique_fields WHERE field = $1 AND value = $2',
      [field, value]
    );
    return existing.rows.length > 0 && existing.rows[0].username === username;
  }

  async deleteUserUniqueField (field: string, value: string): Promise<void> {
    await this.db.query(
      'DELETE FROM platform_unique_fields WHERE field = $1 AND value = $2',
      [field, value]
    );
  }

  async setUserIndexedField (username: string, field: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO platform_indexed_fields (username, field, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (username, field) DO UPDATE SET value = $3`,
      [username, field, value]
    );
  }

  async deleteUserIndexedField (username: string, field: string): Promise<void> {
    await this.db.query(
      'DELETE FROM platform_indexed_fields WHERE username = $1 AND field = $2',
      [username, field]
    );
  }

  async getUserIndexedField (username: string, field: string): Promise<string | null> {
    const res = await this.db.query(
      'SELECT value FROM platform_indexed_fields WHERE username = $1 AND field = $2',
      [username, field]
    );
    return res.rows.length > 0 ? res.rows[0].value : null;
  }

  async getUsersUniqueField (field: string, value: string): Promise<string | null> {
    const res = await this.db.query(
      'SELECT username FROM platform_unique_fields WHERE field = $1 AND value = $2',
      [field, value]
    );
    return res.rows.length > 0 ? res.rows[0].username : null;
  }

  async getAllWithPrefix (_prefix: string): Promise<any[]> {
    const uniqueRes = await this.db.query(
      'SELECT field, value, username FROM platform_unique_fields'
    );
    const indexedRes = await this.db.query(
      'SELECT field, value, username FROM platform_indexed_fields'
    );
    const result: any[] = [];
    for (const row of uniqueRes.rows) {
      result.push({
        isUnique: true,
        field: row.field,
        value: row.value,
        username: row.username
      });
    }
    for (const row of indexedRes.rows) {
      result.push({
        isUnique: false,
        field: row.field,
        value: row.value,
        username: row.username
      });
    }
    return result;
  }

  async deleteAll (): Promise<void> {
    await this.db.query('DELETE FROM platform_unique_fields');
    await this.db.query('DELETE FROM platform_indexed_fields');
  }

  async close (): Promise<void> {
    this.closed = true;
  }

  isClosed (): boolean {
    return this.closed;
  }

  // -- Migration methods --

  async exportAll (): Promise<any[]> {
    return await this.getAllWithPrefix('');
  }

  async importAll (data: any[]): Promise<void> {
    if (!data || data.length === 0) return;
    for (const entry of data) {
      if (entry.isUnique) {
        await this.setUserUniqueField(entry.username, entry.field, entry.value);
      } else {
        await this.setUserIndexedField(entry.username, entry.field, entry.value);
      }
    }
  }

  async clearAll (): Promise<void> {
    await this.deleteAll();
  }

  // --- User-to-core mapping --- //

  async setUserCore (username: string, coreId: string): Promise<void> {
    await this.setUserIndexedField(username, '_core', coreId);
  }

  async getUserCore (username: string): Promise<string | null> {
    return await this.getUserIndexedField(username, '_core');
  }

  async getAllUserCores (): Promise<Array<{ username: string, coreId: string }>> {
    const res = await this.db.query(
      "SELECT username, value FROM platform_indexed_fields WHERE field = '_core'"
    );
    return res.rows.map((row: any) => ({
      username: row.username,
      coreId: row.value
    }));
  }

  // --- Core registration --- //

  async setCoreInfo (coreId: string, info: any): Promise<void> {
    await this.setUserIndexedField('__cores__', coreId, JSON.stringify(info));
  }

  async getCoreInfo (coreId: string): Promise<any | null> {
    const val = await this.getUserIndexedField('__cores__', coreId);
    return val != null ? JSON.parse(val) : null;
  }

  async getAllCoreInfos (): Promise<any[]> {
    const res = await this.db.query(
      "SELECT value FROM platform_indexed_fields WHERE username = '__cores__'"
    );
    return res.rows.map((row: any) => JSON.parse(row.value));
  }
}

module.exports = DBpostgresql;
