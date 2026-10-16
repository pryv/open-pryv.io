/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * SQLite implementation of ExternalIdsLocalDB: one core-wide file next to the
 * users index (deletion, reconcile and the tools scan the whole core).
 */

import fs from 'node:fs';
import SQLite3 from 'better-sqlite3';
import { execute, initWALAndConcurrentSafeWriteCapabilities } from './concurrentSafeWrite.ts';
import { _internals } from './_internals.ts';
import { ExternalIdConflict } from '../../../interfaces/baseStorage/ExternalIdsLocalDB.ts';
import type { ExternalIdRow } from '../../../interfaces/baseStorage/ExternalIdsLocalDB.ts';
import type { SqliteDb, SqliteStmt } from './types.ts';

type Row = { user_id: string, ns_token: string, value_token: string, blinded_value: string, claimed_at: number };
type SqliteDbWithPragmas = SqliteDb & { pragma: (s: string) => unknown, unsafeMode: (b: boolean) => unknown };

function toRow (r: Row): ExternalIdRow {
  return { userId: r.user_id, nsToken: r.ns_token, valueToken: r.value_token, blindedValue: r.blinded_value, claimedAt: r.claimed_at };
}

/** Map a unique-constraint failure to its reason; anything else is rethrown. */
function asConflict (err: unknown): unknown {
  const e = err as { code?: string, message?: string };
  if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    // The (ns_token, value_token) key names value_token; the other constraint is (user_id, ns_token).
    return new ExternalIdConflict(e.message?.includes('value_token') === true ? 'value-taken' : 'namespace-taken');
  }
  return err;
}

class ExternalIdsLocalSQLite {
  db!: SqliteDb;
  qInsert!: SqliteStmt;
  qByUser!: SqliteStmt<Row>;
  qByTokens!: SqliteStmt<Row>;
  qByUserNs!: SqliteStmt<Row>;
  qReplace!: SqliteStmt;
  qDeleteUserNs!: SqliteStmt;
  qDeleteUser!: SqliteStmt;
  qAll!: SqliteStmt<Row>;
  qDeleteAll!: SqliteStmt;

  async init (): Promise<void> {
    const basePath = (_internals.config as { path: string }).path;
    fs.mkdirSync(basePath, { recursive: true });
    const db = new SQLite3(basePath + '/external-ids.db') as SqliteDbWithPragmas;
    await initWALAndConcurrentSafeWriteCapabilities(db);
    this.db = db;
    await execute(() => {
      this.db.prepare(`CREATE TABLE IF NOT EXISTS external_ids (
        user_id TEXT NOT NULL,
        ns_token TEXT NOT NULL,
        value_token TEXT NOT NULL,
        blinded_value TEXT NOT NULL,
        claimed_at REAL NOT NULL,
        PRIMARY KEY (ns_token, value_token),
        UNIQUE (user_id, ns_token)
      );`).run();
    });
    await execute(() => {
      this.db.prepare('CREATE INDEX IF NOT EXISTS external_ids_user ON external_ids(user_id);').run();
    });
    this.qInsert = this.db.prepare('INSERT INTO external_ids (user_id, ns_token, value_token, blinded_value, claimed_at) VALUES (@userId, @nsToken, @valueToken, @blindedValue, @claimedAt)');
    this.qByUser = this.db.prepare<Row>('SELECT * FROM external_ids WHERE user_id = ?');
    this.qByTokens = this.db.prepare<Row>('SELECT * FROM external_ids WHERE ns_token = ? AND value_token = ?');
    this.qByUserNs = this.db.prepare<Row>('SELECT * FROM external_ids WHERE user_id = ? AND ns_token = ?');
    this.qReplace = this.db.prepare('UPDATE external_ids SET value_token = @valueToken, blinded_value = @blindedValue, claimed_at = @claimedAt WHERE user_id = @userId AND ns_token = @nsToken');
    this.qDeleteUserNs = this.db.prepare('DELETE FROM external_ids WHERE user_id = ? AND ns_token = ?');
    this.qDeleteUser = this.db.prepare('DELETE FROM external_ids WHERE user_id = ?');
    this.qAll = this.db.prepare<Row>('SELECT * FROM external_ids');
    this.qDeleteAll = this.db.prepare('DELETE FROM external_ids');
  }

  async insert (row: ExternalIdRow): Promise<void> {
    try {
      await execute(() => { this.qInsert.run(row); });
    } catch (err) {
      throw asConflict(err);
    }
  }

  async getByUser (userId: string): Promise<ExternalIdRow[]> {
    return this.qByUser.all(userId).map(toRow);
  }

  async getByTokens (nsToken: string, valueToken: string): Promise<ExternalIdRow | null> {
    const r = this.qByTokens.get(nsToken, valueToken);
    return r == null ? null : toRow(r);
  }

  async getByUserAndNamespace (userId: string, nsToken: string): Promise<ExternalIdRow | null> {
    const r = this.qByUserNs.get(userId, nsToken);
    return r == null ? null : toRow(r);
  }

  async replaceForUser (userId: string, nsToken: string, values: { valueToken: string, blindedValue: string, claimedAt: number }): Promise<void> {
    try {
      await execute(() => { this.qReplace.run({ userId, nsToken, ...values }); });
    } catch (err) {
      throw asConflict(err);
    }
  }

  async deleteByUserAndNamespace (userId: string, nsToken: string): Promise<boolean> {
    let changes = 0;
    await execute(() => { changes = this.qDeleteUserNs.run(userId, nsToken).changes; });
    return changes > 0;
  }

  async deleteByUser (userId: string): Promise<number> {
    let changes = 0;
    await execute(() => { changes = this.qDeleteUser.run(userId).changes; });
    return changes;
  }

  async scanAll (): Promise<ExternalIdRow[]> {
    return this.qAll.all().map(toRow);
  }

  async deleteAll (): Promise<void> {
    await execute(() => { this.qDeleteAll.run(); });
  }
}

export { ExternalIdsLocalSQLite };
