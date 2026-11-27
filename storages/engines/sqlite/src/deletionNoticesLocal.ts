/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * SQLite implementation of DeletionNoticesLocalDB: one core-wide file next to
 * the users index. The endpoint of a pending row holds a token of an access
 * on another platform: it is stored sealed (see
 * `interfaces/_shared/deletionNoticeSeal.ts`), a terminal row keeps the
 * credential-free URL in clear.
 */

import fs from 'node:fs';
import SQLite3 from 'better-sqlite3';
import { getConfigSync } from '@pryv/boiler';
import { resolveTokenProtection } from 'business/src/accesses/tokenProtection.ts';
import { execute, initWALAndConcurrentSafeWriteCapabilities } from './concurrentSafeWrite.ts';
import { _internals } from './_internals.ts';
import type { DeletionNoticeRow, DeletionNoticeStatus } from '../../../interfaces/baseStorage/DeletionNoticesLocalDB.ts';
import type { SqliteDb, SqliteStmt } from './types.ts';
import type { TokenProtection } from '../../../interfaces/_shared/tokenProtection.ts';
import {
  storedEndpoint, openedEndpoint, sealedNoticeStatus, rekeyedEndpoint, noticeContext
} from '../../../interfaces/_shared/deletionNoticeSeal.ts';
import type { NoticeSealStatus } from '../../../interfaces/_shared/deletionNoticeSeal.ts';

const logger = _internals.lazyLogger('storage:deletion-notices-sqlite');

type Row = {
  id: string,
  deleted_user_id: string,
  access_id: string | null,
  api_endpoint: string,
  path: string,
  body: string,
  attempts: number,
  next_attempt_after: number,
  status: string,
  last_failure_reason: string | null,
  last_failure_detail: string | null,
  created_at: number
};

type SqliteDbWithPragmas = SqliteDb & { pragma: (s: string) => unknown, unsafeMode: (b: boolean) => unknown };

class DeletionNoticesLocalSQLite {
  db!: SqliteDb;
  tokenProtection!: TokenProtection;

  /** Without argument (the engine factory) `init()` resolves the protection; the passes of `tokensAtRest.ts` pass it. */
  constructor (tokenProtection?: TokenProtection) {
    if (tokenProtection != null) this.tokenProtection = tokenProtection;
  }

  toRow (r: Row): DeletionNoticeRow {
    return {
      id: r.id,
      deletedUserId: r.deleted_user_id,
      accessId: r.access_id,
      apiEndpoint: openedEndpoint(this.tokenProtection, r.id, r.api_endpoint, (m) => logger.error(m)),
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

  toParams (row: DeletionNoticeRow): Record<string, unknown> {
    return {
      ...row,
      apiEndpoint: storedEndpoint(this.tokenProtection, row.id, row.status, row.apiEndpoint),
      body: JSON.stringify(row.body ?? null),
      lastFailureDetail: row.lastFailureDetail == null ? null : JSON.stringify(row.lastFailureDetail)
    };
  }

  qInsert!: SqliteStmt;
  qDue!: SqliteStmt<Row>;
  qCountPending!: SqliteStmt<{ n: number }>;
  qUpdate!: SqliteStmt;
  qDelete!: SqliteStmt;
  qPrune!: SqliteStmt;
  qAll!: SqliteStmt<Row>;
  qDeleteAll!: SqliteStmt;

  async init (): Promise<void> {
    this.tokenProtection ??= (_internals.tokenProtection as TokenProtection | undefined) ?? resolveTokenProtection(getConfigSync());
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
    await execute(() => { this.qInsert.run(this.toParams(row)); });
  }

  async listDue (now: number, limit: number): Promise<DeletionNoticeRow[]> {
    return this.qDue.all(now, limit).map((r) => this.toRow(r));
  }

  async countPending (): Promise<number> {
    return this.qCountPending.get()?.n ?? 0;
  }

  async update (row: DeletionNoticeRow): Promise<boolean> {
    let changes = 0;
    await execute(() => { changes = this.qUpdate.run(this.toParams(row)).changes; });
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
    return this.qAll.all().map((r) => this.toRow(r));
  }

  async deleteAll (): Promise<void> {
    await execute(() => { this.qDeleteAll.run(); });
  }

  // ---- Passes of `tokensAtRest.ts` (small table: row by row, compare-and-set) ----

  async _rewrite (select: string, next: (r: { id: string; status: string; api_endpoint: string }) => string | null): Promise<number> {
    let n = 0;
    await execute(() => {
      const rows = this.db.prepare<{ id: string; status: string; api_endpoint: string }>(select).all();
      const upd = this.db.prepare('UPDATE cmc_deletion_notices SET api_endpoint = ? WHERE id = ? AND api_endpoint = ?');
      for (const r of rows) {
        const value = next(r);
        if (value == null || value === r.api_endpoint) continue;
        n += upd.run(value, r.id, r.api_endpoint).changes;
      }
    });
    return n;
  }

  /** Seal the endpoint of every pending row still holding it in clear. Idempotent. */
  async protectClearRows (): Promise<number> {
    return await this._rewrite(
      "SELECT id, status, api_endpoint FROM cmc_deletion_notices WHERE status = 'pending' AND substr(api_endpoint, 1, 7) <> 'sealed:' AND api_endpoint <> ''",
      (r) => storedEndpoint(this.tokenProtection, r.id, r.status, r.api_endpoint));
  }

  /** Rollback aid: the clear endpoint written back; a value that does not open is left (the outbox retires it). */
  async unprotectRows (): Promise<number> {
    return await this._rewrite(
      "SELECT id, status, api_endpoint FROM cmc_deletion_notices WHERE substr(api_endpoint, 1, 7) = 'sealed:'",
      (r) => {
        try {
          return this.tokenProtection.openSecret(noticeContext(r.id), r.api_endpoint);
        } catch (err) {
          logger.error('deletion notice ' + JSON.stringify(r.id) + ': stored endpoint unreadable, left sealed (' + (err as Error).message + ')');
          return null;
        }
      });
  }

  /** Re-seal under the configured key the endpoints sealed under one of `previous`; others are left for the retire rule. */
  async rekeyRows (previous: TokenProtection[]): Promise<number> {
    return await this._rewrite(
      "SELECT id, status, api_endpoint FROM cmc_deletion_notices WHERE substr(api_endpoint, 1, 7) = 'sealed:'",
      (r) => rekeyedEndpoint(this.tokenProtection, previous, r.id, r.api_endpoint, (m) => logger.error(m)));
  }

  async sealStatus (): Promise<NoticeSealStatus> {
    const rows = this.db.prepare<{ status: string; api_endpoint: string }>('SELECT status, api_endpoint FROM cmc_deletion_notices').all();
    return sealedNoticeStatus(this.tokenProtection, rows.map((r) => ({ status: r.status, apiEndpoint: r.api_endpoint })));
  }
}

export { DeletionNoticesLocalSQLite };
