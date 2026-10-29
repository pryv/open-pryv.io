/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * SQLite implementation of ErasuresLocalDB: one core-wide file next to the
 * users index, outside every user directory (the erasure removes those).
 */

import fs from 'node:fs';
import SQLite3 from 'better-sqlite3';
import { execute, initWALAndConcurrentSafeWriteCapabilities } from './concurrentSafeWrite.ts';
import { _internals } from './_internals.ts';
import type { AccountErasureRow } from '../../../interfaces/baseStorage/ErasuresLocalDB.ts';
import type { SqliteDb, SqliteStmt } from './types.ts';

type Row = {
  user_id: string,
  username: string,
  trigger: string | null,
  started_at: number,
  updated_at: number,
  done_steps: string,
  series_namespaces: string | null,
  attempts: number,
  last_error: string | null
};

type SqliteDbWithPragmas = SqliteDb & { pragma: (s: string) => unknown, unsafeMode: (b: boolean) => unknown };

function toRow (r: Row): AccountErasureRow {
  return {
    userId: r.user_id,
    username: r.username,
    trigger: r.trigger,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    doneSteps: JSON.parse(r.done_steps),
    seriesNamespaces: r.series_namespaces == null ? null : JSON.parse(r.series_namespaces),
    attempts: r.attempts,
    lastError: r.last_error
  };
}

function toParams (row: AccountErasureRow): Record<string, unknown> {
  return {
    ...row,
    doneSteps: JSON.stringify(row.doneSteps),
    seriesNamespaces: row.seriesNamespaces == null ? null : JSON.stringify(row.seriesNamespaces)
  };
}

class ErasuresLocalSQLite {
  db!: SqliteDb;
  qPut!: SqliteStmt;
  qInsert!: SqliteStmt;
  qClaim!: SqliteStmt;
  qGet!: SqliteStmt<Row>;
  qAll!: SqliteStmt<Row>;
  qDelete!: SqliteStmt;
  qDeleteAll!: SqliteStmt;

  async init (): Promise<void> {
    const basePath = (_internals.config as { path: string }).path;
    fs.mkdirSync(basePath, { recursive: true });
    const db = new SQLite3(basePath + '/account-erasures.db') as SqliteDbWithPragmas;
    await initWALAndConcurrentSafeWriteCapabilities(db);
    this.db = db;
    await execute(() => {
      this.db.prepare(`CREATE TABLE IF NOT EXISTS account_erasures (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        trigger TEXT,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        done_steps TEXT NOT NULL,
        series_namespaces TEXT,
        attempts INTEGER NOT NULL,
        last_error TEXT
      );`).run();
    });
    this.qPut = this.db.prepare('INSERT OR REPLACE INTO account_erasures (user_id, username, trigger, started_at, updated_at, done_steps, series_namespaces, attempts, last_error) ' +
      'VALUES (@userId, @username, @trigger, @startedAt, @updatedAt, @doneSteps, @seriesNamespaces, @attempts, @lastError)');
    this.qInsert = this.db.prepare('INSERT OR IGNORE INTO account_erasures (user_id, username, trigger, started_at, updated_at, done_steps, series_namespaces, attempts, last_error) ' +
      'VALUES (@userId, @username, @trigger, @startedAt, @updatedAt, @doneSteps, @seriesNamespaces, @attempts, @lastError)');
    this.qClaim = this.db.prepare('UPDATE account_erasures SET updated_at = ? WHERE user_id = ? AND updated_at = ?');
    this.qGet = this.db.prepare<Row>('SELECT * FROM account_erasures WHERE user_id = ?');
    this.qAll = this.db.prepare<Row>('SELECT * FROM account_erasures ORDER BY started_at ASC');
    this.qDelete = this.db.prepare('DELETE FROM account_erasures WHERE user_id = ?');
    this.qDeleteAll = this.db.prepare('DELETE FROM account_erasures');
  }

  async put (row: AccountErasureRow): Promise<void> {
    await execute(() => { this.qPut.run(toParams(row)); });
  }

  async insertIfAbsent (row: AccountErasureRow): Promise<boolean> {
    let changes = 0;
    await execute(() => { changes = this.qInsert.run(toParams(row)).changes; });
    return changes > 0;
  }

  async claim (userId: string, expectedUpdatedAt: number, updatedAt: number): Promise<boolean> {
    let changes = 0;
    await execute(() => { changes = this.qClaim.run(updatedAt, userId, expectedUpdatedAt).changes; });
    return changes > 0;
  }

  async get (userId: string): Promise<AccountErasureRow | null> {
    const r = this.qGet.get(userId);
    return r == null ? null : toRow(r);
  }

  async listAll (): Promise<AccountErasureRow[]> {
    return this.qAll.all().map(toRow);
  }

  async delete (userId: string): Promise<boolean> {
    let changes = 0;
    await execute(() => { changes = this.qDelete.run(userId).changes; });
    return changes > 0;
  }

  async deleteAll (): Promise<void> {
    await execute(() => { this.qDeleteAll.run(); });
  }
}

export { ErasuresLocalSQLite };
