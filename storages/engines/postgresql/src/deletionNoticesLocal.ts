/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL implementation of DeletionNoticesLocalDB, on the
 * `cmc_deletion_notices` table (schema in DatabasePG.ts). The endpoint of a
 * pending row holds a token of an access on another platform: it is stored
 * sealed (see `interfaces/_shared/deletionNoticeSeal.ts`), a terminal row
 * keeps the credential-free URL in clear.
 */

import { getConfigSync } from '@pryv/boiler';
import { resolveTokenProtection } from 'business/src/accesses/tokenProtection.ts';
import { _internals } from './_internals.ts';
import type { DeletionNoticeRow, DeletionNoticeStatus } from '../../../interfaces/baseStorage/DeletionNoticesLocalDB.ts';
import type { TokenProtection } from '../../../interfaces/_shared/tokenProtection.ts';
import {
  storedEndpoint, openedEndpoint, sealedNoticeStatus, rekeyedEndpoint, noticeContext
} from '../../../interfaces/_shared/deletionNoticeSeal.ts';
import type { NoticeSealStatus } from '../../../interfaces/_shared/deletionNoticeSeal.ts';

const logger = _internals.lazyLogger('storage:deletion-notices-pg');

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
  ensureConnect?: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[], rowCount?: number | null }>;
};

class DeletionNoticesLocalPG {
  db!: PgDbLike;
  tokenProtection!: TokenProtection;

  /** Without arguments (the engine factory) `init()` sets both; the passes of `tokensAtRest.ts` pass them. */
  constructor (db?: PgDbLike, tokenProtection?: TokenProtection) {
    if (db != null) this.db = db;
    if (tokenProtection != null) this.tokenProtection = tokenProtection;
  }

  async init (): Promise<void> {
    this.db = _internals.databasePG as PgDbLike;
    this.tokenProtection = (_internals.tokenProtection as TokenProtection | undefined) ?? resolveTokenProtection(getConfigSync());
    await this.db.ensureConnect?.();
  }

  toRow (r: Row): DeletionNoticeRow {
    return {
      id: r.id,
      deletedUserId: r.deleted_user_id,
      accessId: r.access_id,
      apiEndpoint: openedEndpoint(this.tokenProtection, r.id, r.api_endpoint, (m) => logger.error(m)),
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

  async insert (row: DeletionNoticeRow): Promise<void> {
    await this.db.query(
      'INSERT INTO cmc_deletion_notices (id, deleted_user_id, access_id, api_endpoint, path, body, attempts, next_attempt_after, status, last_failure_reason, last_failure_detail, created_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
      [row.id, row.deletedUserId, row.accessId, storedEndpoint(this.tokenProtection, row.id, row.status, row.apiEndpoint), row.path,
        JSON.stringify(row.body ?? null), row.attempts, row.nextAttemptAfter, row.status,
        row.lastFailureReason, row.lastFailureDetail == null ? null : JSON.stringify(row.lastFailureDetail), row.createdAt]
    );
  }

  async listDue (now: number, limit: number): Promise<DeletionNoticeRow[]> {
    const res = await this.db.query(
      "SELECT * FROM cmc_deletion_notices WHERE status = 'pending' AND next_attempt_after <= $1 ORDER BY created_at ASC LIMIT $2",
      [now, limit]
    );
    return res.rows.map((r) => this.toRow(r));
  }

  async countPending (): Promise<number> {
    const res = await this.db.query("SELECT COUNT(*) AS n FROM cmc_deletion_notices WHERE status = 'pending'");
    return Number((res.rows[0] as unknown as { n: string | number } | undefined)?.n ?? 0);
  }

  async update (row: DeletionNoticeRow): Promise<boolean> {
    const res = await this.db.query(
      'UPDATE cmc_deletion_notices SET api_endpoint = $1, attempts = $2, next_attempt_after = $3, status = $4, last_failure_reason = $5, last_failure_detail = $6 WHERE id = $7',
      [storedEndpoint(this.tokenProtection, row.id, row.status, row.apiEndpoint), row.attempts, row.nextAttemptAfter, row.status, row.lastFailureReason,
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
    return res.rows.map((r) => this.toRow(r));
  }

  async deleteAll (): Promise<void> {
    await this.db.query('DELETE FROM cmc_deletion_notices');
  }

  // ---- Passes of `tokensAtRest.ts` (small table: row by row, compare-and-set) ----

  /** Seal the endpoint of every pending row still holding it in clear. Idempotent. */
  async protectClearRows (): Promise<number> {
    const res = await this.db.query(
      "SELECT id, status, api_endpoint FROM cmc_deletion_notices WHERE status = 'pending' AND api_endpoint NOT LIKE 'sealed:%' AND api_endpoint <> ''");
    let n = 0;
    for (const r of res.rows) {
      const upd = await this.db.query('UPDATE cmc_deletion_notices SET api_endpoint = $1 WHERE id = $2 AND api_endpoint = $3',
        [storedEndpoint(this.tokenProtection, r.id, r.status, r.api_endpoint), r.id, r.api_endpoint]);
      n += upd.rowCount ?? 0;
    }
    return n;
  }

  /** Rollback aid: the clear endpoint written back; a value that does not open is left (the outbox retires it). */
  async unprotectRows (): Promise<number> {
    const res = await this.db.query("SELECT id, api_endpoint FROM cmc_deletion_notices WHERE api_endpoint LIKE 'sealed:%'");
    let n = 0;
    for (const r of res.rows) {
      let clear: string;
      try {
        clear = this.tokenProtection.openSecret(noticeContext(r.id), r.api_endpoint);
      } catch (err) {
        logger.error('deletion notice ' + JSON.stringify(r.id) + ': stored endpoint unreadable, left sealed (' + (err as Error).message + ')');
        continue;
      }
      const upd = await this.db.query('UPDATE cmc_deletion_notices SET api_endpoint = $1 WHERE id = $2 AND api_endpoint = $3',
        [clear, r.id, r.api_endpoint]);
      n += upd.rowCount ?? 0;
    }
    return n;
  }

  /** Re-seal under the configured key the endpoints sealed under one of `previous`; others are left for the retire rule. */
  async rekeyRows (previous: TokenProtection[]): Promise<number> {
    const res = await this.db.query("SELECT id, api_endpoint FROM cmc_deletion_notices WHERE api_endpoint LIKE 'sealed:%'");
    let n = 0;
    for (const r of res.rows) {
      const next = rekeyedEndpoint(this.tokenProtection, previous, r.id, r.api_endpoint);
      if (next == null) continue;
      const upd = await this.db.query('UPDATE cmc_deletion_notices SET api_endpoint = $1 WHERE id = $2 AND api_endpoint = $3',
        [next, r.id, r.api_endpoint]);
      n += upd.rowCount ?? 0;
    }
    return n;
  }

  async sealStatus (): Promise<NoticeSealStatus> {
    const res = await this.db.query('SELECT status, api_endpoint FROM cmc_deletion_notices');
    return sealedNoticeStatus(this.tokenProtection, res.rows.map((r) => ({ status: r.status, apiEndpoint: r.api_endpoint })));
  }
}

export { DeletionNoticesLocalPG };
