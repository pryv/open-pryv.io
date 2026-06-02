/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createId: cuid } = require('@paralleldrive/cuid2');

type SessionData = Record<string, unknown>;

const DEFAULT_MAX_AGE = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * PostgreSQL implementation of Sessions storage.
 */
class SessionsPG {
  db: any; // DatabasePG — not yet modelled
  options: { maxAge: number };

  constructor (db: any, options?: { maxAge?: number }) {
    this.db = db;
    this.options = { maxAge: (options && options.maxAge) || DEFAULT_MAX_AGE };
  }

  get (id: string, callback: (err: Error | null, data?: SessionData | null) => void): void {
    this.db.query('SELECT data, expires FROM sessions WHERE id = $1', [id])
      .then((res: { rows: Array<{ id?: string; data?: SessionData; expires?: Date | string; [k: string]: unknown }>; rowCount?: number }) => {
        if (res.rows.length === 0) return callback(null, null);
        const row = res.rows[0];
        if (new Date() >= new Date(row.expires as string | Date)) {
          this.destroy(id, () => callback(null, null));
          return;
        }
        callback(null, row.data);
      })
      .catch(callback);
  }

  getMatching (data: Record<string, unknown>, callback: (err: Error | null, id?: string | null) => void): void {
    this.db.query('SELECT id, expires FROM sessions WHERE data @> $1', [JSON.stringify(data)])
      .then((res: { rows: Array<{ id?: string; data?: SessionData; expires?: Date | string; [k: string]: unknown }>; rowCount?: number }) => {
        if (res.rows.length === 0) return callback(null, null);
        const row = res.rows[0];
        if (new Date() >= new Date(row.expires as string | Date)) {
          this.destroy(row.id as string, () => callback(null, null));
          return;
        }
        callback(null, row.id);
      })
      .catch(callback);
  }

  generate (data: Record<string, unknown>, options: unknown, callback?: (err: Error | null, id?: string) => void): void {
    if (typeof options === 'function') {
      callback = options as (err: Error | null, id?: string) => void;
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

  touch (id: string, callback: (err: Error | null, res?: unknown) => void): void {
    const expires = this.getNewExpirationDate();
    this.db.query('UPDATE sessions SET expires = $1 WHERE id = $2', [expires, id])
      .then((res: { rows: Array<{ id?: string; data?: SessionData; expires?: Date | string; [k: string]: unknown }>; rowCount?: number }) => callback(null, res))
      .catch(callback);
  }

  expireNow (id: string, callback: (err: Error | null, res?: unknown) => void): void {
    this.db.query('UPDATE sessions SET expires = $1 WHERE id = $2', [new Date(), id])
      .then((res: { rows: Array<{ id?: string; data?: SessionData; expires?: Date | string; [k: string]: unknown }>; rowCount?: number }) => callback(null, res))
      .catch(callback);
  }

  destroy (id: string, callback: (err: Error | null, res?: unknown) => void): void {
    this.db.query('DELETE FROM sessions WHERE id = $1', [id])
      .then((res: { rows: Array<{ id?: string; data?: SessionData; expires?: Date | string; [k: string]: unknown }>; rowCount?: number }) => callback(null, res))
      .catch(callback);
  }

  clearAll (callback: (err: Error | null, res?: unknown) => void): void {
    this.db.query('DELETE FROM sessions')
      .then((res: { rows: Array<{ id?: string; data?: SessionData; expires?: Date | string; [k: string]: unknown }>; rowCount?: number }) => callback(null, res))
      .catch(callback);
  }

  remove (query: Record<string, string>, callback: (err: Error | null, res?: unknown) => void): void {
    const keys = Object.keys(query);
    if (keys.length === 0) return this.clearAll(callback);
    const conditions = keys.map((k, i) => `data->>'${k}' = $${i + 1}`);
    const values = keys.map((k) => String(query[k]));
    this.db.query(`DELETE FROM sessions WHERE ${conditions.join(' AND ')}`, values)
      .then((res: { rows: Array<{ id?: string; data?: SessionData; expires?: Date | string; [k: string]: unknown }>; rowCount?: number }) => callback(null, res))
      .catch(callback);
  }

  getNewExpirationDate (): Date {
    return new Date(Date.now() + this.options.maxAge);
  }

  // -- Migration methods --

  exportAll (callback: (err: Error | null, docs?: Array<{ _id: string; data: SessionData; expires: Date }>) => void): void {
    this.db.query('SELECT id, data, expires FROM sessions')
      .then((res: { rows: Array<{ id?: string; data?: SessionData; expires?: Date | string; [k: string]: unknown }>; rowCount?: number }) => {
        const docs = res.rows.map((r) => ({
          _id: r.id as string,
          data: r.data as SessionData,
          expires: r.expires as Date
        }));
        callback(null, docs);
      })
      .catch(callback);
  }

  importAll (data: Array<{ _id?: string; id?: string; data: SessionData; expires: Date }>, callback: (err: Error | null) => void): void {
    if (!data || data.length === 0) return callback(null);
    const inserts = data.map((d: { _id?: string; id?: string; data: SessionData; expires: Date }) =>
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