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
 * unprotect, rekey). Sessions live in the shared database. Every pass is
 * idempotent.
 */

import type { TokenProtection } from '../../../interfaces/_shared/tokenProtection.ts';
import type { AccessesSQLite } from './user/AccessesSQLite.ts';
import type { SessionsSQLite } from './SessionsSQLite.ts';
import { foreignKeyError } from '../../../interfaces/_shared/tokenProtection.ts';
import { _internals } from './_internals.ts';
import { protectAccessTokensOnce, eachUserAccessesDb, tokenMarkerKid, writeTokenMarker, removeTokenMarker } from './user/AccessesSQLite.ts';

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

async function probeTokensAtRest (): Promise<{ columnsReady: boolean; clearRows: boolean }> {
  await usersDirectory();
  const { accesses, sessions } = layer();
  const kid = accesses.tokenProtection.kid;
  const markerKid = tokenMarkerKid();
  if (markerKid != null && markerKid !== kid) throw foreignKeyError('access rows (walk marker under key id ' + markerKid + ')');
  if (sessions.hasForeignKeyRows()) throw foreignKeyError('sessions');
  return { columnsReady: true, clearRows: markerKid == null || sessions.hasClearRows() };
}

async function protectTokensAtRest (): Promise<Record<string, number>> {
  await usersDirectory();
  const { accesses, sessions } = layer();
  if (sessions.hasForeignKeyRows()) throw foreignKeyError('sessions');
  const a = await protectAccessTokensOnce(accesses);
  const s = sessions.hasClearRows() ? await sessions.protectClearRows() : { rows: 0, expired: 0 };
  return { accesses: a?.rows ?? 0, accessesFailedUsers: a?.failedUsers ?? 0, sessions: s.rows, sessionsExpired: s.expired };
}

function addStatus (status: KeyStatus, kid: string, k: string, n: number): void {
  if (k === 'none') return; // no token at all
  if (k === 'clear') status.clear += n;
  else if (k === kid) status.protectedCurrentKey += n;
  else status.protectedOtherKeys[k] = (status.protectedOtherKeys[k] ?? 0) + n;
}

async function tokensAtRestStatus (): Promise<Record<string, unknown>> {
  await usersDirectory();
  const { accesses, sessions } = layer();
  const kid = accesses.tokenProtection.kid;
  const status: KeyStatus = { clear: 0, protectedCurrentKey: 0, protectedOtherKeys: {} };
  const failed = await eachUserAccessesDb(async (udb: UserDbHandle) => {
    for (const r of accesses.tokenStatusOfUser(udb)) addStatus(status, kid, r.k, r.n);
  });
  return { kid, marker: tokenMarkerKid(), accesses: status, accessesFailedUsers: failed.length, sessions: sessions.tokenStatus() };
}

async function unprotectTokensAtRest (): Promise<Record<string, number>> {
  await usersDirectory();
  const { accesses, sessions } = layer();
  let rows = 0;
  const failed = await eachUserAccessesDb(async (udb: UserDbHandle) => {
    if (accesses.hasForeignKeyRowsOfUser(udb)) throw foreignKeyError('access rows');
    rows += await accesses.unprotectRowsOfUser(udb);
  });
  if (failed.length > 0) throw new Error('access tokens at rest: unprotect failed for ' + failed.length + ' user database(s), see above');
  removeTokenMarker();
  if (sessions.hasForeignKeyRows()) throw foreignKeyError('sessions');
  const s = await sessions.unprotectRows();
  return { accesses: rows, sessions: s.rows };
}

async function rekeyTokensAtRest (previous: TokenProtection[]): Promise<Record<string, number | boolean>> {
  await usersDirectory();
  const { accesses, sessions } = layer();
  // A walk not completed yet stays to do (it converts the rows still in clear).
  const hadMarker = tokenMarkerKid() != null;
  let rows = 0;
  let skipped = 0;
  const failed = await eachUserAccessesDb(async (udb: UserDbHandle) => {
    const r = await accesses.rekeyRowsOfUser(udb, previous);
    rows += r.rows;
    skipped += r.skipped;
  });
  const s = await sessions.rekeyRows(previous);
  const remaining = skipped > 0 || failed.length > 0 || sessions.hasForeignKeyRows();
  if (!remaining && hadMarker) writeTokenMarker(accesses.tokenProtection.kid);
  return { accesses: rows, sessions: s.rows, remaining };
}

export {
  probeTokensAtRest,
  protectTokensAtRest,
  tokensAtRestStatus,
  unprotectTokensAtRest,
  rekeyTokensAtRest
};
