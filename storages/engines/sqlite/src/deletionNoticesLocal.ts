/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * SQLite implementation of DeletionNoticesLocalDB: one core-wide file next to
 * the users index.
 */

import fs from 'node:fs';
import SQLite3 from 'better-sqlite3';
import { execute, initWALAndConcurrentSafeWriteCapabilities } from './concurrentSafeWrite.ts';
import { _internals } from './_internals.ts';
import type { DeletionNoticeRow, DeletionNoticeStatus } from '../../../interfaces/baseStorage/DeletionNoticesLocalDB.ts';
import type { SqliteDb, SqliteStmt } from './types.ts';

type Row = {
  id: string, deleted_user_id: string, access_id: string | null, api_endpoint: string, path: string, body: string,
  attempts: number, next_attempt_after: number, status: string, last_failure_reason: string | null,
  last_failure_detail: string | null, created_at: number
};

type SqliteDbWithPragmas = SqliteDb & { pragma: (s: string) => unknown, unsafeMode: (b: boolean) => unknown };

function toRow (r: Row): DeletionNoticeRow {
  return {
    id: r.id,
    deletedUserId: r.deleted_user_id,
    accessId: r.access_id,
    apiEndpoint: r.api_endpoint,
    path: r.path,
    body: JSON.parse(r.body),
    attempts: r.attempts,
    nextAttemptAfter: r.next_attempt_after,
    status: r.status as DeletionNoticeStatus,
    lastFailureReason: r.last_failure_reason,
    lastFailureDetail: r.last_failure_detail == null ? null : JSON.parse(r.last_failure_detail),
    createdAt: r.created_at
  };
}

function toParams (row: DeletionNoticeRow): Record<string, unknown> {
  return {
    ...row,
    body: JSON.stringify(row.body ?? null),
    lastFailureDetail: row.lastFailureDetail == null ? null : JSON.stringify(row.lastFailureDetail)
  };
}

class DeletionNoticesLocalSQLite {
  db!: SqliteDb;
  qInsert!: SqliteStmt;
  qDue!: SqliteStmt<Row>;
  qCountPending!: SqliteStmt<{ n: number }>;
  qUpdate!: SqliteStmt;
  qDelete!: SqliteStmt;
  qPrune!: SqliteStmt;
  qAll!: SqliteStmt<Row>;
  qDeleteAll!: SqliteStmt;

  async init (): Promise<void> {
    const basePath = (_internals.config as { path: string }).path;
    fs.mkdirSync(basePath, { recursive: true });
    const db = new SQLite3(basePath + '/cmc-deletion-notices.db') as SqliteDbWithPragmas;
    await initWALAndConcurrentSafeWriteCapabilities(db);
    this.db = db;
    await execute(() => {
      this.db.prepare(`CREATE TABLE IF NOT EXISTS cmc_deletion_notices (
        id TEXT PRIMARY KEY,
        deleted_user_id TEXT NOT NULL,
        access_id TEXT,
        api_endpoint TEXT NOT NULL,
        path TEXT NOT NULL,
        body TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        next_attempt_after INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_failure_reason TEXT,
        last_failure_detail TEXT,
        created_at INTEGER NOT NULL
      );`).run();
    });
    await execute(() => {
      this.db.prepare('CREATE INDEX IF NOT EXISTS cmc_deletion_notices_due ON cmc_deletion_notices(status, next_attempt_after);').run();
    });
    this.qInsert = this.db.prepare('INSERT INTO cmc_deletion_notices (id, deleted_user_id, access_id, api_endpoint, path, body, attempts, next_attempt_after, status, last_failure_reason, last_failure_detail, created_at) ' +
      'VALUES (@id, @deletedUserId, @accessId, @apiEndpoint, @path, @body, @attempts, @nextAttemptAfter, @status, @lastFailureReason, @lastFailureDetail, @createdAt)');
    this.qDue = this.db.prepare<Row>("SELECT * FROM cmc_deletion_notices WHERE status = 'pending' AND next_attempt_after <= ? ORDER BY created_at ASC LIMIT ?");
    this.qCountPending = this.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM cmc_deletion_notices WHERE status = 'pending'");
    this.qUpdate = this.db.prepare('UPDATE cmc_deletion_notices SET api_endpoint = @apiEndpoint, attempts = @attempts, next_attempt_after = @nextAttemptAfter, status = @status, ' +
      'last_failure_reason = @lastFailureReason, last_failure_detail = @lastFailureDetail WHERE id = @id');
    this.qDelete = this.db.prepare('DELETE FROM cmc_deletion_notices WHERE id = ?');
    this.qPrune = this.db.prepare("DELETE FROM cmc_deletion_notices WHERE status = 'failed-permanent' AND created_at < ?");
    this.qAll = this.db.prepare<Row>('SELECT * FROM cmc_deletion_notices ORDER BY created_at ASC');
    this.qDeleteAll = this.db.prepare('DELETE FROM cmc_deletion_notices');
  }

  async insert (row: DeletionNoticeRow): Promise<void> {
    await execute(() => { this.qInsert.run(toParams(row)); });
  }

  async listDue (now: number, limit: number): Promise<DeletionNoticeRow[]> {
    return this.qDue.all(now, limit).map(toRow);
  }

  async countPending (): Promise<number> {
    return this.qCountPending.get()?.n ?? 0;
  }

  async update (row: DeletionNoticeRow): Promise<boolean> {
    let changes = 0;
    await execute(() => { changes = this.qUpdate.run(toParams(row)).changes; });
    return changes > 0;
  }

  async delete (id: string): Promise<boolean> {
    let changes = 0;
    await execute(() => { changes = this.qDelete.run(id).changes; });
    return changes > 0;
  }

  async pruneFailedBefore (createdBefore: number): Promise<number> {
    let changes = 0;
    await execute(() => { changes = this.qPrune.run(createdBefore).changes; });
    return changes;
  }

  async listAll (): Promise<DeletionNoticeRow[]> {
    return this.qAll.all().map(toRow);
  }

  async deleteAll (): Promise<void> {
    await execute(() => { this.qDeleteAll.run(); });
  }
}

export { DeletionNoticesLocalSQLite };
