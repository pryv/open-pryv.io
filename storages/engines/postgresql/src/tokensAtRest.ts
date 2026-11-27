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
 * rekey). The same passes seal the stored access `integrity` and the endpoint
 * of pending deletion notices, and drop the token of deleted accesses. Every
 * pass is idempotent and works with compare-and-set statements.
 */

import { getConfigSync } from '@pryv/boiler';
import type { TokenProtection } from '../../../interfaces/_shared/tokenProtection.ts';
import { foreignKeyError } from '../../../interfaces/_shared/tokenProtection.ts';
import { resolveTokenProtection } from 'business/src/accesses/tokenProtection.ts';
import { _internals } from './_internals.ts';
import { AccessesPG } from './user/AccessesPG.ts';
import { SessionsPG } from './SessionsPG.ts';
import { DeletionNoticesLocalPG } from './deletionNoticesLocal.ts';

type PgDbLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> };

/** The token and integrity passes read and write stored values only: integrity is computed on items, not here. */
const NO_INTEGRITY = { isActive: false, set: () => {}, rowFormHash: () => '' };

type ProtectResult = {
  /** Access rows converted. */
  accesses: number;
  /** Access rows left in clear (another live access holds the same token). */
  accessesSkipped: number;
  sessions: number;
  sessionsExpired: number;
  /** Access rows whose `integrity` was sealed. */
  integrity: number;
  /** Deleted access rows (and history rows of deleted accesses) whose token was dropped. */
  deletedTokens: number;
  /** Pending deletion notices whose endpoint was sealed. */
  deletionNotices: number;
};
type ProbeResult = { columnsReady: boolean; clearRows: boolean; clearIntegrityOnly?: boolean };
type KeyStatus = { clear: number; protectedCurrentKey: number; protectedOtherKeys: Record<string, number> };

/** The protection injected at storage init, else the configured one. */
function currentProtection (): TokenProtection {
  if (_internals.tokenProtection != null) return _internals.tokenProtection as TokenProtection;
  return resolveTokenProtection(getConfigSync());
}

function stores (db: PgDbLike, tp: TokenProtection): { accesses: AccessesPG; sessions: SessionsPG; notices: DeletionNoticesLocalPG } {
  return {
    accesses: new AccessesPG(db, NO_INTEGRITY, tp),
    sessions: new SessionsPG(db, {}, tp),
    notices: new DeletionNoticesLocalPG(db as unknown as ConstructorParameters<typeof DeletionNoticesLocalPG>[0], tp)
  };
}

/** Accesses with the configured integrity: dropping a token re-hashes the row. Loaded on use (it reads the configuration). */
async function accessesWithIntegrity (db: PgDbLike, tp: TokenProtection): Promise<AccessesPG> {
  const { default: integrity } = await import('business/src/integrity/index.ts');
  return new AccessesPG(db, integrity.accesses, tp);
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
  if (await accesses.hasForeignKeyIntegrityRows()) throw foreignKeyError('access integrity values');
  if (await sessions.hasForeignKeyRows()) throw foreignKeyError('sessions');
}

/**
 * Read-only: the guard, then whether rows wait for the conversion. Clear
 * `integrity` values alone (`clearIntegrityOnly`) do not break lookups: the
 * start warns about them instead of refusing.
 */
async function probeTokensAtRest (db?: PgDbLike): Promise<ProbeResult> {
  const d = dbOrDefault(db);
  if (!await columnsReady(d)) return { columnsReady: false, clearRows: true };
  const tp = currentProtection();
  await assertNoForeignKeyRows(d, tp);
  const { accesses, sessions } = stores(d, tp);
  const clearRows = await accesses.hasClearRows() || await sessions.hasClearRows();
  return { columnsReady: true, clearRows, clearIntegrityOnly: !clearRows && await accesses.hasClearIntegrityRows() };
}

/**
 * The conversion pass: refuse rows under another key, then convert what is
 * still in clear (tokens, session ids, access `integrity`, pending deletion
 * notices). The tokens of deleted accesses are dropped when `deletedTokens`
 * is set (the migration) or when access rows were converted (rows a previous
 * image wrote after a rollback, its deletions included): this image drops
 * them at deletion. `tokensOnly` (the migration `20261127_120100`, which runs
 * before `20261127_120400` creates the indexes of the rest): tokens and
 * sessions only, the rest is left to `120400`. A no-op probe in steady state.
 */
async function protectTokensAtRest (db?: PgDbLike, options: { deletedTokens?: boolean; tokensOnly?: boolean } = {}): Promise<ProtectResult> {
  const d = dbOrDefault(db);
  const tp = currentProtection();
  await assertNoForeignKeyRows(d, tp);
  const { accesses, sessions, notices } = stores(d, tp);
  const result: ProtectResult = { accesses: 0, accessesSkipped: 0, sessions: 0, sessionsExpired: 0, integrity: 0, deletedTokens: 0, deletionNotices: 0 };
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
  if (options.tokensOnly === true) return result;
  if (options.deletedTokens === true || result.accesses > 0) {
    result.deletedTokens = await (await accessesWithIntegrity(d, tp)).dropTokensOfDeletedRows();
  }
  if (await accesses.hasClearIntegrityRows()) result.integrity = (await accesses.sealClearIntegrityRows()).rows;
  result.deletionNotices = await notices.protectClearRows();
  return result;
}

/** Access rows in clear listed by `status` (after a start, the rows the conversion left). */
const MAX_CLEAR_ROWS_LISTED = 100;

/** Read-only. */
async function tokensAtRestStatus (db?: PgDbLike): Promise<Record<string, unknown>> {
  const d = dbOrDefault(db);
  const tp = currentProtection();
  const { accesses, sessions, notices } = stores(d, tp);
  const accessStatus: KeyStatus = await accesses.tokenStatus();
  return {
    kid: tp.kid,
    accesses: accessStatus,
    accessesInClear: await accesses.clearRowIds(MAX_CLEAR_ROWS_LISTED),
    accessIntegrity: await accesses.integrityStatus(),
    sessions: await sessions.tokenStatus(),
    deletionNotices: await notices.sealStatus()
  };
}

/** Rollback aid (core stopped): clear tokens, ids, integrity values and notice endpoints written back, the clear-token index recreated. */
async function unprotectTokensAtRest (db?: PgDbLike): Promise<{ accesses: number; sessions: number; integrity: number; deletionNotices: number }> {
  const d = dbOrDefault(db);
  const tp = currentProtection();
  await assertNoForeignKeyRows(d, tp);
  const { accesses, sessions, notices } = stores(d, tp);
  const a = await accesses.unprotectRows();
  const s = await sessions.unprotectRows();
  const i = await accesses.unsealIntegrityRows();
  const n = await notices.unprotectRows();
  return { accesses: a.rows, sessions: s.rows, integrity: i.rows, deletionNotices: n };
}

/** Re-key (core stopped) the rows protected under one of `previous`. */
async function rekeyTokensAtRest (previous: TokenProtection[], db?: PgDbLike): Promise<{
  accesses: number;
  sessions: number;
  integrity: number;
  deletionNotices: number;
  remaining: boolean;
  integrityUnreadable: Array<{ userId: string; id: string }>;
}> {
  const d = dbOrDefault(db);
  const tp = currentProtection();
  const { accesses, sessions, notices } = stores(d, tp);
  const a = await accesses.rekeyRows(previous);
  const s = await sessions.rekeyRows(previous);
  const i = await accesses.rekeyIntegrityRows(previous);
  const n = await notices.rekeyRows(previous);
  const remaining = await accesses.hasForeignKeyRows() || await accesses.hasForeignKeyIntegrityRows() || await sessions.hasForeignKeyRows();
  return {
    accesses: a.rows,
    sessions: s.rows,
    integrity: i.rows,
    deletionNotices: n,
    remaining,
    integrityUnreadable: i.unreadable.slice(0, MAX_CLEAR_ROWS_LISTED)
  };
}

export {
  currentProtection,
  probeTokensAtRest,
  protectTokensAtRest,
  tokensAtRestStatus,
  unprotectTokensAtRest,
  rekeyTokensAtRest
};
