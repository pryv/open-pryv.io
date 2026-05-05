/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createId: cuid } = require('@paralleldrive/cuid2');

const DEFAULT_MAX_AGE = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * PostgreSQL implementation of Sessions storage.
 */
class SessionsPG {
  db: any;
  options: { maxAge: number };

  constructor (db: any, options?: any) {
    this.db = db;
    this.options = { maxAge: (options && options.maxAge) || DEFAULT_MAX_AGE };
  }

  get (id: string, callback: (err: any, data?: any) => void): void {
    this.db.query('SELECT data, expires FROM sessions WHERE id = $1', [id])
      .then((res: any) => {
        if (res.rows.length === 0) return callback(null, null);
        const row = res.rows[0];
        if (new Date() >= new Date(row.expires)) {
          this.destroy(id, () => callback(null, null));
          return;
        }
        callback(null, row.data);
      })
      .catch(callback);
  }

  getMatching (data: any, callback: (err: any, id?: any) => void): void {
    this.db.query('SELECT id, expires FROM sessions WHERE data @> $1', [JSON.stringify(data)])
      .then((res: any) => {
        if (res.rows.length === 0) return callback(null, null);
        const row = res.rows[0];
        if (new Date() >= new Date(row.expires)) {
          this.destroy(row.id, () => callback(null, null));
          return;
        }
        callback(null, row.id);
      })
      .catch(callback);
  }

  generate (data: any, options: any, callback?: (err: any, id?: string) => void): void {
    if (typeof options === 'function') {
      callback = options as any;
      options = {};
    }
    const id = cuid();
    const sessionData = (data && typeof data === 'object') ? data : {};
    const expires = this.getNewExpirationDate();
    this.db.query(
      'INSERT INTO sessions (id, data, expires) VALUES ($1, $2, $3)',
      [id, JSON.stringify(sessionData), expires]
    )
      .then(() => callback!(null, id))
      .catch(callback!);
  }

  touch (id: string, callback: (err: any, res?: any) => void): void {
    const expires = this.getNewExpirationDate();
    this.db.query('UPDATE sessions SET expires = $1 WHERE id = $2', [expires, id])
      .then((res: any) => callback(null, res))
      .catch(callback);
  }

  expireNow (id: string, callback: (err: any, res?: any) => void): void {
    this.db.query('UPDATE sessions SET expires = $1 WHERE id = $2', [new Date(), id])
      .then((res: any) => callback(null, res))
      .catch(callback);
  }

  destroy (id: string, callback: (err: any, res?: any) => void): void {
    this.db.query('DELETE FROM sessions WHERE id = $1', [id])
      .then((res: any) => callback(null, res))
      .catch(callback);
  }

  clearAll (callback: (err: any, res?: any) => void): void {
    this.db.query('DELETE FROM sessions')
      .then((res: any) => callback(null, res))
      .catch(callback);
  }

  remove (query: Record<string, string>, callback: (err: any, res?: any) => void): void {
    const keys = Object.keys(query);
    if (keys.length === 0) return this.clearAll(callback);
    const conditions = keys.map((k, i) => `data->>'${k}' = $${i + 1}`);
    const values = keys.map((k) => String(query[k]));
    this.db.query(`DELETE FROM sessions WHERE ${conditions.join(' AND ')}`, values)
      .then((res: any) => callback(null, res))
      .catch(callback);
  }

  getNewExpirationDate (): Date {
    return new Date(Date.now() + this.options.maxAge);
  }

  // -- Migration methods --

  exportAll (callback: (err: any, docs?: any[]) => void): void {
    this.db.query('SELECT id, data, expires FROM sessions')
      .then((res: any) => {
        const docs = res.rows.map((r: any) => ({
          _id: r.id,
          data: r.data,
          expires: r.expires
        }));
        callback(null, docs);
      })
      .catch(callback);
  }

  importAll (data: any[], callback: (err: any) => void): void {
    if (!data || data.length === 0) return callback(null);
    const inserts = data.map((d: any) =>
      this.db.query(
        'INSERT INTO sessions (id, data, expires) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [d._id || d.id, JSON.stringify(d.data), d.expires]
      )
    );
    Promise.all(inserts)
      .then(() => callback(null))
      .catch(callback);
  }
}

export { SessionsPG };