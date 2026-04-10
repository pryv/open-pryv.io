/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * MongoDB storage for per-user account data such as:
 * - Password and password history
 * - Per-store key-value data
 * - Account fields with history (email, language, phone, etc.)
 */

const timestamp = require('unix-timestamp');
const _internals = require('./_internals');
const encryption = require('utils').encryption;

let passwordsCollection = null;
let storesKeyValueCollection = null;
let accountFieldsCollection = null;

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
  _addKeyValueData,
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
  const db = await _internals.database;
  passwordsCollection = await db.getCollection({
    name: 'passwords',
    indexes: [
      {
        index: { userId: 1 },
        options: { }
      },
      {
        index: { userId: 1, time: 1 },
        options: { unique: true, background: false }
      }
    ]
  });
  storesKeyValueCollection = await db.getCollection({
    name: 'stores-key-value',
    indexes: [
      {
        index: { storeId: 1, userId: 1, key: 1 },
        options: { unique: true }
      }
    ]
  });
  accountFieldsCollection = await db.getCollection({
    name: 'account-fields',
    indexes: [
      {
        index: { userId: 1, field: 1, time: -1 },
        options: { unique: true }
      },
      {
        index: { userId: 1, field: 1 },
        options: { }
      }
    ]
  });
  initState = InitStates.READY;
}

// PASSWORD MANAGEMENT

async function getPasswordHash (userId) {
  const last = await passwordsCollection.findOne({ userId }, { sort: { time: -1 } });
  return last?.hash;
}

async function addPasswordHash (userId, passwordHash, createdBy, time = timestamp.now()) {
  const item = { userId, time, hash: passwordHash, createdBy };
  try {
    await passwordsCollection.insertOne(item);
  } catch (e) {
    console.log(e.message);
    if (e.message && e.message.startsWith('E11000 duplicate key error collection: pryv-node-test.passwords index: userId_1_time_1 dup key')) {
      throw new Error('UNIQUE constraint failed: passwords.time');
    }
    throw e;
  }

  return item;
}

async function getCurrentPasswordTime (userId) {
  const last = await passwordsCollection.findOne({ userId }, { sort: { time: -1 } });
  if (!last) {
    throw new Error(`No password found in database for user id "${userId}"`);
  }
  return last.time;
}

async function passwordExistsInHistory (userId, password, historyLength) {
  const lastCursor = await passwordsCollection.find({ userId }, { sort: { time: -1 }, limit: historyLength });
  for await (const entry of lastCursor) {
    if (await encryption.compare(password, entry.hash)) {
      return true;
    }
  }
  return false;
}

// PER-STORE KEY-VALUE DB

/**
 * Raw insert used for migration
 */
async function _addKeyValueData (storeId, userId, key, value) {
  await storesKeyValueCollection.insertOne({ storeId, userId, key, value });
}

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
  const resultCursor = await storesKeyValueCollection.find({ userId, storeId: this.storeId });
  const res = {};
  for await (const item of resultCursor) {
    res[item.key] = item.value;
  }
  return res;
};

StoreKeyValueData.prototype.get = async function (userId, key) {
  const res = await storesKeyValueCollection.findOne({ userId, storeId: this.storeId, key });
  return res?.value || null;
};

StoreKeyValueData.prototype.set = async function (userId, key, value) {
  if (value == null) {
    await storesKeyValueCollection.deleteOne({ userId, storeId: this.storeId, key });
  } else {
    await storesKeyValueCollection.updateOne({ userId, storeId: this.storeId, key }, { $set: { userId, storeId: this.storeId, key, value } }, { upsert: true });
  }
};

// ACCOUNT FIELDS

async function getAccountFields (userId) {
  // Aggregate to get only the latest entry per field
  const pipeline = [
    { $match: { userId } },
    { $sort: { time: -1 } },
    { $group: { _id: '$field', value: { $first: '$value' }, time: { $first: '$time' } } }
  ];
  const results = await accountFieldsCollection.aggregate(pipeline);
  const fields = {};
  for await (const doc of results) {
    fields[doc._id] = doc.value;
  }
  return fields;
}

async function getAccountField (userId, field) {
  const doc = await accountFieldsCollection.findOne(
    { userId, field },
    { sort: { time: -1 } }
  );
  return doc ? doc.value : null;
}

async function setAccountField (userId, field, value, createdBy, time = timestamp.now()) {
  const item = { userId, field, value, time, createdBy };
  try {
    await accountFieldsCollection.insertOne(item);
  } catch (e) {
    if (e.message && e.message.includes('E11000 duplicate key error')) {
      throw new Error('UNIQUE constraint failed: account-fields.time');
    }
    throw e;
  }
  return { field, value, time, createdBy };
}

async function getAccountFieldHistory (userId, field, limit) {
  const options = { sort: { time: -1 } };
  if (limit != null) {
    options.limit = limit;
  }
  const cursor = await accountFieldsCollection.find({ userId, field }, options);
  const history = [];
  for await (const doc of cursor) {
    history.push({ value: doc.value, time: doc.time, createdBy: doc.createdBy });
  }
  return history;
}

async function deleteAccountField (userId, field) {
  await accountFieldsCollection.deleteMany({ userId, field });
}

// COMMON FUNCTIONS

/**
 * For tests
 */
async function clearHistory (userId) {
  await passwordsCollection.deleteMany({ userId });
}

// MIGRATION METHODS

async function _exportAll (userId) {
  const passwordsCursor = await passwordsCollection.find({ userId }, { sort: { time: 1 } });
  const passwords = [];
  for await (const entry of passwordsCursor) {
    passwords.push({ time: entry.time, hash: entry.hash, createdBy: entry.createdBy });
  }

  const storeKeyValuesCursor = await storesKeyValueCollection.find({ userId });
  const storeKeyValues = [];
  for await (const entry of storeKeyValuesCursor) {
    storeKeyValues.push({ storeId: entry.storeId, key: entry.key, value: entry.value });
  }

  const accountFieldsCursor = await accountFieldsCollection.find({ userId }, { sort: { field: 1, time: 1 } });
  const accountFields = [];
  for await (const entry of accountFieldsCursor) {
    accountFields.push({ field: entry.field, value: entry.value, time: entry.time, createdBy: entry.createdBy });
  }

  return { passwords, storeKeyValues, accountFields };
}

async function _importAll (userId, data) {
  if (data.passwords) {
    for (const p of data.passwords) {
      await addPasswordHash(userId, p.hash, p.createdBy, p.time);
    }
  }
  if (data.storeKeyValues) {
    for (const kv of data.storeKeyValues) {
      await _addKeyValueData(kv.storeId, userId, kv.key, kv.value);
    }
  }
  if (data.accountFields) {
    for (const af of data.accountFields) {
      await setAccountField(userId, af.field, af.value, af.createdBy, af.time);
    }
  }
}

async function _clearAll (userId) {
  await passwordsCollection.deleteMany({ userId });
  await storesKeyValueCollection.deleteMany({ userId });
  await accountFieldsCollection.deleteMany({ userId });
}
