/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type {
  PlatformEntry,
  AcmeAccount,
  TlsCertificate,
  CoreInfo,
  DnsRecord,
  InvitationTokenInfo
} from '../../../interfaces/platformStorage/PlatformDB.ts';

// All queries here hit the `keyValue` table (key TEXT, value TEXT).
type Row = Record<string, string>;
// rqlite speaks JSON — cell values are JSON scalars.
type RqliteCell = string | number | boolean | null;
type RqliteResult = { columns?: string[]; values?: RqliteCell[][]; rows_affected?: number; error?: string };

/**
 * PlatformDB implementation backed by rqlite (distributed SQLite via Raft).
 * Same SQL as the local SQLite backend (DBsqlite.js) but accessed over HTTP.
 * Single-node: use SQLite engine. Multi-core: use this engine with rqlite sidecar.
 */
class DBrqlite {
  url: string;
  closed: boolean;

  constructor (url?: string) {
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
   * @param [params]
   */
  async execute (sql: string, params?: unknown[]): Promise<RqliteResult> {
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
   * @param [params]
   */
  async query (sql: string, params?: unknown[]): Promise<Row[]> {
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
    // rqlite returns an empty `results` array during cluster election
    // (before a leader is established) — guard so we don't crash with
    // "Cannot read properties of undefined (reading 'columns')" on
    // api-server worker boot when the cluster is still warming up.
    if (!result) return [];
    if (!result.columns || !result.values) return [];
    // Convert columnar format to row objects
    return result.values.map((row: RqliteCell[]) => {
      const obj: Row = {};
      for (let i = 0; i < result.columns.length; i++) {
        obj[result.columns[i]] = row[i] as string; // keyValue columns are TEXT
      }
      return obj;
    });
  }

  // --- PlatformDB interface --- //

  async setUserUniqueField (username: string, field: string, value: string) {
    const key = getUserUniqueKey(field, value);
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, username]
    );
  }

  async setUserUniqueFieldIfNotExists (username: string, field: string, value: string) {
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

  async deleteUserUniqueField (field: string, value: string) {
    const key = getUserUniqueKey(field, value);
    await this.execute('DELETE FROM keyValue WHERE key = ?', [key]);
  }

  async setUserIndexedField (username: string, field: string, value: string) {
    const key = getUserIndexedKey(username, field);
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, value]
    );
  }

  async deleteUserIndexedField (username: string, field: string) {
    const key = getUserIndexedKey(username, field);
    await this.execute('DELETE FROM keyValue WHERE key = ?', [key]);
  }

  async getUserIndexedField (username: string, field: string) {
    const key = getUserIndexedKey(username, field);
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : rows[0].value;
  }

  async getUsersUniqueField (field: string, value: string) {
    const key = getUserUniqueKey(field, value);
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : rows[0].value;
  }

  async getAllWithPrefix (prefix: string) {
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

  async importAll (data: PlatformEntry[]) {
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

  async setUserCore (username: string, coreId: string) {
    const key = getUserCoreKey(username);
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, coreId]
    );
  }

  async getUserCore (username: string) {
    const key = getUserCoreKey(username);
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : rows[0].value;
  }

  async getAllUserCores () {
    const rows = await this.query(
      "SELECT key, value FROM keyValue WHERE key LIKE 'user-core/%'"
    );
    return rows.map((row: Row) => ({
      username: row.key.slice('user-core/'.length),
      coreId: row.value
    }));
  }

  // --- Core registration --- //

  async setCoreInfo (coreId: string, info: CoreInfo) {
    const key = 'core-info/' + coreId;
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, JSON.stringify(info)]
    );
  }

  async getCoreInfo (coreId: string) {
    const key = 'core-info/' + coreId;
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : JSON.parse(rows[0].value);
  }

  async getAllCoreInfos () {
    const rows = await this.query(
      "SELECT value FROM keyValue WHERE key LIKE 'core-info/%'"
    );
    return rows.map((row: Row) => JSON.parse(row.value));
  }

  // --- Invitation tokens --- //

  async createInvitationToken (token: string, info: InvitationTokenInfo) {
    const key = 'invitation/' + token;
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, JSON.stringify(info)]
    );
  }

  async getInvitationToken (token: string) {
    const key = 'invitation/' + token;
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : JSON.parse(rows[0].value);
  }

  async getAllInvitationTokens () {
    const rows = await this.query(
      "SELECT key, value FROM keyValue WHERE key LIKE 'invitation/%'"
    );
    return rows.map((row: Row) => ({
      id: row.key.slice('invitation/'.length),
      ...JSON.parse(row.value)
    }));
  }

  async updateInvitationToken (token: string, info: InvitationTokenInfo) {
    await this.createInvitationToken(token, info);
  }

  async deleteInvitationToken (token: string) {
    const key = 'invitation/' + token;
    await this.execute('DELETE FROM keyValue WHERE key = ?', [key]);
  }

  // --- DNS records --- //

  async setDnsRecord (subdomain: string, records: DnsRecord) {
    const key = getDnsRecordKey(subdomain);
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, JSON.stringify(records)]
    );
  }

  async getDnsRecord (subdomain: string) {
    const key = getDnsRecordKey(subdomain);
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : JSON.parse(rows[0].value);
  }

  async getAllDnsRecords () {
    const rows = await this.query(
      "SELECT key, value FROM keyValue WHERE key LIKE 'dns-record/%'"
    );
    return rows.map((row: Row) => ({
      subdomain: row.key.slice('dns-record/'.length),
      records: JSON.parse(row.value)
    }));
  }

  async deleteDnsRecord (subdomain: string) {
    const key = getDnsRecordKey(subdomain);
    await this.execute('DELETE FROM keyValue WHERE key = ?', [key]);
  }

  // --- ACME account + TLS certs (auto-renewed public certs) --- //

  async setAcmeAccount (account: AcmeAccount) {
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [ACME_ACCOUNT_KEY, JSON.stringify(account)]
    );
  }

  async getAcmeAccount () {
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [ACME_ACCOUNT_KEY]);
    return rows.length === 0 ? null : JSON.parse(rows[0].value);
  }

  async setCertificate (hostname: string, cert: TlsCertificate) {
    const key = getCertificateKey(hostname);
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [key, JSON.stringify(cert)]
    );
  }

  async getCertificate (hostname: string) {
    const key = getCertificateKey(hostname);
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [key]);
    return rows.length === 0 ? null : JSON.parse(rows[0].value);
  }

  async listCertificates () {
    const rows = await this.query(
      "SELECT key, value FROM keyValue WHERE key LIKE 'tls-cert/%'"
    );
    return rows.map((row: Row) => {
      const cert = JSON.parse(row.value);
      return {
        hostname: row.key.slice('tls-cert/'.length),
        issuedAt: cert.issuedAt,
        expiresAt: cert.expiresAt
      };
    });
  }

  async deleteCertificate (hostname: string) {
    const key = getCertificateKey(hostname);
    await this.execute('DELETE FROM keyValue WHERE key = ?', [key]);
  }

  // --- Observability config (optional APM) --- //

  async setObservabilityValue (key: string, value: string) {
    const storeKey = getObservabilityKey(key);
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [storeKey, value]
    );
  }

  async getObservabilityValue (key: string) {
    const storeKey = getObservabilityKey(key);
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [storeKey]);
    return rows.length === 0 ? null : rows[0].value;
  }

  async getAllObservabilityValues () {
    const rows = await this.query(
      "SELECT key, value FROM keyValue WHERE key LIKE 'observability/%'"
    );
    return rows.map((row: Row) => ({
      key: row.key.slice('observability/'.length),
      value: row.value
    }));
  }

  async deleteObservabilityValue (key: string) {
    const storeKey = getObservabilityKey(key);
    await this.execute('DELETE FROM keyValue WHERE key = ?', [storeKey]);
  }

  // --- Mail templates (in-process mail delivery) --- //

  async setMailTemplate (type: string, lang: string, part: string, pug: string) {
    const storeKey = getMailTemplateKey(type, lang, part);
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [storeKey, pug]
    );
  }

  async getMailTemplate (type: string, lang: string, part: string) {
    const storeKey = getMailTemplateKey(type, lang, part);
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [storeKey]);
    return rows.length === 0 ? null : rows[0].value;
  }

  async getAllMailTemplates () {
    const rows = await this.query(
      "SELECT key, value FROM keyValue WHERE key LIKE 'mail-template/%'"
    );
    return rows.map((row: Row) => {
      // key shape: `mail-template/<type>/<lang>/<part>`
      const parts = row.key.split('/');
      // parts[0] = 'mail-template', parts[1..-1] = type segments, parts[-2] = lang, parts[-1] = part
      // Templates never contain a '/' in any segment (guarded by setMailTemplate callers),
      // so the canonical 4-segment split is safe.
      return {
        type: parts[1],
        lang: parts[2],
        part: parts[3],
        pug: row.value
      };
    });
  }

  async deleteMailTemplate (type: string, lang: string, part?: string) {
    if (part != null) {
      const storeKey = getMailTemplateKey(type, lang, part);
      await this.execute('DELETE FROM keyValue WHERE key = ?', [storeKey]);
      return;
    }
    // Type-wide delete (both parts + both langs if lang is also null-ish).
    // Explicit branch per lang so a missing part doesn't accidentally wipe other langs.
    const prefix = 'mail-template/' + type + '/' + lang + '/';
    await this.execute(
      "DELETE FROM keyValue WHERE key LIKE (? || '%')",
      [prefix]
    );
  }

  // --- Access-request state --- //

  async setAccessState (key: string, value: unknown, expiresAt: number) {
    const storeKey = getAccessStateKey(key);
    await this.execute(
      'INSERT OR REPLACE INTO keyValue (key, value) VALUES (?, ?)',
      [storeKey, JSON.stringify({ value, expiresAt })]
    );
  }

  async getAccessState (key: string) {
    const storeKey = getAccessStateKey(key);
    const rows = await this.query('SELECT value FROM keyValue WHERE key = ?', [storeKey]);
    if (rows.length === 0) return null;
    const parsed = JSON.parse(rows[0].value);
    if (typeof parsed.expiresAt === 'number' && Date.now() > parsed.expiresAt) {
      // Lazy expire: drop the row so the next call doesn't pay this cost.
      await this.execute('DELETE FROM keyValue WHERE key = ?', [storeKey]);
      return null;
    }
    return parsed;
  }

  async deleteAccessState (key: string) {
    const storeKey = getAccessStateKey(key);
    await this.execute('DELETE FROM keyValue WHERE key = ?', [storeKey]);
  }

  async sweepExpiredAccessStates (now = Date.now()) {
    const rows = await this.query(
      "SELECT key, value FROM keyValue WHERE key LIKE 'access-state/%'"
    );
    let removed = 0;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value);
        if (typeof parsed.expiresAt === 'number' && now > parsed.expiresAt) {
          await this.execute('DELETE FROM keyValue WHERE key = ?', [row.key]);
          removed++;
        }
      } catch (_) {
        // malformed payload — drop it; safer than leaving rot.
        await this.execute('DELETE FROM keyValue WHERE key = ?', [row.key]);
        removed++;
      }
    }
    return { removed };
  }
}

// --- Key helpers (same as SQLite engine) --- //

function parseEntry (entry: Row): PlatformEntry {
  const [type, field, userNameOrValue] = (entry.key as string).split('/');
  const isUnique = (type === 'user-unique');
  return {
    isUnique,
    field,
    username: isUnique ? entry.value : userNameOrValue,
    value: isUnique ? userNameOrValue : entry.value
  };
}

function getUserUniqueKey (field: string, value: string) {
  return 'user-unique/' + field + '/' + value;
}

function getUserIndexedKey (username: string, field: string) {
  return 'user-indexed/' + field + '/' + username;
}

function getUserCoreKey (username: string) {
  return 'user-core/' + username;
}

function getDnsRecordKey (subdomain: string) {
  return 'dns-record/' + subdomain;
}

function getCertificateKey (hostname: string) {
  return 'tls-cert/' + hostname;
}

const ACME_ACCOUNT_KEY = 'tls-acme-account';

function getObservabilityKey (key: string) {
  return 'observability/' + key;
}

function getMailTemplateKey (type: string, lang: string, part: string) {
  return 'mail-template/' + type + '/' + lang + '/' + part;
}

function getAccessStateKey (key: string) {
  return 'access-state/' + key;
}

export { DBrqlite };
