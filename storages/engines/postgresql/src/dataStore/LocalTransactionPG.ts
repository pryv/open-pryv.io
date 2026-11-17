/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL transaction wrapper for the DataStore.
 */
type PgClient = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
  release: (err?: unknown) => void;
};
type DbLike = { getClient: () => Promise<PgClient> };

class LocalTransactionPG {
  db: DbLike;
  client: PgClient | null;

  constructor (db: DbLike) {
    this.db = db;
    this.client = null;
  }

  async init (): Promise<void> {
    this.client = await this.db.getClient();
    await this.client.query('BEGIN');
  }

  async exec (func: (tx: LocalTransactionPG) => Promise<void>): Promise<void> {
    let broken = false;
    try {
      await func(this);
      await this.client!.query('COMMIT');
    } catch (err) {
      // Best effort: on a terminated connection the rollback fails too, and
      // must not hide the original cause.
      try {
        await this.client!.query('ROLLBACK');
      } catch (rollbackErr) {
        broken = true;
      }
      throw err;
    } finally {
      this.client!.release(broken ? new Error('transaction rollback failed; discarding client') : undefined);
      this.client = null;
    }
  }

  async query (text: string, params?: unknown[]): Promise<unknown> {
    return this.client!.query(text, params);
  }
}

export { LocalTransactionPG };
