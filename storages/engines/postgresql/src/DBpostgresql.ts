/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL implementation of PlatformDB.
 *
 * Single `platform_kv` table mirroring the rqlite engine's `keyValue`
 * shape (same key namespaces), so platform data migrates between the two
 * engines without transformation. Uniqueness-critical operations rely on
 * the PRIMARY KEY constraint — PostgreSQL is the serialization point.
 *
 * Single-core deployments only: PostgreSQL is not replicated across
 * cores, so multi-core platforms keep the rqlite engine (enforced at
 * boot by config-validation).
 */

import { createRequire } from 'node:module';
import type {
  PlatformEntry,
  AcmeAccount,
  TlsCertificate,
  CoreInfo,
  DnsRecord,
  InvitationTokenInfo
} from '../../../interfaces/platformStorage/PlatformDB.ts';
const require = createRequire(import.meta.url);

interface PgQueryResult { rows: Array<Record<string, unknown>>; rowCount?: number | null }
interface DbLike {
  ensureConnect: () => Promise<void>;
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
}

type Row = { key: string, value: string };

class DBpostgresql {
  db!: DbLike;
  closed: boolean = false;

  async init (): Promise<void> {
    const { _internals } = require('./_internals.ts');
    this.db = _internals.databasePG;
    await this.db.ensureConnect();
    await this.db.query(
      'CREATE TABLE IF NOT EXISTS platform_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
    );
    this.closed = false;
  }

  // --- Low-level helpers --- //

  async #set (key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO platform_kv (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }

  async #get (key: string): Promise<string | null> {
    const res = await this.db.query('SELECT value FROM platform_kv WHERE key = $1', [key]);
    return res.rows.length === 0 ? null : (res.rows[0].value as string);
  }

  async #delete (key: string): Promise<void> {
    await this.db.query('DELETE FROM platform_kv WHERE key = $1', [key]);
  }

  async #getWithPrefix (prefix: string): Promise<Row[]> {
    const res = await this.db.query(
      "SELECT key, value FROM platform_kv WHERE key LIKE $1 || '%'",
      [prefix]
    );
    return res.rows as Row[];
  }

  // --- PlatformDB interface --- //

  async setUserUniqueField (username: string, field: string, value: string): Promise<void> {
    await this.#set(getUserUniqueKey(field, value), username);
  }

  async setUserUniqueFieldIfNotExists (username: string, field: string, value: string): Promise<boolean> {
    const key = getUserUniqueKey(field, value);
    // Atomic: the INSERT either wins or yields to the existing row; the
    // read-back tells whose username holds the key.
    await this.db.query(
      'INSERT INTO platform_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, username]
    );
    const holder = await this.#get(key);
    return holder === username;
  }

  async deleteUserUniqueField (field: string, value: string): Promise<void> {
    await this.#delete(getUserUniqueKey(field, value));
  }

  async setUserIndexedField (username: string, field: string, value: string): Promise<void> {
    await this.#set(getUserIndexedKey(username, field), value);
  }

  async deleteUserIndexedField (username: string, field: string): Promise<void> {
    await this.#delete(getUserIndexedKey(username, field));
  }

  async getUserIndexedField (username: string, field: string): Promise<string | null> {
    return await this.#get(getUserIndexedKey(username, field));
  }

  async getUsersUniqueField (field: string, value: string): Promise<string | null> {
    return await this.#get(getUserUniqueKey(field, value));
  }

  async getAllWithPrefix (prefix: string): Promise<PlatformEntry[]> {
    const rows = await this.#getWithPrefix(prefix);
    return rows.map(parseEntry);
  }

  async deleteAll (): Promise<void> {
    await this.db.query('DELETE FROM platform_kv');
  }

  async close (): Promise<void> {
    this.closed = true;
  }

  isClosed (): boolean {
    return this.closed;
  }

  // --- Migration methods --- //

  async exportAll (): Promise<PlatformEntry[]> {
    // Only the two user-field namespaces — a bare 'user' prefix would also
    // match 'user-core/' rows, which parseEntry misreads (no username) and
    // importAll would then corrupt into bogus 'user-indexed/' keys.
    return [
      ...await this.getAllWithPrefix('user-unique/'),
      ...await this.getAllWithPrefix('user-indexed/')
    ];
  }

  async importAll (data: PlatformEntry[]): Promise<void> {
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
    await this.#set(getUserCoreKey(username), coreId);
  }

  async getUserCore (username: string): Promise<string | null> {
    return await this.#get(getUserCoreKey(username));
  }

  async getAllUserCores (): Promise<Array<{ username: string, coreId: string }>> {
    const rows = await this.#getWithPrefix('user-core/');
    return rows.map((row) => ({
      username: row.key.slice('user-core/'.length),
      coreId: row.value
    }));
  }

  // --- Core registration --- //

  async setCoreInfo (coreId: string, info: CoreInfo): Promise<void> {
    await this.#set('core-info/' + coreId, JSON.stringify(info));
  }

  async getCoreInfo (coreId: string): Promise<CoreInfo | null> {
    const value = await this.#get('core-info/' + coreId);
    return value == null ? null : JSON.parse(value);
  }

  async getAllCoreInfos (): Promise<CoreInfo[]> {
    const rows = await this.#getWithPrefix('core-info/');
    return rows.map((row) => JSON.parse(row.value));
  }

  // --- Invitation tokens --- //

  async createInvitationToken (token: string, info: InvitationTokenInfo): Promise<void> {
    await this.#set('invitation/' + token, JSON.stringify(info));
  }

  async getInvitationToken (token: string): Promise<InvitationTokenInfo | null> {
    const value = await this.#get('invitation/' + token);
    return value == null ? null : JSON.parse(value);
  }

  async getAllInvitationTokens (): Promise<Array<InvitationTokenInfo & { id: string }>> {
    const rows = await this.#getWithPrefix('invitation/');
    return rows.map((row) => ({
      id: row.key.slice('invitation/'.length),
      ...JSON.parse(row.value)
    }));
  }

  async updateInvitationToken (token: string, info: InvitationTokenInfo): Promise<void> {
    await this.createInvitationToken(token, info);
  }

  async deleteInvitationToken (token: string): Promise<void> {
    await this.#delete('invitation/' + token);
  }

  // --- DNS records --- //

  async setDnsRecord (subdomain: string, records: DnsRecord): Promise<void> {
    await this.#set(getDnsRecordKey(subdomain), JSON.stringify(records));
  }

  async getDnsRecord (subdomain: string): Promise<DnsRecord | null> {
    const value = await this.#get(getDnsRecordKey(subdomain));
    return value == null ? null : JSON.parse(value);
  }

  async getAllDnsRecords (): Promise<Array<{ subdomain: string, records: DnsRecord }>> {
    const rows = await this.#getWithPrefix('dns-record/');
    return rows.map((row) => ({
      subdomain: row.key.slice('dns-record/'.length),
      records: JSON.parse(row.value)
    }));
  }

  async deleteDnsRecord (subdomain: string): Promise<void> {
    await this.#delete(getDnsRecordKey(subdomain));
  }

  // --- ACME account + TLS certs (auto-renewed public certs) --- //

  async setAcmeAccount (account: AcmeAccount): Promise<void> {
    await this.#set(ACME_ACCOUNT_KEY, JSON.stringify(account));
  }

  async getAcmeAccount (): Promise<AcmeAccount | null> {
    const value = await this.#get(ACME_ACCOUNT_KEY);
    return value == null ? null : JSON.parse(value);
  }

  async setCertificate (hostname: string, cert: TlsCertificate): Promise<void> {
    await this.#set(getCertificateKey(hostname), JSON.stringify(cert));
  }

  async getCertificate (hostname: string): Promise<TlsCertificate | null> {
    const value = await this.#get(getCertificateKey(hostname));
    return value == null ? null : JSON.parse(value);
  }

  async listCertificates (): Promise<Array<{ hostname: string, issuedAt: number, expiresAt: number }>> {
    const rows = await this.#getWithPrefix('tls-cert/');
    return rows.map((row) => {
      const cert = JSON.parse(row.value);
      return {
        hostname: row.key.slice('tls-cert/'.length),
        issuedAt: cert.issuedAt,
        expiresAt: cert.expiresAt
      };
    });
  }

  async deleteCertificate (hostname: string): Promise<void> {
    await this.#delete(getCertificateKey(hostname));
  }

  // --- Observability config (optional APM) --- //

  async setObservabilityValue (key: string, value: string): Promise<void> {
    await this.#set(getObservabilityKey(key), value);
  }

  async getObservabilityValue (key: string): Promise<string | null> {
    return await this.#get(getObservabilityKey(key));
  }

  async getAllObservabilityValues (): Promise<Array<{ key: string, value: string }>> {
    const rows = await this.#getWithPrefix('observability/');
    return rows.map((row) => ({
      key: row.key.slice('observability/'.length),
      value: row.value
    }));
  }

  async deleteObservabilityValue (key: string): Promise<void> {
    await this.#delete(getObservabilityKey(key));
  }

  // --- Mail templates (in-process mail delivery) --- //

  async setMailTemplate (type: string, lang: string, part: string, pug: string): Promise<void> {
    await this.#set(getMailTemplateKey(type, lang, part), pug);
  }

  async getMailTemplate (type: string, lang: string, part: string): Promise<string | null> {
    return await this.#get(getMailTemplateKey(type, lang, part));
  }

  async getAllMailTemplates (): Promise<Array<{ type: string, lang: string, part: string, pug: string }>> {
    const rows = await this.#getWithPrefix('mail-template/');
    return rows.map((row) => {
      // key shape: `mail-template/<type>/<lang>/<part>` — segments never
      // contain '/' (guarded by setMailTemplate callers).
      const parts = row.key.split('/');
      return {
        type: parts[1],
        lang: parts[2],
        part: parts[3],
        pug: row.value
      };
    });
  }

  async deleteMailTemplate (type: string, lang: string, part?: string): Promise<void> {
    if (part != null) {
      await this.#delete(getMailTemplateKey(type, lang, part));
      return;
    }
    // Lang-wide delete; explicit prefix per lang so a missing part doesn't
    // accidentally wipe other langs.
    const prefix = 'mail-template/' + type + '/' + lang + '/';
    await this.db.query(
      "DELETE FROM platform_kv WHERE key LIKE $1 || '%'",
      [prefix]
    );
  }

  // --- Access-request state --- //

  async setAccessState (key: string, value: unknown, expiresAt: number): Promise<void> {
    await this.#set(getAccessStateKey(key), JSON.stringify({ value, expiresAt }));
  }

  async getAccessState (key: string): Promise<{ value: unknown, expiresAt: number } | null> {
    const storeKey = getAccessStateKey(key);
    const raw = await this.#get(storeKey);
    if (raw == null) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.expiresAt === 'number' && Date.now() > parsed.expiresAt) {
      // Lazy expire: drop the row so the next call doesn't pay this cost.
      await this.#delete(storeKey);
      return null;
    }
    return parsed;
  }

  async deleteAccessState (key: string): Promise<void> {
    await this.#delete(getAccessStateKey(key));
  }

  async sweepExpiredAccessStates (now = Date.now()): Promise<{ removed: number }> {
    const rows = await this.#getWithPrefix('access-state/');
    let removed = 0;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value);
        if (typeof parsed.expiresAt === 'number' && now > parsed.expiresAt) {
          await this.#delete(row.key);
          removed++;
        }
      } catch (_) {
        // malformed payload — drop it; safer than leaving rot.
        await this.#delete(row.key);
        removed++;
      }
    }
    return { removed };
  }
}

// --- Key helpers (same namespaces as the rqlite engine) --- //

function parseEntry (entry: Row): PlatformEntry {
  const [type, field, userNameOrValue] = entry.key.split('/');
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

export { DBpostgresql };
