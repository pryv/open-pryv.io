/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createId: cuid } = require('@paralleldrive/cuid2');

const concurrentSafeWrite = require('./concurrentSafeWrite.ts');

const DEFAULT_MAX_AGE = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * SQLite implementation of Sessions storage.
 * Backed by the shared `sessions` table in the shared baseStorage SQLite file.
 * `data` is stored as a JSON TEXT column; `expires` as INTEGER (ms since epoch).
 */
class SessionsSQLite {
  db: any;
  options: { maxAge: number };

  constructor (database: any, options?: any) {
    this.db = database.getDb();
    this.options = { maxAge: (options && options.maxAge) || DEFAULT_MAX_AGE };
  }

  private rowToData (row: any): any {
    return typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  }

  get (id: string, callback: (err: any, data?: any) => void): void {
    try {
      const row = this.db.prepare('SELECT data, expires FROM sessions WHERE id = ?').get(id);
      if (!row) return callback(null, null);
      if (Date.now() >= row.expires) {
        this.destroy(id, () => callback(null, null));
        return;
      }
      callback(null, this.rowToData(row));
    } catch (err) {
      callback(err);
    }
  }

  getMatching (data: any, callback: (err: any, id?: any) => void): void {
    try {
      const keys = Object.keys(data || {});
      if (keys.length === 0) return callback(null, null);
      const where = keys.map((k) => `json_extract(data, '$.${k}') = ?`).join(' AND ');
      const values = keys.map((k) => data[k]);
      const row = this.db.prepare(`SELECT id, expires FROM sessions WHERE ${where} LIMIT 1`).get(...values);
      if (!row) return callback(null, null);
      if (Date.now() >= row.expires) {
        this.destroy(row.id, () => callback(null, null));
        return;
      }
      callback(null, row.id);
    } catch (err) {
      callback(err);
    }
  }

  generate (data: any, options: any, callback?: (err: any, id?: string) => void): void {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const id = cuid();
    const sessionData = (data && typeof data === 'object') ? data : {};
    const expires = this.getNewExpirationMs();
    concurrentSafeWrite.execute(() => {
      this.db.prepare('INSERT INTO sessions (id, data, expires) VALUES (?, ?, ?)')
        .run(id, JSON.stringify(sessionData), expires);
    })
      .then(() => callback!(null, id))
      .catch(callback!);
  }

  touch (id: string, callback: (err: any, res?: any) => void): void {
    const expires = this.getNewExpirationMs();
    concurrentSafeWrite.execute(() => {
      return this.db.prepare('UPDATE sessions SET expires = ? WHERE id = ?').run(expires, id);
    })
      .then((res: any) => callback(null, res))
      .catch(callback);
  }

  expireNow (id: string, callback: (err: any, res?: any) => void): void {
    concurrentSafeWrite.execute(() => {
      return this.db.prepare('UPDATE sessions SET expires = ? WHERE id = ?').run(Date.now(), id);
    })
      .then((res: any) => callback(null, res))
      .catch(callback);
  }

  destroy (id: string, callback: (err: any, res?: any) => void): void {
    concurrentSafeWrite.execute(() => {
      return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    })
      .then((res: any) => callback(null, res))
      .catch(callback);
  }

  clearAll (callback: (err: any, res?: any) => void): void {
    concurrentSafeWrite.execute(() => {
      return this.db.prepare('DELETE FROM sessions').run();
    })
      .then((res: any) => callback(null, res))
      .catch(callback);
  }

  remove (query: Record<string, string>, callback: (err: any, res?: any) => void): void {
    const keys = Object.keys(query);
    if (keys.length === 0) return this.clearAll(callback);
    const where = keys.map((k) => `json_extract(data, '$.${k}') = ?`).join(' AND ');
    const values = keys.map((k) => query[k]);
    concurrentSafeWrite.execute(() => {
      return this.db.prepare(`DELETE FROM sessions WHERE ${where}`).run(...values);
    })
      .then((res: any) => callback(null, res))
      .catch(callback);
  }

  private getNewExpirationMs (): number {
    return Date.now() + this.options.maxAge;
  }

  // -- Migration methods --

  exportAll (callback: (err: any, docs?: any[]) => void): void {
    try {
      const rows = this.db.prepare('SELECT id, data, expires FROM sessions').all();
      const docs = rows.map((r: any) => ({
        _id: r.id,
        data: this.rowToData(r),
        expires: new Date(r.expires)
      }));
      callback(null, docs);
    } catch (err) {
      callback(err);
    }
  }

  importAll (data: any[], callback: (err: any) => void): void {
    if (!data || data.length === 0) return callback(null);
    concurrentSafeWrite.execute(() => {
      const stmt = this.db.prepare(
        'INSERT INTO sessions (id, data, expires) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING'
      );
      const tx = this.db.transaction((items: any[]) => {
        for (const d of items) {
          const id = d._id || d.id;
          const payload = typeof d.data === 'string' ? d.data : JSON.stringify(d.data || {});
          const expires = d.expires instanceof Date ? d.expires.getTime() : Number(d.expires);
          stmt.run(id, payload, expires);
        }
      });
      tx(data);
    })
      .then(() => callback(null))
      .catch(callback);
  }
}

export { SessionsSQLite };
