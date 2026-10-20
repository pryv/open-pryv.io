/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * PostgreSQL implementation of ExternalIdsLocalDB, on the `external_ids`
 * table (schema in DatabasePG.ts).
 */

import { _internals } from './_internals.ts';
import { ExternalIdConflict } from '../../../interfaces/baseStorage/ExternalIdsLocalDB.ts';
import type { ExternalIdRow } from '../../../interfaces/baseStorage/ExternalIdsLocalDB.ts';

type Row = { user_id: string, ns_token: string, value_token: string, blinded_value: string, claimed_at: number };
type PgDbLike = {
  ensureConnect: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[], rowCount?: number | null }>;
};

function toRow (r: Row): ExternalIdRow {
  return { userId: r.user_id, nsToken: r.ns_token, valueToken: r.value_token, blindedValue: r.blinded_value, claimedAt: Number(r.claimed_at) };
}

/** Map a unique-constraint failure to its reason; anything else is rethrown. */
function asConflict (err: unknown): unknown {
  const e = err as { code?: string, constraint?: string };
  if (e.code === '23505') {
    return new ExternalIdConflict(e.constraint === 'external_ids_value_pkey' ? 'value-taken' : 'namespace-taken');
  }
  return err;
}

class ExternalIdsLocalPG {
  db!: PgDbLike;

  async init (): Promise<void> {
    this.db = _internals.databasePG as PgDbLike;
    await this.db.ensureConnect();
  }

  async insert (row: ExternalIdRow): Promise<void> {
    try {
      await this.db.query(
        'INSERT INTO external_ids (user_id, ns_token, value_token, blinded_value, claimed_at) VALUES ($1, $2, $3, $4, $5)',
        [row.userId, row.nsToken, row.valueToken, row.blindedValue, row.claimedAt]
      );
    } catch (err) {
      throw asConflict(err);
    }
  }

  async getByUser (userId: string): Promise<ExternalIdRow[]> {
    const res = await this.db.query('SELECT * FROM external_ids WHERE user_id = $1', [userId]);
    return res.rows.map(toRow);
  }

  async getByTokens (nsToken: string, valueToken: string): Promise<ExternalIdRow | null> {
    const res = await this.db.query('SELECT * FROM external_ids WHERE ns_token = $1 AND value_token = $2', [nsToken, valueToken]);
    return res.rows.length === 0 ? null : toRow(res.rows[0]);
  }

  async getByUserAndNamespace (userId: string, nsToken: string): Promise<ExternalIdRow | null> {
    const res = await this.db.query('SELECT * FROM external_ids WHERE user_id = $1 AND ns_token = $2', [userId, nsToken]);
    return res.rows.length === 0 ? null : toRow(res.rows[0]);
  }

  async replaceForUser (userId: string, nsToken: string, values: { valueToken: string, blindedValue: string, claimedAt: number }): Promise<boolean> {
    try {
      const res = await this.db.query(
        'UPDATE external_ids SET value_token = $1, blinded_value = $2, claimed_at = $3 WHERE user_id = $4 AND ns_token = $5',
        [values.valueToken, values.blindedValue, values.claimedAt, userId, nsToken]
      );
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      throw asConflict(err);
    }
  }

  async retoken (userId: string, oldNsToken: string, tokens: { nsToken: string, valueToken: string }): Promise<boolean> {
    try {
      const res = await this.db.query(
        'UPDATE external_ids SET ns_token = $1, value_token = $2 WHERE user_id = $3 AND ns_token = $4',
        [tokens.nsToken, tokens.valueToken, userId, oldNsToken]
      );
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      throw asConflict(err);
    }
  }

  async deleteByUserAndNamespace (userId: string, nsToken: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM external_ids WHERE user_id = $1 AND ns_token = $2', [userId, nsToken]);
    return (res.rowCount ?? 0) > 0;
  }

  async deleteByUser (userId: string): Promise<number> {
    const res = await this.db.query('DELETE FROM external_ids WHERE user_id = $1', [userId]);
    return res.rowCount ?? 0;
  }

  async scanAll (): Promise<ExternalIdRow[]> {
    const res = await this.db.query('SELECT * FROM external_ids');
    return res.rows.map(toRow);
  }

  async deleteAll (): Promise<void> {
    await this.db.query('DELETE FROM external_ids');
  }
}

export { ExternalIdsLocalPG };
