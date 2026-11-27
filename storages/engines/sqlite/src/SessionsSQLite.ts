/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';

import type { SqliteDb } from './types.ts';
import type { SessionData } from '../../../interfaces/_shared/domain.ts';
import type { TokenProtection } from '../../../interfaces/_shared/tokenProtection.ts';
const require = createRequire(import.meta.url);

// A bearer secret: from node:crypto, not an id library.
const { secureToken } = require('../../../interfaces/_shared/secureToken.ts');

const concurrentSafeWrite = require('./concurrentSafeWrite.ts');
// `sessions` table row (queries select subsets of these columns)
type SessionRow = { id: string; id_enc?: string | null; data: string | SessionData; expires: number };
type PassResult = { rows: number; expired: number };

const DEFAULT_MAX_AGE = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * SQLite implementation of Sessions storage.
 * Backed by the shared `sessions` table in the shared baseStorage SQLite file.
 * `data` is stored as a JSON TEXT column; `expires` as INTEGER (ms since epoch).
 *
 * The session id is the personal access token: the `id` column holds its
 * keyed hash, `id_enc` its encrypted copy (see `TokenProtection`). Callers
 * pass and receive the clear id.
 */
class SessionsSQLite {
  db: SqliteDb;
  options: { maxAge: number };
  tokenProtection: TokenProtection;

  constructor (database: { getDb: () => SqliteDb }, options: { maxAge?: number } | undefined, tokenProtection: TokenProtection) {
    this.db = database.getDb();
    this.options = { maxAge: (options && options.maxAge) || DEFAULT_MAX_AGE };
    if (tokenProtection == null) {
      throw new Error('SessionsSQLite requires a tokenProtection ref (session ids are never stored in clear)');
    }
    this.tokenProtection = tokenProtection;
  }

  private rowToData (row: { data: string | Record<string, unknown> }): SessionData {
    return typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  }

  /** The stored key of a session id. */
  key (id: string): string {
    return this.tokenProtection.hashSessionId(id);
  }

  /** The clear id of a stored row. */
  clearId (row: { id: string; id_enc?: string | null }): string {
    if (row.id_enc == null) return row.id; // not converted yet
    return this.tokenProtection.openSessionId(row.id, row.id_enc);
  }

  get (id: string, callback: (err: Error | null, data?: SessionData | null) => void): void {
    try {
      if (typeof id !== 'string') return callback(null, null);
      const key = this.key(id);
      const row = this.db.prepare<SessionRow>('SELECT data, expires FROM sessions WHERE id = ?').get(key);
      if (!row) return callback(null, null);
      if (Date.now() >= row.expires) {
        this._destroyKey(key, () => callback(null, null));
        return;
      }
      callback(null, this.rowToData(row));
    } catch (err: unknown) {
      callback(err as Error | null);
    }
  }

  getMatching (data: Record<string, unknown>, callback: (err: Error | null, id?: string | null) => void): void {
    try {
      const keys = Object.keys(data || {});
      if (keys.length === 0) return callback(null, null);
      const where = keys.map((k) => `json_extract(data, '$.${k}') = ?`).join(' AND ');
      const values = keys.map((k) => data[k]);
      const row = this.db.prepare<SessionRow>(`SELECT id, id_enc, expires FROM sessions WHERE ${where} LIMIT 1`).get(...values);
      if (!row) return callback(null, null);
      if (Date.now() >= row.expires) {
        this._destroyKey(row.id, () => callback(null, null));
        return;
      }
      callback(null, this.clearId(row));
    } catch (err: unknown) {
      callback(err as Error | null);
    }
  }

  generate (data: Record<string, unknown>, options: unknown, callback?: (err: Error | null, id?: string) => void): void {
    if (typeof options === 'function') {
      callback = options as (err: Error | null, id?: string) => void;
      options = {};
    }
    const id = secureToken();
    const key = this.key(id);
    const sessionData = (data && typeof data === 'object') ? data : {};
    const expires = this.getNewExpirationMs();
    concurrentSafeWrite.execute(() => {
      this.db.prepare('INSERT INTO sessions (id, id_enc, data, expires) VALUES (?, ?, ?, ?)')
        .run(key, this.tokenProtection.sealSessionId(key, id), JSON.stringify(sessionData), expires);
    })
      .then(() => callback!(null, id))
      .catch(callback!);
  }

  touch (id: string, callback: (err: Error | null, res?: unknown) => void): void {
    const expires = this.getNewExpirationMs();
    // An expired session is not extended (it stays expired until read).
    concurrentSafeWrite.execute(() => {
      return this.db.prepare('UPDATE sessions SET expires = ? WHERE id = ? AND expires > ?').run(expires, this.key(id), Date.now());
    })
      .then((res: unknown) => callback(null, res))
      .catch(callback);
  }

  expireNow (id: string, callback: (err: Error | null, res?: unknown) => void): void {
    concurrentSafeWrite.execute(() => {
      return this.db.prepare('UPDATE sessions SET expires = ? WHERE id = ?').run(Date.now(), this.key(id));
    })
      .then((res: unknown) => callback(null, res))
      .catch(callback);
  }

  destroy (id: string, callback: (err: Error | null, res?: unknown) => void): void {
    let key: string;
    try { key = this.key(id); } catch (err) { return callback(err as Error); }
    this._destroyKey(key, callback);
  }

  private _destroyKey (key: string, callback: (err: Error | null, res?: unknown) => void): void {
    concurrentSafeWrite.execute(() => {
      return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(key);
    })
      .then((res: unknown) => callback(null, res))
      .catch(callback);
  }

  clearAll (callback: (err: Error | null, res?: unknown) => void): void {
    concurrentSafeWrite.execute(() => {
      return this.db.prepare('DELETE FROM sessions').run();
    })
      .then((res: unknown) => callback(null, res))
      .catch(callback);
  }

  removeAllExcept (query: Record<string, string>, exceptId: string, callback: (err: Error | null, res?: unknown) => void): void {
    const keys = Object.keys(query);
    if (keys.length === 0) return callback(new Error('removeAllExcept requires a non-empty query'));
    const where = keys.map((k) => `json_extract(data, '$.${k}') = ?`).join(' AND ');
    const values = keys.map((k) => query[k]);
    let res: unknown;
    let exceptKey: string;
    try { exceptKey = this.key(exceptId); } catch (err) { return callback(err as Error); }
    concurrentSafeWrite.execute(() => {
      res = this.db.prepare(`DELETE FROM sessions WHERE ${where} AND id <> ?`).run(...values, exceptKey);
    })
      .then(() => callback(null, res))
      .catch(callback);
  }

  remove (query: Record<string, string>, callback: (err: Error | null, res?: unknown) => void): void {
    const keys = Object.keys(query);
    if (keys.length === 0) return this.clearAll(callback);
    const where = keys.map((k) => `json_extract(data, '$.${k}') = ?`).join(' AND ');
    const values = keys.map((k) => query[k]);
    concurrentSafeWrite.execute(() => {
      return this.db.prepare(`DELETE FROM sessions WHERE ${where}`).run(...values);
    })
      .then((res: unknown) => callback(null, res))
      .catch(callback);
  }

  private getNewExpirationMs (): number {
    return Date.now() + this.options.maxAge;
  }

  // -- Migration methods --

  exportAll (callback: (err: Error | null, docs?: Array<{ _id: string; data: SessionData; expires: Date }>) => void): void {
    try {
      const rows = this.db.prepare<SessionRow>('SELECT id, id_enc, data, expires FROM sessions').all();
      const docs = rows.map((r: SessionRow) => ({
        _id: this.clearId(r),
        data: this.rowToData(r),
        expires: new Date(r.expires)
      }));
      callback(null, docs);
    } catch (err: unknown) {
      callback(err as Error | null);
    }
  }

  importAll (data: Array<{ _id?: string; id?: string; data: SessionData | string; expires: Date | number }>, callback: (err: Error | null) => void): void {
    if (!data || data.length === 0) return callback(null);
    concurrentSafeWrite.execute(() => {
      const stmt = this.db.prepare(
        'INSERT INTO sessions (id, id_enc, data, expires) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'
      );
      const tx = this.db.transaction((items: Array<{ _id?: string; id?: string; data: SessionData | string; expires: Date | number }>) => {
        for (const d of items) {
          const id = (d._id || d.id) as string;
          const key = this.key(id);
          const payload = typeof d.data === 'string' ? d.data : JSON.stringify(d.data || {});
          const expires = d.expires instanceof Date ? d.expires.getTime() : Number(d.expires);
          stmt.run(key, this.tokenProtection.sealSessionId(key, id), payload, expires);
        }
      });
      tx(data);
    })
      .then(() => callback(null))
      .catch(callback);
  }

  // -- Token at rest: conversion, rollback, re-key --

  hasClearRows (): boolean {
    return this.db.prepare('SELECT 1 FROM sessions WHERE id_enc IS NULL LIMIT 1').get() != null;
  }

  hasForeignKeyRows (): boolean {
    return this.db.prepare('SELECT 1 FROM sessions WHERE id_enc IS NOT NULL AND substr(id, 1, ?) <> ? LIMIT 1')
      .get(this.tokenProtection.kid.length + 1, this.tokenProtection.kid + '.') != null;
  }

  /**
   * Convert, in one transaction, every session still keyed by its clear id
   * (expired ones are deleted). Idempotent.
   */
  async protectClearRows (): Promise<PassResult> {
    const result: PassResult = { rows: 0, expired: 0 };
    await concurrentSafeWrite.execute(() => this.db.transaction(() => {
      result.expired = this.db.prepare('DELETE FROM sessions WHERE id_enc IS NULL AND expires <= ?').run(Date.now()).changes;
      const rows = this.db.prepare<{ id: string }>('SELECT id FROM sessions WHERE id_enc IS NULL').all();
      const upd = this.db.prepare('UPDATE sessions SET id = ?, id_enc = ? WHERE id = ? AND id_enc IS NULL');
      for (const row of rows) {
        const key = this.key(row.id);
        result.rows += upd.run(key, this.tokenProtection.sealSessionId(key, row.id), row.id).changes;
      }
    }).immediate());
    return result;
  }

  /** Rollback aid: key every session by its clear id again. */
  async unprotectRows (): Promise<PassResult> {
    const result: PassResult = { rows: 0, expired: 0 };
    await concurrentSafeWrite.execute(() => this.db.transaction(() => {
      const rows = this.db.prepare<{ id: string; id_enc: string }>('SELECT id, id_enc FROM sessions WHERE id_enc IS NOT NULL').all();
      const upd = this.db.prepare('UPDATE sessions SET id = ?, id_enc = NULL WHERE id = ? AND id_enc = ?');
      for (const row of rows) result.rows += upd.run(this.clearId(row), row.id, row.id_enc).changes;
    }).immediate());
    return result;
  }

  /** Re-key under the configured key the sessions protected under one of `previous`. */
  async rekeyRows (previous: TokenProtection[]): Promise<PassResult> {
    const result: PassResult = { rows: 0, expired: 0 };
    await concurrentSafeWrite.execute(() => this.db.transaction(() => {
      const rows = this.db.prepare<{ id: string; id_enc: string }>('SELECT id, id_enc FROM sessions WHERE id_enc IS NOT NULL').all();
      const upd = this.db.prepare('UPDATE sessions SET id = ?, id_enc = ? WHERE id = ? AND id_enc = ?');
      for (const row of rows) {
        if (this.tokenProtection.ownsHash(row.id)) continue;
        const from = previous.find((p) => p.ownsHash(row.id));
        if (from == null) continue;
        const id = from.openSessionId(row.id, row.id_enc);
        const key = this.key(id);
        result.rows += upd.run(key, this.tokenProtection.sealSessionId(key, id), row.id, row.id_enc).changes;
      }
    }).immediate());
    return result;
  }

  tokenStatus (): { clear: number; protectedCurrentKey: number; protectedOtherKeys: Record<string, number> } {
    const rows = this.db.prepare<{ k: string; n: number }>('SELECT CASE WHEN id_enc IS NULL THEN \'clear\' ELSE substr(id, 1, 8) END AS k, ' +
      'COUNT(*) AS n FROM sessions GROUP BY 1').all();
    const status = { clear: 0, protectedCurrentKey: 0, protectedOtherKeys: {} as Record<string, number> };
    for (const r of rows) {
      if (r.k === 'clear') status.clear = r.n;
      else if (r.k === this.tokenProtection.kid) status.protectedCurrentKey = r.n;
      else status.protectedOtherKeys[r.k] = r.n;
    }
    return status;
  }
}

export { SessionsSQLite };
