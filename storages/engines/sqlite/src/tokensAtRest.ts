/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Access tokens and session ids at rest, SQLite: the start-up walk over the
 * user databases (marker file with the key id), the guard against rows under
 * another key, and the operator passes of `bin/access-tokens.js` (status,
 * unprotect, rekey). Sessions live in the shared database. The same passes
 * seal the stored access `integrity` and the endpoint of pending deletion
 * notices, and the walk drops the token of deleted accesses. Every pass is
 * idempotent.
 */

import type { TokenProtection } from '../../../interfaces/_shared/tokenProtection.ts';
import type { AccessesSQLite } from './user/AccessesSQLite.ts';
import type { SessionsSQLite } from './SessionsSQLite.ts';
import { foreignKeyError } from '../../../interfaces/_shared/tokenProtection.ts';
import { _internals } from './_internals.ts';
import {
  protectAccessTokensOnce, eachUserAccessesDb, tokenMarkerKid, tokenMarkerVersion, writeTokenMarker, removeTokenMarker,
  tokensUnprotected, writeUnprotectedMarker, removeUnprotectedMarker
} from './user/AccessesSQLite.ts';
import { DeletionNoticesLocalSQLite } from './deletionNoticesLocal.ts';
import { scrubAccessAuditIntegrityOnce } from './auditAccessIntegrityScrub.ts';

type IntegrityStatus = { clear: number; sealedCurrentKey: number; sealedOtherKeys: Record<string, number> };

let noticesInstance: Promise<DeletionNoticesLocalSQLite> | null = null;

/** The core's deletion notices (file next to the users index), for the passes: one connection per process. */
async function notices (tp: TokenProtection): Promise<DeletionNoticesLocalSQLite> {
  if (noticesInstance == null) {
    const n = new DeletionNoticesLocalSQLite(tp);
    noticesInstance = n.init().then(() => n);
    noticesInstance.catch(() => { noticesInstance = null; });
  }
  const n = await noticesInstance;
  n.tokenProtection = tp;
  return n;
}

type KeyStatus = { clear: number; protectedCurrentKey: number; protectedOtherKeys: Record<string, number> };
type Layer = { accesses: AccessesSQLite; sessions: SessionsSQLite };
type UserDbHandle = Parameters<AccessesSQLite['protectClearRowsOfUser']>[0];

function layer (): Layer {
  const sl = _internals.storageLayer as Partial<Layer> | undefined;
  if (sl?.accesses == null || sl?.sessions == null) throw new Error('access tokens at rest: SQLite storage layer not initialised');
  return sl as Layer;
}

async function usersDirectory (): Promise<void> {
  // Not initialised in the supervisor process; idempotent.
  await (_internals.userLocalDirectory as { init: () => Promise<void> }).init();
}

/**
 * Read-only: the guard, then whether rows wait for a conversion the serving
 * path will not run by itself. Rows in clear are otherwise converted at
 * storage init (sessions) and at the first use of a user database
 * (accesses); not while the `unprotect` marker is there.
 */
async function probeTokensAtRest (): Promise<{ columnsReady: boolean; clearRows: boolean }> {
  await usersDirectory();
  const { accesses, sessions } = layer();
  const kid = accesses.tokenProtection.kid;
  const markerKid = tokenMarkerKid();
  if (markerKid != null && markerKid !== kid) throw foreignKeyError('access rows (walk marker under key id ' + markerKid + ')');
  if (sessions.hasForeignKeyRows()) throw foreignKeyError('sessions');
  return { columnsReady: true, clearRows: tokensUnprotected() };
}

/**
 * The conversion pass of the start (and of `bin/migrate.js up`): ends the
 * rollback state of `unprotect` (its marker), then converts.
 */
async function protectTokensAtRest (): Promise<Record<string, number>> {
  await usersDirectory();
  const { accesses, sessions } = layer();
  if (sessions.hasForeignKeyRows()) throw foreignKeyError('sessions');
  removeUnprotectedMarker();
  const a = await protectAccessTokensOnce(accesses);
  const s = sessions.hasClearRows() ? await sessions.protectClearRows() : { rows: 0, expired: 0 };
  const n = await (await notices(accesses.tokenProtection)).protectClearRows();
  const audit = await scrubAccessAuditIntegrityOnce();
  return {
    accesses: a?.rows ?? 0,
    accessesFailedUsers: a?.failedUsers ?? 0,
    deletedTokens: a?.deletedTokens ?? 0,
    sessions: s.rows,
    sessionsExpired: s.expired,
    deletionNotices: n,
    auditRecords: audit?.records ?? 0
  };
}

function addStatus (status: KeyStatus, kid: string, k: string, n: number): void {
  if (k === 'none') return; // no token at all
  if (k === 'clear') status.clear += n;
  else if (k === kid) status.protectedCurrentKey += n;
  else status.protectedOtherKeys[k] = (status.protectedOtherKeys[k] ?? 0) + n;
}

function addIntegrityStatus (status: IntegrityStatus, kid: string, k: string, n: number): void {
  if (k === 'none') return;
  if (k === 'clear') status.clear += n;
  else if (k === kid) status.sealedCurrentKey += n;
  else status.sealedOtherKeys[k] = (status.sealedOtherKeys[k] ?? 0) + n;
}

/** Read-only (the walk visits the databases without their first-use conversion). */
async function tokensAtRestStatus (): Promise<Record<string, unknown>> {
  await usersDirectory();
  const { accesses, sessions } = layer();
  const kid = accesses.tokenProtection.kid;
  const status: KeyStatus = { clear: 0, protectedCurrentKey: 0, protectedOtherKeys: {} };
  const integrity: IntegrityStatus = { clear: 0, sealedCurrentKey: 0, sealedOtherKeys: {} };
  const failed = await eachUserAccessesDb(async (udb: UserDbHandle) => {
    for (const r of accesses.tokenStatusOfUser(udb)) addStatus(status, kid, r.k, r.n);
    for (const r of accesses.integrityStatusOfUser(udb)) addIntegrityStatus(integrity, kid, r.k, r.n);
  });
  return {
    kid,
    marker: tokenMarkerKid(),
    markerWalk: tokenMarkerVersion(),
    unprotected: tokensUnprotected(),
    accesses: status,
    accessIntegrity: integrity,
    accessesFailedUsers: failed.length,
    sessions: sessions.tokenStatus(),
    deletionNotices: await (await notices(accesses.tokenProtection)).sealStatus()
  };
}

/**
 * Rollback aid (core stopped). The marker is written first: from then on no
 * process converts rows again (tools, first uses), until a start of this
 * image (`protectTokensAtRest`) removes it.
 */
async function unprotectTokensAtRest (): Promise<Record<string, number>> {
  await usersDirectory();
  const { accesses, sessions } = layer();
  writeUnprotectedMarker();
  let rows = 0;
  const failed = await eachUserAccessesDb(async (udb: UserDbHandle) => {
    if (accesses.hasForeignKeyRowsOfUser(udb)) throw foreignKeyError('access rows');
    rows += await accesses.unprotectRowsOfUser(udb);
  });
  if (failed.length > 0) throw new Error('access tokens at rest: unprotect failed for ' + failed.length + ' user database(s), see above');
  removeTokenMarker();
  if (sessions.hasForeignKeyRows()) throw foreignKeyError('sessions');
  const s = await sessions.unprotectRows();
  const n = await (await notices(accesses.tokenProtection)).unprotectRows();
  return { accesses: rows, sessions: s.rows, deletionNotices: n };
}

async function rekeyTokensAtRest (previous: TokenProtection[]): Promise<Record<string, number | boolean>> {
  await usersDirectory();
  const { accesses, sessions } = layer();
  // A walk not completed yet stays to do (it converts the rows still in
  // clear), and so does a walk of an earlier version: the marker keeps it.
  const hadMarker = tokenMarkerKid() != null;
  const walkVersion = tokenMarkerVersion();
  let rows = 0;
  let skipped = 0;
  const failed = await eachUserAccessesDb(async (udb: UserDbHandle) => {
    const r = await accesses.rekeyRowsOfUser(udb, previous);
    rows += r.rows;
    skipped += r.skipped;
  });
  const s = await sessions.rekeyRows(previous);
  const n = await (await notices(accesses.tokenProtection)).rekeyRows(previous);
  const remaining = skipped > 0 || failed.length > 0 || sessions.hasForeignKeyRows();
  if (!remaining && hadMarker) writeTokenMarker(accesses.tokenProtection.kid, walkVersion);
  return { accesses: rows, sessions: s.rows, deletionNotices: n, remaining };
}

export {
  probeTokensAtRest,
  protectTokensAtRest,
  tokensAtRestStatus,
  unprotectTokensAtRest,
  rekeyTokensAtRest
};
