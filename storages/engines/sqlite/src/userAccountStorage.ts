/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * SQLite storage for per-user data such as:
 * - Password and password history
 * - Per-store key-value data
 * The DB file is located in the root of each user account folder.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const path = require('path');
const SQLite3 = require('better-sqlite3');
const { LRUCache: LRU } = require('lru-cache');
const timestamp = require('unix-timestamp');
const { _internals } = require('./_internals.ts');
const encryption = require('utils').encryption;

const CACHE_SIZE = 100;
const VERSION = '1.0.0';
const DB_OPTIONS = {};

type Sqlite3Db = ReturnType<typeof openUserDB> extends Promise<infer T> ? T : never;
type SQLite3Instance = { prepare: (sql: string) => { run: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => Record<string, unknown> | undefined; iterate: (...args: unknown[]) => Iterable<Record<string, unknown>> }; pragma: (s: string) => unknown; unsafeMode: (b: boolean) => unknown; close: () => void };

let dbCache: InstanceType<typeof LRU> | null = null;

const InitStates = {
  NOT_INITIALIZED: -1,
  INITIALIZING: 0,
  READY: 1
};
let initState: number = InitStates.NOT_INITIALIZED;

const userAccountStorage = _internals.createUserAccountStorage({
  init,
  addPasswordHash,
  getPasswordHash,
  getCurrentPasswordTime,
  passwordExistsInHistory,
  clearHistory,
  getKeyValueDataForStore,
  getAccountFields,
  getAccountField,
  setAccountField,
  getAccountFieldHistory,
  deleteAccountField,
  _getPasswordHistory,
  _getAllStoreData,
  _clearStoreData,
  _exportAll,
  _importAll,
  _clearAll
});

export { userAccountStorage };

async function init () {
  while (initState === InitStates.INITIALIZING) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (initState === InitStates.READY) {
    return;
  }
  initState = InitStates.INITIALIZING;

  await _internals.userLocalDirectory.init();

  dbCache = new LRU({
    max: CACHE_SIZE,
    dispose: function (db: SQLite3Instance/* , key */) { db.close(); }
  });

  initState = InitStates.READY;
}

// PASSWORD MANAGEMENT

async function getPasswordHash (userId: string): Promise<string | undefined> {
  const db = await getUserDB(userId);
  const last = db.prepare('SELECT hash FROM passwords ORDER BY time DESC LIMIT 1').get() as { hash: string } | undefined;
  return last?.hash;
}

async function addPasswordHash (userId: string, passwordHash: string, createdBy: string, time: number = timestamp.now()): Promise<{ time: number, hash: string, createdBy: string }> {
  const db = await getUserDB(userId);
  const result = { time, hash: passwordHash, createdBy };
  db.prepare('INSERT INTO passwords (time, hash, createdBy) VALUES (@time, @hash, @createdBy)').run(result);
  return result;
}

async function getCurrentPasswordTime (userId: string): Promise<number> {
  const db = await getUserDB(userId);
  const last = db.prepare('SELECT hash, time FROM passwords ORDER BY time DESC LIMIT 1').get() as { hash: string; time: number } | undefined;
  if (!last) {
    throw new Error(`No password found in database for user id "${userId}"`);
  }
  return last.time;
}

async function passwordExistsInHistory (userId: string, password: string, historyLength: number): Promise<boolean> {
  const db = await getUserDB(userId);
  const getLastN = db.prepare('SELECT hash, time FROM passwords ORDER BY time DESC LIMIT ?');
  for (const entry of getLastN.iterate(historyLength) as Iterable<{ hash: string, time: number }>) {
    if (await encryption.compare(password, entry.hash)) {
      return true;
    }
  }
  return false;
}

// ACCOUNT FIELDS

async function getAccountFields (userId: string): Promise<Record<string, unknown>> {
  const db = await getUserDB(userId);
  // Get the latest value per field (highest time wins)
  const rows = db.prepare(
    'SELECT field, value FROM account_fields WHERE (field, time) IN ' +
    '(SELECT field, MAX(time) FROM account_fields GROUP BY field)'
  ).all();
  const fields: Record<string, unknown> = {};
  for (const row of rows as Array<{ field: string, value: string }>) {
    fields[row.field] = JSON.parse(row.value);
  }
  return fields;
}

async function getAccountField (userId: string, field: string): Promise<unknown | null> {
  const db = await getUserDB(userId);
  const row = db.prepare(
    'SELECT value FROM account_fields WHERE field = ? ORDER BY time DESC LIMIT 1'
  ).get(field) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

async function setAccountField (userId: string, field: string, value: unknown, createdBy: string, time: number = timestamp.now()): Promise<{ field: string, value: unknown, time: number, createdBy: string }> {
  const db = await getUserDB(userId);
  const item = { field, value: JSON.stringify(value), time, createdBy };
  db.prepare(
    'INSERT INTO account_fields (field, value, time, createdBy) VALUES (@field, @value, @time, @createdBy)'
  ).run(item);
  return { field, value, time, createdBy };
}

async function getAccountFieldHistory (userId: string, field: string, limit?: number): Promise<Array<{ value: unknown, time: number, createdBy: string }>> {
  const db = await getUserDB(userId);
  let stmt;
  let rows: Array<{ value: string; time: number; createdBy: string }>;
  if (limit != null) {
    stmt = db.prepare('SELECT value, time, createdBy FROM account_fields WHERE field = ? ORDER BY time DESC LIMIT ?');
    rows = stmt.all(field, limit) as Array<{ value: string; time: number; createdBy: string }>;
  } else {
    stmt = db.prepare('SELECT value, time, createdBy FROM account_fields WHERE field = ? ORDER BY time DESC');
    rows = stmt.all(field) as Array<{ value: string; time: number; createdBy: string }>;
  }
  return rows.map(r => ({ value: JSON.parse(r.value), time: r.time, createdBy: r.createdBy }));
}

async function deleteAccountField (userId: string, field: string): Promise<void> {
  const db = await getUserDB(userId);
  db.prepare('DELETE FROM account_fields WHERE field = ?').run(field);
}

/**
 * Retrieve all password history, used for migration
 */
async function _getPasswordHistory (userId: string): Promise<Array<{ hash: string; time: number }>> {
  const db = await getUserDB(userId);
  const res: Array<{ hash: string; time: number }> = [];
  const getALL = db.prepare('SELECT hash, time FROM passwords');
  for (const entry of getALL.iterate()) {
    res.push(entry as { hash: string; time: number });
  }
  return res;
}

/**
 * Retrieve all store data, used for migration
 */
async function _getAllStoreData (userId: string): Promise<Array<{ storeId: string; key: string; value: string }>> {
  const db = await getUserDB(userId);
  const res: Array<{ storeId: string; key: string; value: string }> = [];
  const getALL = db.prepare('SELECT * FROM storeKeyValueData');
  for (const entry of getALL.iterate()) {
    res.push(entry as { storeId: string; key: string; value: string });
  }
  return res;
}

/**
 * Clear store data for user, used for migration
 */
async function _clearStoreData (userId: string): Promise<void> {
  const db = await getUserDB(userId);
  db.prepare('DELETE FROM storeKeyValueData').run();
}

// PER-STORE KEY-VALUE DB

function getKeyValueDataForStore (storeId: string): StoreKeyValueData {
  return new StoreKeyValueData(storeId);
}

class StoreKeyValueData {
  storeId: string;

  constructor (storeId: string) {
    this.storeId = storeId;
  }

  async getAll (userId: string): Promise<Record<string, unknown>> {
    const db = await getUserDB(userId);
    const query = db.prepare('SELECT key, value FROM storeKeyValueData WHERE storeId = @storeId');
    const res: Record<string, unknown> = {};
    for (const item of query.iterate({ storeId: this.storeId }) as Iterable<{ key: string, value: string }>) {
      res[item.key] = JSON.parse(item.value);
    }
    return res;
  }

  async get (userId: string, key: string): Promise<unknown | null> {
    const db = await getUserDB(userId);
    const res = db.prepare('SELECT value FROM storeKeyValueData WHERE storeId = @storeId AND key = @key').get({
      storeId: this.storeId,
      key
    }) as { value?: string } | undefined;
    if (res?.value == null) return null;
    return JSON.parse(res.value);
  }

  async set (userId: string, key: string, value: unknown): Promise<void> {
    const db = await getUserDB(userId);
    if (value == null) {
      db.prepare('DELETE FROM storeKeyValueData WHERE storeId = @storeId AND key = @key)').run({
        storeId: this.storeId,
        key
      });
    } else {
      const valueStr = JSON.stringify(value);
      db.prepare('REPLACE INTO storeKeyValueData (storeId, key, value) VALUES (@storeId, @key, @value)').run({
        storeId: this.storeId,
        key,
        value: valueStr
      });
    }
  }
}

// COMMON FUNCTIONS

/**
 * For tests
 */
async function clearHistory (userId: string): Promise<void> {
  const db = await getUserDB(userId);
  db.prepare('DELETE FROM passwords').run();
}

// MIGRATION METHODS

async function _exportAll (userId: string): Promise<{ passwords: Array<{ hash: string; time: number }>, storeKeyValues: Array<{ storeId: string; key: string; value: string }>, accountFields: Array<{ field: string; value: unknown; time: number; createdBy: string }> }> {
  const passwords = await _getPasswordHistory(userId);
  const storeKeyValues = await _getAllStoreData(userId);
  const db = await getUserDB(userId);
  const accountFieldRows = db.prepare('SELECT field, value, time, createdBy FROM account_fields ORDER BY field, time DESC').all() as Array<{ field: string; value: string; time: number; createdBy: string }>;
  const accountFields = accountFieldRows.map(r => ({ field: r.field, value: JSON.parse(r.value), time: r.time, createdBy: r.createdBy }));
  return { passwords, storeKeyValues, accountFields };
}

type ImportData = {
  passwords?: Array<{ hash: string; createdBy: string; time: number }>;
  storeKeyValues?: Array<{ storeId: string; key: string; value: unknown }>;
  accountFields?: Array<{ field: string; value: unknown; createdBy: string; time: number }>;
};

async function _importAll (userId: string, data: ImportData): Promise<void> {
  if (data.passwords) {
    for (const p of data.passwords) {
      await addPasswordHash(userId, p.hash, p.createdBy, p.time);
    }
  }
  if (data.storeKeyValues) {
    const db = await getUserDB(userId);
    for (const kv of data.storeKeyValues) {
      const valueStr = typeof kv.value === 'string' ? kv.value : JSON.stringify(kv.value);
      db.prepare('REPLACE INTO storeKeyValueData (storeId, key, value) VALUES (@storeId, @key, @value)').run({
        storeId: kv.storeId,
        key: kv.key,
        value: valueStr
      });
    }
  }
  if (data.accountFields) {
    for (const af of data.accountFields) {
      await setAccountField(userId, af.field, af.value, af.createdBy, af.time);
    }
  }
}

async function _clearAll (userId: string): Promise<void> {
  await clearHistory(userId);
  await _clearStoreData(userId);
  const db = await getUserDB(userId);
  db.prepare('DELETE FROM account_fields').run();
}

// DB HELPERS

async function getUserDB (userId: string): Promise<SQLite3Instance> {
  return (dbCache!.get(userId) as SQLite3Instance) || (await openUserDB(userId));
}

async function openUserDB (userId: string): Promise<SQLite3Instance> {
  const userPath = await _internals.userLocalDirectory.ensureUserDirectory(userId);
  const dbPath = path.join(userPath, `account-${VERSION}.sqlite`);
  const db = new SQLite3(dbPath, DB_OPTIONS);
  db.pragma('journal_mode = WAL');
  db.unsafeMode(true);
  db.prepare('CREATE TABLE IF NOT EXISTS passwords (time REAL PRIMARY KEY, hash TEXT NOT NULL, createdBy TEXT NOT NULL);').run();
  db.prepare('CREATE INDEX IF NOT EXISTS passwords_hash ON passwords(hash);').run();
  db.prepare('CREATE TABLE IF NOT EXISTS storeKeyValueData (storeId TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (storeId, key));').run();
  db.prepare('CREATE INDEX IF NOT EXISTS storeKeyValueData_storeId ON storeKeyValueData(storeId);').run();
  db.prepare('CREATE TABLE IF NOT EXISTS account_fields (field TEXT NOT NULL, value TEXT, time REAL NOT NULL, createdBy TEXT NOT NULL, PRIMARY KEY (field, time));').run();
  db.prepare('CREATE INDEX IF NOT EXISTS account_fields_field ON account_fields(field);').run();
  dbCache!.set(userId, db);
  return db;
}
