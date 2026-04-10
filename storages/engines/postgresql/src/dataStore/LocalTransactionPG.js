/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL transaction wrapper for the DataStore.
 * Wraps a pg PoolClient with BEGIN/COMMIT/ROLLBACK.
 */
class LocalTransactionPG {
  /** @type {import('../DatabasePG')} */
  db;
  /** @type {import('pg').PoolClient} */
  client;

  constructor (db) {
    this.db = db;
    this.client = null;
  }

  async init () {
    this.client = await this.db.getClient();
    await this.client.query('BEGIN');
  }

  /**
   * Execute a function within this transaction's context.
   * @param {Function} func
   */
  async exec (func) {
    try {
      await func(this);
      await this.client.query('COMMIT');
    } catch (err) {
      await this.client.query('ROLLBACK');
      throw err;
    } finally {
      this.client.release();
      this.client = null;
    }
  }

  /**
   * Execute a parameterised query within this transaction.
   * @param {string} text
   * @param {Array} [params]
   */
  async query (text, params) {
    return this.client.query(text, params);
  }
}

module.exports = LocalTransactionPG;
