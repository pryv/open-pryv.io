/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type {} from 'node:fs';

/**
 * PostgreSQL transaction wrapper for the DataStore.
 */
class LocalTransactionPG {
  db: any;
  client: any;

  constructor (db: any) {
    this.db = db;
    this.client = null;
  }

  async init (): Promise<void> {
    this.client = await this.db.getClient();
    await this.client.query('BEGIN');
  }

  async exec (func: (tx: LocalTransactionPG) => Promise<void>): Promise<void> {
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

  async query (text: string, params?: any[]): Promise<any> {
    return this.client.query(text, params);
  }
}

module.exports = LocalTransactionPG;
