/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL implementation of DeletionNoticesLocalDB, on the
 * `cmc_deletion_notices` table (schema in DatabasePG.ts).
 */

import { _internals } from './_internals.ts';
import type { DeletionNoticeRow, DeletionNoticeStatus } from '../../../interfaces/baseStorage/DeletionNoticesLocalDB.ts';

type Row = {
  id: string,
  deleted_user_id: string,
  access_id: string | null,
  api_endpoint: string,
  path: string,
  body: unknown,
  attempts: number,
  next_attempt_after: string | number,
  status: string,
  last_failure_reason: string | null,
  last_failure_detail: unknown,
  created_at: string | number
};
type PgDbLike = {
  ensureConnect: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[], rowCount?: number | null }>;
};

function toRow (r: Row): DeletionNoticeRow {
  return {
    id: r.id,
    deletedUserId: r.deleted_user_id,
    accessId: r.access_id,
    apiEndpoint: r.api_endpoint,
    path: r.path,
    body: r.body,
    attempts: Number(r.attempts),
    nextAttemptAfter: Number(r.next_attempt_after),
    status: r.status as DeletionNoticeStatus,
    lastFailureReason: r.last_failure_reason,
    lastFailureDetail: r.last_failure_detail ?? null,
    createdAt: Number(r.created_at)
  };
}

class DeletionNoticesLocalPG {
  db!: PgDbLike;

  async init (): Promise<void> {
    this.db = _internals.databasePG as PgDbLike;
    await this.db.ensureConnect();
  }

  async insert (row: DeletionNoticeRow): Promise<void> {
    await this.db.query(
      'INSERT INTO cmc_deletion_notices (id, deleted_user_id, access_id, api_endpoint, path, body, attempts, next_attempt_after, status, last_failure_reason, last_failure_detail, created_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
      [row.id, row.deletedUserId, row.accessId, row.apiEndpoint, row.path, JSON.stringify(row.body ?? null), row.attempts, row.nextAttemptAfter, row.status,
        row.lastFailureReason, row.lastFailureDetail == null ? null : JSON.stringify(row.lastFailureDetail), row.createdAt]
    );
  }

  async listDue (now: number, limit: number): Promise<DeletionNoticeRow[]> {
    const res = await this.db.query(
      "SELECT * FROM cmc_deletion_notices WHERE status = 'pending' AND next_attempt_after <= $1 ORDER BY created_at ASC LIMIT $2",
      [now, limit]
    );
    return res.rows.map(toRow);
  }

  async countPending (): Promise<number> {
    const res = await this.db.query("SELECT COUNT(*) AS n FROM cmc_deletion_notices WHERE status = 'pending'");
    return Number((res.rows[0] as unknown as { n: string | number } | undefined)?.n ?? 0);
  }

  async update (row: DeletionNoticeRow): Promise<boolean> {
    const res = await this.db.query(
      'UPDATE cmc_deletion_notices SET api_endpoint = $1, attempts = $2, next_attempt_after = $3, status = $4, last_failure_reason = $5, last_failure_detail = $6 WHERE id = $7',
      [row.apiEndpoint, row.attempts, row.nextAttemptAfter, row.status, row.lastFailureReason,
        row.lastFailureDetail == null ? null : JSON.stringify(row.lastFailureDetail), row.id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async delete (id: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM cmc_deletion_notices WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async pruneFailedBefore (createdBefore: number): Promise<number> {
    const res = await this.db.query("DELETE FROM cmc_deletion_notices WHERE status = 'failed-permanent' AND created_at < $1", [createdBefore]);
    return res.rowCount ?? 0;
  }

  async listAll (): Promise<DeletionNoticeRow[]> {
    const res = await this.db.query('SELECT * FROM cmc_deletion_notices ORDER BY created_at ASC');
    return res.rows.map(toRow);
  }

  async deleteAll (): Promise<void> {
    await this.db.query('DELETE FROM cmc_deletion_notices');
  }
}

export { DeletionNoticesLocalPG };
