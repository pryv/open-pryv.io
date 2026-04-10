/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const timestamp = require('unix-timestamp');
const _internals = require('./_internals');
const encryption = require('utils').encryption;

let db;

module.exports = _internals.createUserAccountStorage({
  async init () {
    db = _internals.databasePG;
    await db.ensureConnect();
  },

  async getPasswordHash (userId) {
    const res = await db.query(
      'SELECT hash FROM passwords WHERE user_id = $1 ORDER BY time DESC LIMIT 1',
      [userId]
    );
    return res.rows.length > 0 ? res.rows[0].hash : null;
  },

  async addPasswordHash (userId, passwordHash, createdBy, time) {
    const t = time || timestamp.now();
    await db.query(
      'INSERT INTO passwords (user_id, time, hash, created_by) VALUES ($1, $2, $3, $4)',
      [userId, t, passwordHash, createdBy]
    );
    return { time: t, hash: passwordHash, createdBy };
  },

  async getCurrentPasswordTime (userId) {
    const res = await db.query(
      'SELECT time FROM passwords WHERE user_id = $1 ORDER BY time DESC LIMIT 1',
      [userId]
    );
    return res.rows.length > 0 ? res.rows[0].time : 0;
  },

  async passwordExistsInHistory (userId, password, historyLength) {
    const res = await db.query(
      'SELECT hash FROM passwords WHERE user_id = $1 ORDER BY time DESC LIMIT $2',
      [userId, historyLength]
    );
    for (const row of res.rows) {
      if (await encryption.compare(password, row.hash)) {
        return true;
      }
    }
    return false;
  },

  async clearHistory (userId) {
    await db.query('DELETE FROM passwords WHERE user_id = $1', [userId]);
  },

  getKeyValueDataForStore (storeId) {
    return new StoreKeyValueData(storeId);
  },

  // -- Account fields --

  async getAccountFields (userId) {
    const res = await db.query(
      'SELECT DISTINCT ON (field) field, value FROM account_fields WHERE user_id = $1 ORDER BY field, time DESC',
      [userId]
    );
    const fields = {};
    for (const row of res.rows) {
      fields[row.field] = row.value;
    }
    return fields;
  },

  async getAccountField (userId, field) {
    const res = await db.query(
      'SELECT value FROM account_fields WHERE user_id = $1 AND field = $2 ORDER BY time DESC LIMIT 1',
      [userId, field]
    );
    return res.rows.length > 0 ? res.rows[0].value : null;
  },

  async setAccountField (userId, field, value, createdBy, time) {
    const t = time || timestamp.now();
    await db.query(
      'INSERT INTO account_fields (user_id, field, value, time, created_by) VALUES ($1, $2, $3, $4, $5)',
      [userId, field, JSON.stringify(value), t, createdBy]
    );
    return { field, value, time: t, createdBy };
  },

  async getAccountFieldHistory (userId, field, limit) {
    let sql = 'SELECT value, time, created_by FROM account_fields WHERE user_id = $1 AND field = $2 ORDER BY time DESC';
    const params = [userId, field];
    if (limit != null) {
      sql += ' LIMIT $3';
      params.push(limit);
    }
    const res = await db.query(sql, params);
    return res.rows.map((r) => ({
      value: r.value,
      time: r.time,
      createdBy: r.created_by
    }));
  },

  async deleteAccountField (userId, field) {
    await db.query(
      'DELETE FROM account_fields WHERE user_id = $1 AND field = $2',
      [userId, field]
    );
  },

  // -- Migration methods --

  async _exportAll (userId) {
    const passwords = await db.query(
      'SELECT time, hash, created_by FROM passwords WHERE user_id = $1 ORDER BY time',
      [userId]
    );
    const storeData = await db.query(
      'SELECT store_id, key, value FROM store_key_values WHERE user_id = $1',
      [userId]
    );
    const accountFieldsData = await db.query(
      'SELECT field, value, time, created_by FROM account_fields WHERE user_id = $1 ORDER BY field, time',
      [userId]
    );
    return {
      passwords: passwords.rows.map((r) => ({
        time: r.time,
        hash: r.hash,
        createdBy: r.created_by
      })),
      storeKeyValues: storeData.rows.map((r) => ({
        storeId: r.store_id,
        key: r.key,
        value: r.value
      })),
      accountFields: accountFieldsData.rows.map((r) => ({
        field: r.field,
        value: r.value,
        time: r.time,
        createdBy: r.created_by
      }))
    };
  },

  async _importAll (userId, data) {
    if (data.passwords) {
      for (const p of data.passwords) {
        await db.query(
          'INSERT INTO passwords (user_id, time, hash, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [userId, p.time, p.hash, p.createdBy || p.created_by]
        );
      }
    }
    if (data.storeKeyValues) {
      for (const kv of data.storeKeyValues) {
        await db.query(
          'INSERT INTO store_key_values (user_id, store_id, key, value) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, store_id, key) DO UPDATE SET value = $4',
          [userId, kv.storeId || kv.store_id, kv.key, JSON.stringify(kv.value)]
        );
      }
    }
    if (data.accountFields) {
      for (const af of data.accountFields) {
        await db.query(
          'INSERT INTO account_fields (user_id, field, value, time, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
          [userId, af.field, JSON.stringify(af.value), af.time, af.createdBy || af.created_by]
        );
      }
    }
  },

  async _clearAll (userId) {
    await db.query('DELETE FROM passwords WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM store_key_values WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM account_fields WHERE user_id = $1', [userId]);
  }
});

/**
 * Key-value store scoped to a storeId.
 */
class StoreKeyValueData {
  constructor (storeId) {
    this.storeId = storeId;
  }

  async getAll (userId) {
    const res = await db.query(
      'SELECT key, value FROM store_key_values WHERE user_id = $1 AND store_id = $2',
      [userId, this.storeId]
    );
    const result = {};
    for (const row of res.rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  async get (userId, key) {
    const res = await db.query(
      'SELECT value FROM store_key_values WHERE user_id = $1 AND store_id = $2 AND key = $3',
      [userId, this.storeId, key]
    );
    return res.rows.length > 0 ? res.rows[0].value : null;
  }

  async set (userId, key, value) {
    if (value === null || value === undefined) {
      await db.query(
        'DELETE FROM store_key_values WHERE user_id = $1 AND store_id = $2 AND key = $3',
        [userId, this.storeId, key]
      );
    } else {
      await db.query(
        'INSERT INTO store_key_values (user_id, store_id, key, value) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, store_id, key) DO UPDATE SET value = $4',
        [userId, this.storeId, key, JSON.stringify(value)]
      );
    }
  }
}
