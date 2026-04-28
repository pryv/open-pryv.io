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

const path = require('path');
const SQLite3 = require('better-sqlite3');
const { LRUCache: LRU } = require('lru-cache');
const timestamp = require('unix-timestamp');
const _internals = require('./_internals');
const encryption = require('utils').encryption;

const CACHE_SIZE = 100;
const VERSION = '1.0.0';
const DB_OPTIONS = {};

let dbCache = null;

const InitStates = {
  NOT_INITIALIZED: -1,
  INITIALIZING: 0,
  READY: 1
};
let initState = InitStates.NOT_INITIALIZED;

module.exports = _internals.createUserAccountStorage({
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

async function getPasswordHash (userId) {
  const db = await getUserDB(userId);
  const last = db.prepare('SELECT hash FROM passwords ORDER BY time DESC LIMIT 1').get();
  return last?.hash;
}

async function addPasswordHash (userId, passwordHash, createdBy, time = timestamp.now()) {
  const db = await getUserDB(userId);
  const result = { time, hash: passwordHash, createdBy };
  db.prepare('INSERT INTO passwords (time, hash, createdBy) VALUES (@time, @hash, @createdBy)').run(result);
  return result;
}

async function getCurrentPasswordTime (userId) {
  const db = await getUserDB(userId);
  const last = db.prepare('SELECT hash, time FROM passwords ORDER BY time DESC LIMIT 1').get();
  if (!last) {
    throw new Error(`No password found in database for user id "${userId}"`);
  }
  return last.time;
}

async function passwordExistsInHistory (userId, password, historyLength) {
  const db = await getUserDB(userId);
  const getLastN = db.prepare('SELECT hash, time FROM passwords ORDER BY time DESC LIMIT ?');
  for (const entry of getLastN.iterate(historyLength)) {
    if (await encryption.compare(password, entry.hash)) {
      return true;
    }
  }
  return false;
}

// ACCOUNT FIELDS

async function getAccountFields (userId) {
  const db = await getUserDB(userId);
  // Get the latest value per field (highest time wins)
  const rows = db.prepare(
    'SELECT field, value FROM account_fields WHERE (field, time) IN ' +
    '(SELECT field, MAX(time) FROM account_fields GROUP BY field)'
  ).all();
  const fields = {};
  for (const row of rows) {
    fields[row.field] = JSON.parse(row.value);
  }
  return fields;
}

async function getAccountField (userId, field) {
  const db = await getUserDB(userId);
  const row = db.prepare(
    'SELECT value FROM account_fields WHERE field = ? ORDER BY time DESC LIMIT 1'
  ).get(field);
  return row ? JSON.parse(row.value) : null;
}

async function setAccountField (userId, field, value, createdBy, time = timestamp.now()) {
  const db = await getUserDB(userId);
  const item = { field, value: JSON.stringify(value), time, createdBy };
  db.prepare(
    'INSERT INTO account_fields (field, value, time, createdBy) VALUES (@field, @value, @time, @createdBy)'
  ).run(item);
  return { field, value, time, createdBy };
}

async function getAccountFieldHistory (userId, field, limit) {
  const db = await getUserDB(userId);
  let stmt;
  if (limit != null) {
    stmt = db.prepare('SELECT value, time, createdBy FROM account_fields WHERE field = ? ORDER BY time DESC LIMIT ?');
    return stmt.all(field, limit).map(r => ({ value: JSON.parse(r.value), time: r.time, createdBy: r.createdBy }));
  }
  stmt = db.prepare('SELECT value, time, createdBy FROM account_fields WHERE field = ? ORDER BY time DESC');
  return stmt.all(field).map(r => ({ value: JSON.parse(r.value), time: r.time, createdBy: r.createdBy }));
}

async function deleteAccountField (userId, field) {
  const db = await getUserDB(userId);
  db.prepare('DELETE FROM account_fields WHERE field = ?').run(field);
}

/**
 * Retrieve all password history, used for migration
 */
async function _getPasswordHistory (userId) {
  const db = await getUserDB(userId);
  const res = [];
  const getALL = db.prepare('SELECT hash, time FROM passwords');
  for (const entry of getALL.iterate()) {
    res.push(entry);
  }
  return res;
}

/**
 * Retrieve all store data, used for migration
 */
async function _getAllStoreData (userId) {
  const db = await getUserDB(userId);
  const res = [];
  const getALL = db.prepare('SELECT * FROM storeKeyValueData');
  for (const entry of getALL.iterate()) {
    res.push(entry);
  }
  return res;
}

/**
 * Clear store data for user, used for migration
 */
async function _clearStoreData (userId) {
  const db = await getUserDB(userId);
  db.prepare('DELETE FROM storeKeyValueData').run();
}

// PER-STORE KEY-VALUE DB

function getKeyValueDataForStore (storeId) {
  return new StoreKeyValueData(storeId);
}

/**
 * @constructor
 * @param {string} storeId
 */
function StoreKeyValueData (storeId) {
  this.storeId = storeId;
}

StoreKeyValueData.prototype.getAll = async function (userId) {
  const db = await getUserDB(userId);
  const query = db.prepare('SELECT key, value FROM storeKeyValueData WHERE storeId = @storeId');
  const res = {};
  for (const item of query.iterate({ storeId: this.storeId })) {
    res[item.key] = JSON.parse(item.value);
  }
  return res;
};

StoreKeyValueData.prototype.get = async function (userId, key) {
  const db = await getUserDB(userId);
  const res = db.prepare('SELECT value FROM storeKeyValueData WHERE storeId = @storeId AND key = @key').get({
    storeId: this.storeId,
    key
  });
  if (res?.value == null) return null;
  return JSON.parse(res.value);
};

StoreKeyValueData.prototype.set = async function (userId, key, value) {
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
async function clearHistory (userId) {
  const db = await getUserDB(userId);
  db.prepare('DELETE FROM passwords').run();
}

// MIGRATION METHODS

async function _exportAll (userId) {
  const passwords = await _getPasswordHistory(userId);
  const storeKeyValues = await _getAllStoreData(userId);
  const db = await getUserDB(userId);
  const accountFields = db.prepare('SELECT field, value, time, createdBy FROM account_fields ORDER BY field, time DESC').all()
    .map(r => ({ field: r.field, value: JSON.parse(r.value), time: r.time, createdBy: r.createdBy }));
  return { passwords, storeKeyValues, accountFields };
}

async function _importAll (userId, data) {
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

async function _clearAll (userId) {
  await clearHistory(userId);
  await _clearStoreData(userId);
  const db = await getUserDB(userId);
  db.prepare('DELETE FROM account_fields').run();
}

// DB HELPERS

async function getUserDB (userId) {
  return dbCache.get(userId) || (await openUserDB(userId));
}

async function openUserDB (userId) {
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
