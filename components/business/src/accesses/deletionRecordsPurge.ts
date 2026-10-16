/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Purge of access deletion records older than a retention (opt-in).
 *
 * A deleted access stays as a deletion record (readable with
 * `accesses.get { includeDeletions }`), with the version rows of its earlier
 * states and its access-index row. With `accesses.deletionRecords.retentionDays`
 * set above 0, the master removes, once a day, every deletion record deleted
 * more than that many days ago, together with its version rows and its index
 * row. Off by default (0): an audit page or an event's author names a removed
 * access through its deletion record, and a breach is scoped through its index
 * row; past the retention both resolve to a bare id.
 *
 * The index row goes first: when it cannot be removed, the access is left for
 * the next pass, so no index row is ever left pointing at a purged access.
 */

import type { Callback } from '../../../../storages/interfaces/_shared/types.ts';

type UserRef = { id: string; username: string };
type AccessRow = { id?: string; deleted?: number | null };

export type AccessesRepo = {
  findIncludingDeletionsAndVersions (user: UserRef, query: Record<string, unknown>, options: Record<string, unknown>, callback: Callback<Array<AccessRow | null>>): void;
  removeMany (user: UserRef, query: Record<string, unknown>, callback: Callback<number>): void;
};

export type PurgeDeps = {
  accesses: AccessesRepo;
  listUsers: () => Promise<UserRef[]>;
  // removes the access-index row of a base access id (absent: no index)
  deleteIndexRow?: (accessId: string) => Promise<void>;
  retentionDays: number;
  // pryv seconds, the unit of `deleted`
  now?: () => number;
  logger?: { warn: (msg: string) => void };
};

export type PurgeResult = {
  users: number; // accounts that had a record to purge
  records: number; // deletion records removed
  versions: number; // their version rows removed
  failed: number; // records left for the next pass
};

const DAY_SECONDS = 24 * 3600;
const CHUNK = 200;
const PURGE_INTERVAL_MS = 24 * 3600 * 1000;
const FIRST_PASS_DELAY_MS = 10 * 60 * 1000;

function call<T> (fn: (cb: Callback<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, res) => (err != null ? reject(err) : resolve(res as T))));
}

export async function purgeAccessDeletionRecords (deps: PurgeDeps): Promise<PurgeResult> {
  if (!(deps.retentionDays > 0)) throw new Error('purgeAccessDeletionRecords: retentionDays must be above 0');
  const now = deps.now ?? (() => Date.now() / 1000);
  const cutoff = now() - deps.retentionDays * DAY_SECONDS;
  const result: PurgeResult = { users: 0, records: 0, versions: 0, failed: 0 };

  for (const user of await deps.listUsers()) {
    let ids: string[];
    try {
      const rows = await call<Array<AccessRow | null>>((cb) => deps.accesses.findIncludingDeletionsAndVersions(user, { deleted: { $lt: cutoff }, headId: null }, {}, cb));
      ids = rows.map((r) => r?.id).filter((id): id is string => typeof id === 'string');
    } catch (err) {
      deps.logger?.warn(`[access-deletions-purge] could not read the deletion records of an account: ${(err as Error).message}`);
      continue;
    }
    if (ids.length === 0) continue;
    result.users++;

    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const ready: string[] = [];
      for (const id of chunk) {
        try {
          if (deps.deleteIndexRow != null) await deps.deleteIndexRow(id);
          ready.push(id);
        } catch (err) {
          result.failed++;
          deps.logger?.warn(`[access-deletions-purge] index row not removed, access kept for the next pass: ${(err as Error).message}`);
        }
      }
      if (ready.length === 0) continue;
      try {
        result.versions += await call<number>((cb) => deps.accesses.removeMany(user, { headId: { $in: ready } }, cb));
        // `deleted` again: a record is never removed unless it is still past the cutoff
        result.records += await call<number>((cb) => deps.accesses.removeMany(user, { id: { $in: ready }, deleted: { $lt: cutoff } }, cb));
      } catch (err) {
        result.failed += ready.length;
        deps.logger?.warn(`[access-deletions-purge] could not remove deletion records of an account: ${(err as Error).message}`);
      }
    }
  }
  return result;
}

/**
 * Read `accesses:deletionRecords:retentionDays`: 0 (or absent) = never purge.
 * Returns null when off; throws on a value that is not a number of days >= 0.
 */
export function readRetentionDays (config: { get: (key: string) => unknown }): number | null {
  const raw = config.get('accesses:deletionRecords:retentionDays');
  if (raw == null || raw === 0) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    // bootFatal: the master prints it as a one-line FATAL and stops
    throw Object.assign(new Error('accesses.deletionRecords.retentionDays must be a number of days (0 = never purge), got ' + JSON.stringify(raw)), { bootFatal: true });
  }
  return raw;
}

/**
 * The master's daily pass: first run 10 minutes after boot, then every 24 h.
 * Returns null when the retention is off.
 */
export function startAccessDeletionRecordsPurge (deps: Omit<PurgeDeps, 'retentionDays'> & {
  config: { get: (key: string) => unknown };
  log: (msg: string) => void;
}): { stop: () => void } | null {
  const retentionDays = readRetentionDays(deps.config);
  if (retentionDays == null) return null;
  const run = (): void => {
    purgeAccessDeletionRecords({ ...deps, retentionDays })
      .then((r) => {
        if (r.records > 0 || r.failed > 0) deps.log(`[access-deletions-purge] removed ${r.records} deletion record(s) older than ${retentionDays} day(s) (${r.versions} version row(s), ${r.users} account(s), ${r.failed} left for the next pass)`);
      })
      .catch((err: Error) => deps.log(`[access-deletions-purge] failed: ${err.message}`));
  };
  const first = setTimeout(run, FIRST_PASS_DELAY_MS);
  const every = setInterval(run, PURGE_INTERVAL_MS);
  first.unref();
  every.unref();
  deps.log(`[access-deletions-purge] access deletion records are purged ${retentionDays} day(s) after deletion`);
  return { stop: () => { clearTimeout(first); clearInterval(every); } };
}
