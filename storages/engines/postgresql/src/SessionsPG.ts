/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';

import type { SessionData } from '../../../interfaces/_shared/domain.ts';
import type { TokenProtection } from '../../../interfaces/_shared/tokenProtection.ts';
const require = createRequire(import.meta.url);

// A bearer secret: from node:crypto, not an id library.
const { secureToken } = require('../../../interfaces/_shared/secureToken.ts');
type SessionPgRow = { id?: string; data?: SessionData; expires?: Date | string; id_enc?: string | null; [k: string]: unknown };
type PgQueryResult = { rows: SessionPgRow[]; rowCount?: number };
type PgDbLike = { query: (sql: string, params?: unknown[]) => Promise<PgQueryResult> };
type PassResult = { rows: number; expired: number };

const DEFAULT_MAX_AGE = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * PostgreSQL implementation of Sessions storage.
 *
 * The session id is the personal access token: the `id` column holds its
 * keyed hash, `id_enc` its encrypted copy (see `TokenProtection`). Callers
 * pass and receive the clear id.
 */
class SessionsPG {
  db: PgDbLike; // DatabasePG — query slice modelled here
  options: { maxAge: number };
  tokenProtection: TokenProtection;

  constructor (db: PgDbLike, options: { maxAge?: number } | undefined, tokenProtection: TokenProtection) {
    this.db = db;
    this.options = { maxAge: (options && options.maxAge) || DEFAULT_MAX_AGE };
    if (tokenProtection == null) {
      throw new Error('SessionsPG requires a tokenProtection ref (session ids are never stored in clear)');
    }
    this.tokenProtection = tokenProtection;
  }

  /** The stored key of a session id. */
  key (id: string): string {
    return this.tokenProtection.hashSessionId(id);
  }

  /** The clear id of a stored row. */
  clearId (row: SessionPgRow): string {
    if (row.id_enc == null) return row.id as string; // not converted yet
    return this.tokenProtection.openSessionId(row.id as string, row.id_enc);
  }

  get (id: string, callback: (err: Error | null, data?: SessionData | null) => void): void {
    if (typeof id !== 'string') return callback(null, null);
    const key = this.key(id);
    this.db.query('SELECT data, expires FROM sessions WHERE id = $1', [key])
      .then((res: PgQueryResult) => {
        if (res.rows.length === 0) return callback(null, null);
        const row = res.rows[0];
        if (new Date() >= new Date(row.expires as string | Date)) {
          this._destroyKey(key, () => callback(null, null));
          return;
        }
        callback(null, row.data);
      })
      .catch(callback);
  }

  getMatching (data: Record<string, unknown>, callback: (err: Error | null, id?: string | null) => void): void {
    this.db.query('SELECT id, id_enc, expires FROM sessions WHERE data @> $1', [JSON.stringify(data)])
      .then((res: PgQueryResult) => {
        if (res.rows.length === 0) return callback(null, null);
        const row = res.rows[0];
        if (new Date() >= new Date(row.expires as string | Date)) {
          this._destroyKey(row.id as string, () => callback(null, null));
          return;
        }
        callback(null, this.clearId(row));
      })
      .catch(callback);
  }

  generate (data: Record<string, unknown>, options: unknown, callback?: (err: Error | null, id?: string) => void): void {
    if (typeof options === 'function') {
      callback = options as (err: Error | null, id?: string) => void;
      options = {};
    }
    const id = secureToken();
    const key = this.key(id);
    const sessionData = (data && typeof data === 'object') ? data : {};
    const expires = this.getNewExpirationDate();
    this.db.query(
      'INSERT INTO sessions (id, id_enc, data, expires) VALUES ($1, $2, $3, $4)',
      [key, this.tokenProtection.sealSessionId(key, id), JSON.stringify(sessionData), expires]
    )
      .then(() => callback!(null, id))
      .catch(callback!);
  }

  /** `key(id)` as a promise: an id that cannot be hashed rejects instead of throwing. */
  private keyAsync (id: string): Promise<string> {
    return new Promise((resolve) => resolve(this.key(id)));
  }

  touch (id: string, callback: (err: Error | null, res?: unknown) => void): void {
    const expires = this.getNewExpirationDate();
    // An expired session is not extended (it stays expired until read).
    this.keyAsync(id)
      .then((key) => this.db.query('UPDATE sessions SET expires = $1 WHERE id = $2 AND expires > $3', [expires, key, new Date()]))
      .then((res: PgQueryResult) => callback(null, res))
      .catch(callback);
  }

  expireNow (id: string, callback: (err: Error | null, res?: unknown) => void): void {
    this.keyAsync(id)
      .then((key) => this.db.query('UPDATE sessions SET expires = $1 WHERE id = $2', [new Date(), key]))
      .then((res: PgQueryResult) => callback(null, res))
      .catch(callback);
  }

  destroy (id: string, callback: (err: Error | null, res?: unknown) => void): void {
    let key: string;
    try { key = this.key(id); } catch (err) { return callback(err as Error); }
    this._destroyKey(key, callback);
  }

  _destroyKey (key: string, callback: (err: Error | null, res?: unknown) => void): void {
    this.db.query('DELETE FROM sessions WHERE id = $1', [key])
      .then((res: PgQueryResult) => callback(null, res))
      .catch(callback);
  }

  clearAll (callback: (err: Error | null, res?: unknown) => void): void {
    this.db.query('DELETE FROM sessions')
      .then((res: PgQueryResult) => callback(null, res))
      .catch(callback);
  }

  remove (query: Record<string, string>, callback: (err: Error | null, res?: unknown) => void): void {
    const keys = Object.keys(query);
    if (keys.length === 0) return this.clearAll(callback);
    const conditions = keys.map((k, i) => `data->>'${k}' = $${i + 1}`);
    const values = keys.map((k) => String(query[k]));
    this.db.query(`DELETE FROM sessions WHERE ${conditions.join(' AND ')}`, values)
      .then((res: PgQueryResult) => callback(null, res))
      .catch(callback);
  }

  removeAllExcept (query: Record<string, string>, exceptId: string, callback: (err: Error | null, res?: unknown) => void): void {
    const keys = Object.keys(query);
    if (keys.length === 0) return callback(new Error('removeAllExcept requires a non-empty query'));
    const conditions = keys.map((k, i) => `data->>'${k}' = $${i + 1}`);
    const values = keys.map((k) => String(query[k]));
    try { values.push(this.key(exceptId)); } catch (err) { return callback(err as Error); }
    this.db.query(`DELETE FROM sessions WHERE ${conditions.join(' AND ')} AND id <> $${values.length}`, values)
      .then((res: unknown) => callback(null, res))
      .catch(callback);
  }

  getNewExpirationDate (): Date {
    return new Date(Date.now() + this.options.maxAge);
  }

  // -- Migration methods --

  exportAll (callback: (err: Error | null, docs?: Array<{ _id: string; data: SessionData; expires: Date }>) => void): void {
    this.db.query('SELECT id, id_enc, data, expires FROM sessions')
      .then((res: PgQueryResult) => {
        const docs = res.rows.map((r) => ({
          _id: this.clearId(r),
          data: r.data as SessionData,
          expires: r.expires as Date
        }));
        callback(null, docs);
      })
      .catch(callback);
  }

  importAll (data: Array<{ _id?: string; id?: string; data: SessionData; expires: Date }>, callback: (err: Error | null) => void): void {
    if (!data || data.length === 0) return callback(null);
    let inserts: Array<Promise<unknown>>;
    try {
      inserts = data.map((d: { _id?: string; id?: string; data: SessionData; expires: Date }) => {
        const id = (d._id || d.id) as string;
        const key = this.key(id);
        return this.db.query(
          'INSERT INTO sessions (id, id_enc, data, expires) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
          [key, this.tokenProtection.sealSessionId(key, id), JSON.stringify(d.data), d.expires]
        );
      });
    } catch (err) {
      return callback(err as Error);
    }
    Promise.all(inserts)
      .then(() => callback(null))
      .catch(callback);
  }

  // -- Token at rest: conversion, rollback, re-key --

  /** Whether any session is still keyed by its clear id. */
  async hasClearRows (): Promise<boolean> {
    const res = await this.db.query('SELECT 1 FROM sessions WHERE id_enc IS NULL LIMIT 1');
    return res.rows.length > 0;
  }

  /** Whether any protected session is under another key than the configured one. */
  async hasForeignKeyRows (): Promise<boolean> {
    const res = await this.db.query('SELECT 1 FROM sessions WHERE id_enc IS NOT NULL AND id NOT LIKE $1 LIMIT 1',
      [this.tokenProtection.kid + '.%']);
    return res.rows.length > 0;
  }

  /**
   * Convert every session keyed by its clear id: expired ones are deleted,
   * the others re-keyed by the hash with the encrypted copy, one
   * compare-and-set statement each (this one-time pass is the only statement
   * that addresses a row by its clear id). Idempotent.
   */
  async protectClearRows (): Promise<PassResult> {
    const expired = await this.db.query('DELETE FROM sessions WHERE id_enc IS NULL AND expires <= $1', [new Date()]);
    const res = await this.db.query('SELECT id FROM sessions WHERE id_enc IS NULL');
    let rows = 0;
    for (const row of res.rows) {
      const id = row.id as string;
      const key = this.key(id);
      const upd = await this.db.query('UPDATE sessions SET id = $1, id_enc = $2 WHERE id = $3 AND id_enc IS NULL',
        [key, this.tokenProtection.sealSessionId(key, id), id]);
      rows += upd.rowCount ?? 0;
    }
    return { rows, expired: expired.rowCount ?? 0 };
  }

  /** Rollback aid: key every session by its clear id again. */
  async unprotectRows (): Promise<PassResult> {
    const res = await this.db.query('SELECT id, id_enc FROM sessions WHERE id_enc IS NOT NULL');
    let rows = 0;
    for (const row of res.rows) {
      const id = this.clearId(row);
      const upd = await this.db.query('UPDATE sessions SET id = $1, id_enc = NULL WHERE id = $2 AND id_enc = $3',
        [id, row.id, row.id_enc]);
      rows += upd.rowCount ?? 0;
    }
    return { rows, expired: 0 };
  }

  /** Re-key under the configured key the sessions protected under one of `previous`. */
  async rekeyRows (previous: TokenProtection[]): Promise<PassResult> {
    const res = await this.db.query('SELECT id, id_enc FROM sessions WHERE id_enc IS NOT NULL AND id NOT LIKE $1',
      [this.tokenProtection.kid + '.%']);
    let rows = 0;
    for (const row of res.rows) {
      const from = previous.find((p) => p.ownsHash(row.id as string));
      if (from == null) continue;
      const id = from.openSessionId(row.id as string, row.id_enc as string);
      const key = this.key(id);
      const upd = await this.db.query('UPDATE sessions SET id = $1, id_enc = $2 WHERE id = $3 AND id_enc = $4',
        [key, this.tokenProtection.sealSessionId(key, id), row.id, row.id_enc]);
      rows += upd.rowCount ?? 0;
    }
    return { rows, expired: 0 };
  }

  async tokenStatus (): Promise<{ clear: number; protectedCurrentKey: number; protectedOtherKeys: Record<string, number> }> {
    const res = await this.db.query('SELECT CASE WHEN id_enc IS NULL THEN \'clear\' ELSE left(id, 8) END AS k, ' +
      'COUNT(*)::int AS n FROM sessions GROUP BY 1');
    const status = { clear: 0, protectedCurrentKey: 0, protectedOtherKeys: {} as Record<string, number> };
    for (const r of res.rows) {
      const k = r.k as string;
      const n = r.n as number;
      if (k === 'clear') status.clear = n;
      else if (k === this.tokenProtection.kid) status.protectedCurrentKey = n;
      else status.protectedOtherKeys[k] = n;
    }
    return status;
  }
}

export { SessionsPG };
