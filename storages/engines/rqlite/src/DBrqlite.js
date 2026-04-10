/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PlatformDB implementation backed by rqlite (distributed SQLite via Raft).
 * Same SQL as the local SQLite backend (DBsqlite.js) but accessed over HTTP.
 * Single-node: use SQLite engine. Multi-core: use this engine with rqlite sidecar.
 */
class DBrqlite {
  url;
  closed;

  constructor (url) {
    this.url = url || 'http://localhost:4001';
    this.closed = false;
  }

  async init () {
    await this.execute(
      'CREATE TABLE IF NOT EXISTS keyValue (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
    );
  }

  // --- Low-level HTTP methods --- //

  /**
   * Execute a write statement (INSERT, UPDATE, DELETE, CREATE).
   * @param {string} sql
   * @param {Array} [params]
   * @returns {Promise<Object>} rqlite result
   */
  async execute (sql, params) {
    const body = params ? [[sql, ...params]] : [[sql]];
    const res = await fetch(this.url + '/db/execute?timings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error(`rqlite execute failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    if (data.results?.[0]?.error) {
      throw new Error(`rqlite SQL error: ${data.results[0].error}`);
    }
    return data.results[0];
  }

  /**
   * Execute a read query (SELECT).
   * @param {string} sql
   * @param {Array} [params]
   * @returns {Promise<Array>} rows as objects
   */
  async query (sql, params) {
    const body = params ? [[sql, ...params]] : [[sql]];
    const res = await fetch(this.url + '/db/query?timings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error(`rqlite query failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    if (data.results?.[0]?.error) {
      throw new Error(`rqlite SQL error: ${data.results[0].error}`);
    }
    const result = data.results[0];
    if (!result.columns || !result.values) return [];
    // Convert columnar format to row objects
    return result.values.map(row => {
      const obj = {};
      for (let i = 0; i < result.columns.length; i++) {
        obj[result.columns[i]] = row[i];
      }
      return obj;
    });
  }

  // --- PlatformDB interface --- //

  async setUserUniqueField (username, field, value) {
    const key = getUserUniqueKey(field, value);
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, username]
    );
  }

  async setUserUniqueFieldIfNotExists (username, field, value) {
    const key = getUserUniqueKey(field, value);
    // Atomic: INSERT OR IGNORE, then check
    await this.execute(
      'INSERT OR IGNORE INTO keyValue (key, value) VALUES (?, ?)',
      [key, username]
    );
    const rows = await this.query(
      'SELECT value FROM keyValue WHERE key = ?',
      [key]
    );
    if (rows.length === 0) return false;
    return rows[0].value === username;
  }

  async deleteUserUniqueField (field, value) {
    const key = getUserUniqueKey(field, value);
    await this.execute('DELETE FROM keyValue WHERE key = ?', [key]);
  }

  async setUserIndexedField (username, field, value) {
    const key = getUserIndexedKey(username, field);
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, value]
    );
  }

  async deleteUserIndexedField (username, field) {
    const key = getUserIndexedKey(username, field);
    await this.execute('DELETE FROM keyValue WHERE key = ?', [key]);
  }

  async getUserIndexedField (username, field) {
    const key = getUserIndexedKey(username, field);
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : rows[0].value;
  }

  async getUsersUniqueField (field, value) {
    const key = getUserUniqueKey(field, value);
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : rows[0].value;
  }

  async getAllWithPrefix (prefix) {
    const rows = await this.query(
      "SELECT key, value FROM keyValue WHERE key LIKE (? || '%')",
      [prefix]
    );
    return rows.map(parseEntry);
  }

  async deleteAll () {
    await this.execute('DELETE FROM keyValue');
  }

  async close () {
    this.closed = true;
  }

  isClosed () {
    return this.closed;
  }

  // --- Migration methods --- //

  async exportAll () {
    return await this.getAllWithPrefix('user');
  }

  async importAll (data) {
    for (const entry of data) {
      if (entry.isUnique) {
        await this.setUserUniqueField(entry.username, entry.field, entry.value);
      } else {
        await this.setUserIndexedField(entry.username, entry.field, entry.value);
      }
    }
  }

  async clearAll () {
    return await this.deleteAll();
  }

  // --- User-to-core mapping --- //

  async setUserCore (username, coreId) {
    const key = getUserCoreKey(username);
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, coreId]
    );
  }

  async getUserCore (username) {
    const key = getUserCoreKey(username);
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : rows[0].value;
  }

  async getAllUserCores () {
    const rows = await this.query(
      "SELECT key, value FROM keyValue WHERE key LIKE 'user-core/%'"
    );
    return rows.map(row => ({
      username: row.key.slice('user-core/'.length),
      coreId: row.value
    }));
  }

  // --- Core registration --- //

  async setCoreInfo (coreId, info) {
    const key = 'core-info/' + coreId;
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, JSON.stringify(info)]
    );
  }

  async getCoreInfo (coreId) {
    const key = 'core-info/' + coreId;
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : JSON.parse(rows[0].value);
  }

  async getAllCoreInfos () {
    const rows = await this.query(
      "SELECT value FROM keyValue WHERE key LIKE 'core-info/%'"
    );
    return rows.map(row => JSON.parse(row.value));
  }

  // --- Invitation tokens --- //

  async createInvitationToken (token, info) {
    const key = 'invitation/' + token;
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, JSON.stringify(info)]
    );
  }

  async getInvitationToken (token) {
    const key = 'invitation/' + token;
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : JSON.parse(rows[0].value);
  }

  async getAllInvitationTokens () {
    const rows = await this.query(
      "SELECT key, value FROM keyValue WHERE key LIKE 'invitation/%'"
    );
    return rows.map(row => ({
      id: row.key.slice('invitation/'.length),
      ...JSON.parse(row.value)
    }));
  }

  async updateInvitationToken (token, info) {
    await this.createInvitationToken(token, info);
  }

  async deleteInvitationToken (token) {
    const key = 'invitation/' + token;
    await this.execute('DELETE FROM keyValue WHERE key = ?', [key]);
  }

  // --- DNS records (Plan 27 Phase 1) --- //

  async setDnsRecord (subdomain, records) {
    const key = getDnsRecordKey(subdomain);
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, JSON.stringify(records)]
    );
  }

  async getDnsRecord (subdomain) {
    const key = getDnsRecordKey(subdomain);
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : JSON.parse(rows[0].value);
  }

  async getAllDnsRecords () {
    const rows = await this.query(
      "SELECT key, value FROM keyValue WHERE key LIKE 'dns-record/%'"
    );
    return rows.map(row => ({
      subdomain: row.key.slice('dns-record/'.length),
      records: JSON.parse(row.value)
    }));
  }

  async deleteDnsRecord (subdomain) {
    const key = getDnsRecordKey(subdomain);
    await this.execute('DELETE FROM keyValue WHERE key = ?', [key]);
  }
}

// --- Key helpers (same as SQLite engine) --- //

function parseEntry (entry) {
  const [type, field, userNameOrValue] = entry.key.split('/');
  const isUnique = (type === 'user-unique');
  return {
    isUnique,
    field,
    username: isUnique ? entry.value : userNameOrValue,
    value: isUnique ? userNameOrValue : entry.value
  };
}

function getUserUniqueKey (field, value) {
  return 'user-unique/' + field + '/' + value;
}

function getUserIndexedKey (username, field) {
  return 'user-indexed/' + field + '/' + username;
}

function getUserCoreKey (username) {
  return 'user-core/' + username;
}

function getDnsRecordKey (subdomain) {
  return 'dns-record/' + subdomain;
}

module.exports = DBrqlite;
