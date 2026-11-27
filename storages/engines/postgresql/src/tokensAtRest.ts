/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Access tokens and session ids at rest, PostgreSQL: the conversion pass run
 * by the migration and at every start, the guard against rows under another
 * key, and the operator passes of `bin/access-tokens.js` (status, unprotect,
 * rekey). Every pass is idempotent and works row by row with compare-and-set
 * statements.
 */

import { getConfigSync } from '@pryv/boiler';
import type { TokenProtection } from '../../../interfaces/_shared/tokenProtection.ts';
import { foreignKeyError } from '../../../interfaces/_shared/tokenProtection.ts';
import { resolveTokenProtection } from 'business/src/accesses/tokenProtection.ts';
import { _internals } from './_internals.ts';
import { AccessesPG } from './user/AccessesPG.ts';
import { SessionsPG } from './SessionsPG.ts';

type PgDbLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> };

/** The passes read and write tokens only: integrity is computed on items, not here. */
const NO_INTEGRITY = { isActive: false, set: () => {}, rowFormHash: () => '' };

type ProtectResult = {
  /** Access rows converted. */
  accesses: number;
  /** Access rows left in clear (another live access holds the same token). */
  accessesSkipped: number;
  sessions: number;
  sessionsExpired: number;
};
type ProbeResult = { columnsReady: boolean; clearRows: boolean };
type KeyStatus = { clear: number; protectedCurrentKey: number; protectedOtherKeys: Record<string, number> };

/** The protection injected at storage init, else the configured one. */
function currentProtection (): TokenProtection {
  if (_internals.tokenProtection != null) return _internals.tokenProtection as TokenProtection;
  return resolveTokenProtection(getConfigSync());
}

function stores (db: PgDbLike, tp: TokenProtection): { accesses: AccessesPG; sessions: SessionsPG } {
  return { accesses: new AccessesPG(db, NO_INTEGRITY, tp), sessions: new SessionsPG(db, {}, tp) };
}

function dbOrDefault (db?: PgDbLike): PgDbLike {
  const out = db ?? (_internals.databasePG as PgDbLike | undefined);
  if (out == null) throw new Error('access tokens at rest: PostgreSQL not initialised');
  return out;
}

/** Whether the columns of the migration are there (they are not while it is pending). */
async function columnsReady (db: PgDbLike): Promise<boolean> {
  const res = await db.query(
    'SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema() AND (' +
    '(table_name = \'accesses\' AND column_name IN (\'token_hash\', \'token_enc\')) OR ' +
    '(table_name = \'sessions\' AND column_name = \'id_enc\'))');
  return Number(res.rows[0]?.n) === 3;
}

/** Refuse rows protected under another key: every token of the core would be rejected. */
async function assertNoForeignKeyRows (db: PgDbLike, tp: TokenProtection): Promise<void> {
  const { accesses, sessions } = stores(db, tp);
  if (await accesses.hasForeignKeyRows()) throw foreignKeyError('access rows');
  if (await sessions.hasForeignKeyRows()) throw foreignKeyError('sessions');
}

/** Read-only: the guard, then whether rows wait for the conversion. */
async function probeTokensAtRest (db?: PgDbLike): Promise<ProbeResult> {
  const d = dbOrDefault(db);
  if (!await columnsReady(d)) return { columnsReady: false, clearRows: true };
  const tp = currentProtection();
  await assertNoForeignKeyRows(d, tp);
  const { accesses, sessions } = stores(d, tp);
  return { columnsReady: true, clearRows: await accesses.hasClearRows() || await sessions.hasClearRows() };
}

/**
 * The conversion pass: refuse rows under another key, then convert what is
 * still in clear. A no-op probe in steady state.
 */
async function protectTokensAtRest (db?: PgDbLike): Promise<ProtectResult> {
  const d = dbOrDefault(db);
  const tp = currentProtection();
  await assertNoForeignKeyRows(d, tp);
  const { accesses, sessions } = stores(d, tp);
  const result: ProtectResult = { accesses: 0, accessesSkipped: 0, sessions: 0, sessionsExpired: 0 };
  if (await accesses.hasClearRows()) {
    const a = await accesses.protectClearRows();
    result.accesses = a.rows;
    result.accessesSkipped = a.skipped;
    // Recreated by `unprotect` for a rollback: no longer used once converted.
    await d.query('DROP INDEX IF EXISTS idx_access_token');
  }
  if (await sessions.hasClearRows()) {
    const s = await sessions.protectClearRows();
    result.sessions = s.rows;
    result.sessionsExpired = s.expired;
  }
  return result;
}

/** Access rows in clear listed by `status` (after a start, the rows the conversion left). */
const MAX_CLEAR_ROWS_LISTED = 100;

/** Read-only. */
async function tokensAtRestStatus (db?: PgDbLike): Promise<{ kid: string; accesses: KeyStatus; accessesInClear: Array<{ userId: string; id: string }>; sessions: KeyStatus }> {
  const d = dbOrDefault(db);
  const tp = currentProtection();
  const { accesses, sessions } = stores(d, tp);
  return {
    kid: tp.kid,
    accesses: await accesses.tokenStatus(),
    accessesInClear: await accesses.clearRowIds(MAX_CLEAR_ROWS_LISTED),
    sessions: await sessions.tokenStatus()
  };
}

/** Rollback aid (core stopped): clear tokens and ids written back, the clear-token index recreated. */
async function unprotectTokensAtRest (db?: PgDbLike): Promise<{ accesses: number; sessions: number }> {
  const d = dbOrDefault(db);
  const tp = currentProtection();
  await assertNoForeignKeyRows(d, tp);
  const { accesses, sessions } = stores(d, tp);
  const a = await accesses.unprotectRows();
  const s = await sessions.unprotectRows();
  return { accesses: a.rows, sessions: s.rows };
}

/** Re-key (core stopped) the rows protected under one of `previous`. */
async function rekeyTokensAtRest (previous: TokenProtection[], db?: PgDbLike): Promise<{ accesses: number; sessions: number; remaining: boolean }> {
  const d = dbOrDefault(db);
  const tp = currentProtection();
  const { accesses, sessions } = stores(d, tp);
  const a = await accesses.rekeyRows(previous);
  const s = await sessions.rekeyRows(previous);
  const remaining = await accesses.hasForeignKeyRows() || await sessions.hasForeignKeyRows();
  return { accesses: a.rows, sessions: s.rows, remaining };
}

export {
  currentProtection,
  probeTokensAtRest,
  protectTokensAtRest,
  tokensAtRestStatus,
  unprotectTokensAtRest,
  rekeyTokensAtRest
};
