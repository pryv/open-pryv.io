/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL implementation of ErasuresLocalDB, on the `account_erasures`
 * table (schema in DatabasePG.ts).
 */

import { _internals } from './_internals.ts';
import type { AccountErasureRow } from '../../../interfaces/baseStorage/ErasuresLocalDB.ts';

type Row = {
  user_id: string,
  username: string,
  trigger: string | null,
  started_at: string | number,
  updated_at: string | number,
  done_steps: unknown,
  series_namespaces: unknown,
  attempts: number,
  last_error: string | null
};
type PgDbLike = {
  ensureConnect: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[], rowCount?: number | null }>;
};

function toRow (r: Row): AccountErasureRow {
  return {
    userId: r.user_id,
    username: r.username,
    trigger: r.trigger,
    startedAt: Number(r.started_at),
    updatedAt: Number(r.updated_at),
    doneSteps: Array.isArray(r.done_steps) ? r.done_steps as string[] : [],
    seriesNamespaces: Array.isArray(r.series_namespaces) ? r.series_namespaces as string[] : null,
    attempts: Number(r.attempts),
    lastError: r.last_error
  };
}

class ErasuresLocalPG {
  db!: PgDbLike;

  async init (): Promise<void> {
    this.db = _internals.databasePG as PgDbLike;
    await this.db.ensureConnect();
  }

  async put (row: AccountErasureRow): Promise<void> {
    await this.db.query(
      'INSERT INTO account_erasures (user_id, username, trigger, started_at, updated_at, done_steps, series_namespaces, attempts, last_error) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ' +
        'ON CONFLICT (user_id) DO UPDATE SET username = $2, trigger = $3, started_at = $4, updated_at = $5, done_steps = $6, series_namespaces = $7, attempts = $8, last_error = $9',
      [row.userId, row.username, row.trigger, row.startedAt, row.updatedAt, JSON.stringify(row.doneSteps),
        row.seriesNamespaces == null ? null : JSON.stringify(row.seriesNamespaces), row.attempts, row.lastError]
    );
  }

  async insertIfAbsent (row: AccountErasureRow): Promise<boolean> {
    const res = await this.db.query(
      'INSERT INTO account_erasures (user_id, username, trigger, started_at, updated_at, done_steps, series_namespaces, attempts, last_error) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (user_id) DO NOTHING',
      [row.userId, row.username, row.trigger, row.startedAt, row.updatedAt, JSON.stringify(row.doneSteps),
        row.seriesNamespaces == null ? null : JSON.stringify(row.seriesNamespaces), row.attempts, row.lastError]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async claim (userId: string, expectedUpdatedAt: number, updatedAt: number): Promise<boolean> {
    const res = await this.db.query('UPDATE account_erasures SET updated_at = $3 WHERE user_id = $1 AND updated_at = $2', [userId, expectedUpdatedAt, updatedAt]);
    return (res.rowCount ?? 0) > 0;
  }

  async get (userId: string): Promise<AccountErasureRow | null> {
    const res = await this.db.query('SELECT * FROM account_erasures WHERE user_id = $1', [userId]);
    return res.rows.length > 0 ? toRow(res.rows[0]) : null;
  }

  async listAll (): Promise<AccountErasureRow[]> {
    const res = await this.db.query('SELECT * FROM account_erasures ORDER BY started_at ASC');
    return res.rows.map(toRow);
  }

  async delete (userId: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM account_erasures WHERE user_id = $1', [userId]);
    return (res.rowCount ?? 0) > 0;
  }

  async deleteAll (): Promise<void> {
    await this.db.query('DELETE FROM account_erasures');
  }
}

export { ErasuresLocalPG };
