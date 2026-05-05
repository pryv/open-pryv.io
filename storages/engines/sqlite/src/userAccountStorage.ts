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
const { _internals } = require('./_internals');
const encryption = require('utils').encryption;

const CACHE_SIZE = 100;
const VERSION = '1.0.0';
const DB_OPTIONS = {};

let dbCache: any = null;

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
    dispose: function (db/* , key */) { db.close(); }
  });

  initState = InitStates.READY;
}

// PASSWORD MANAGEMENT

async function getPasswordHash (userId: string): Promise<string | undefined> {
  const db = await getUserDB(userId);
  const last = db.prepare('SELECT hash FROM passwords ORDER BY time DESC LIMIT 1').get();
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
  const last = db.prepare('SELECT hash, time FROM passwords ORDER BY time DESC LIMIT 1').get();
  if (!last) {
    throw new Error(`No password found in database for user id "${userId}"`);
  }
  return last.time;
}

async function passwordExistsInHistory (userId: string, password: string, historyLength: number): Promise<boolean> {
  const db = await getUserDB(userId);
  const getLastN = db.prepare('SELECT hash, time FROM passwords ORDER BY time DESC LIMIT ?');
  for (const entry of getLastN.iterate(historyLength)) {
    if (await encryption.compare(password, (entry as any).hash)) {
      return true;
    }
  }
  return false;
}

// ACCOUNT FIELDS

async function getAccountFields (userId: string): Promise<Record<string, any>> {
  const db = await getUserDB(userId);
  // Get the latest value per field (highest time wins)
  const rows = db.prepare(
    'SELECT field, value FROM account_fields WHERE (field, time) IN ' +
    '(SELECT field, MAX(time) FROM account_fields GROUP BY field)'
  ).all();
  const fields: Record<string, any> = {};
  for (const row of rows as Array<{ field: string, value: string }>) {
    fields[row.field] = JSON.parse(row.value);
  }
  return fields;
}

async function getAccountField (userId: string, field: string): Promise<any | null> {
  const db = await getUserDB(userId);
  const row = db.prepare(
    'SELECT value FROM account_fields WHERE field = ? ORDER BY time DESC LIMIT 1'
  ).get(field);
  return row ? JSON.parse(row.value) : null;
}

async function setAccountField (userId: string, field: string, value: any, createdBy: string, time: number = timestamp.now()): Promise<{ field: string, value: any, time: number, createdBy: string }> {
  const db = await getUserDB(userId);
  const item = { field, value: JSON.stringify(value), time, createdBy };
  db.prepare(
    'INSERT INTO account_fields (field, value, time, createdBy) VALUES (@field, @value, @time, @createdBy)'
  ).run(item);
  return { field, value, time, createdBy };
}

async function getAccountFieldHistory (userId: string, field: string, limit?: number): Promise<Array<{ value: any, time: number, createdBy: string }>> {
  const db = await getUserDB(userId);
  let stmt;
  if (limit != null) {
    stmt = db.prepare('SELECT value, time, createdBy FROM account_fields WHERE field = ? ORDER BY time DESC LIMIT ?');
    return stmt.all(field, limit).map((r: any) => ({ value: JSON.parse(r.value), time: r.time, createdBy: r.createdBy }));
  }
  stmt = db.prepare('SELECT value, time, createdBy FROM account_fields WHERE field = ? ORDER BY time DESC');
  return stmt.all(field).map((r: any) => ({ value: JSON.parse(r.value), time: r.time, createdBy: r.createdBy }));
}

async function deleteAccountField (userId: string, field: string): Promise<void> {
  const db = await getUserDB(userId);
  db.prepare('DELETE FROM account_fields WHERE field = ?').run(field);
}

/**
 * Retrieve all password history, used for migration
 */
async function _getPasswordHistory (userId: string): Promise<any[]> {
  const db = await getUserDB(userId);
  const res: any[] = [];
  const getALL = db.prepare('SELECT hash, time FROM passwords');
  for (const entry of getALL.iterate()) {
    res.push(entry);
  }
  return res;
}

/**
 * Retrieve all store data, used for migration
 */
async function _getAllStoreData (userId: string): Promise<any[]> {
  const db = await getUserDB(userId);
  const res: any[] = [];
  const getALL = db.prepare('SELECT * FROM storeKeyValueData');
  for (const entry of getALL.iterate()) {
    res.push(entry);
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

function getKeyValueDataForStore (storeId: string): any {
  return new (StoreKeyValueData as any)(storeId);
}

/**
 * @constructor
 */
function StoreKeyValueData (this: any, storeId: string): void {
  this.storeId = storeId;
}

StoreKeyValueData.prototype.getAll = async function (userId: string): Promise<Record<string, any>> {
  const db = await getUserDB(userId);
  const query = db.prepare('SELECT key, value FROM storeKeyValueData WHERE storeId = @storeId');
  const res: Record<string, any> = {};
  for (const item of query.iterate({ storeId: this.storeId }) as Iterable<{ key: string, value: string }>) {
    res[item.key] = JSON.parse(item.value);
  }
  return res;
};

StoreKeyValueData.prototype.get = async function (userId: string, key: string): Promise<any | null> {
  const db = await getUserDB(userId);
  const res = db.prepare('SELECT value FROM storeKeyValueData WHERE storeId = @storeId AND key = @key').get({
    storeId: this.storeId,
    key
  });
  if (res?.value == null) return null;
  return JSON.parse(res.value);
};

StoreKeyValueData.prototype.set = async function (userId: string, key: string, value: any): Promise<void> {
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
};

// COMMON FUNCTIONS

/**
 * For tests
 */
async function clearHistory (userId: string): Promise<void> {
  const db = await getUserDB(userId);
  db.prepare('DELETE FROM passwords').run();
}

// MIGRATION METHODS

async function _exportAll (userId: string): Promise<{ passwords: any[], storeKeyValues: any[], accountFields: any[] }> {
  const passwords = await _getPasswordHistory(userId);
  const storeKeyValues = await _getAllStoreData(userId);
  const db = await getUserDB(userId);
  const accountFields = db.prepare('SELECT field, value, time, createdBy FROM account_fields ORDER BY field, time DESC').all()
    .map((r: any) => ({ field: r.field, value: JSON.parse(r.value), time: r.time, createdBy: r.createdBy }));
  return { passwords, storeKeyValues, accountFields };
}

async function _importAll (userId: string, data: any): Promise<void> {
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

async function getUserDB (userId: string): Promise<any> {
  return dbCache.get(userId) || (await openUserDB(userId));
}

async function openUserDB (userId: string): Promise<any> {
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
  dbCache.set(userId, db);
  return db;
}
