/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import type { ResultBag } from './_types.ts';
import { ready } from '@pryv/boiler';
import { factory as errors } from 'errors';
import * as storages from 'storages';
import { localStorePrepareOptions, localStorePrepareQuery } from 'storage/src/localStoreEventQueries.ts';
import { PLATFORM_TRAIL_USER_ID } from 'storages/interfaces/auditStorage/AuditStorage.ts';
import { accountNameHash } from 'business/src/admin/accountNames.ts';
import { wrap } from './helpers/adminAudit.ts';

/**
 * Methods of the administration audit trail (routes in routes/system-admin-audit.ts, method ids declared in
 * audit/src/apiMethods/adminAudit.ts). Audit steps: methods/helpers/adminAudit.ts.
 *
 * `system.audit.get`: the platform trail of this core, the stored records of
 * the audited calls without an account of this core (administration acts),
 * most recent first. Filters: `fromTime` / `toTime` (seconds), `methodId`
 * (read by the storage), `subject` (an administrator's user id, `admin-key`,
 * `setup` or `cli`), `target` (a value the act names) and `targetUsername`
 * (an account name, matched by its keyed hash, never echoed) applied before the page is
 * cut (`readPlatformTrail`); `hasMore` says whether matching records may
 * follow; `skip` is bounded (a deeper read narrows `toTime`). No aggregation across cores:
 * each core answers for its own trail. Not itself audited.
 */

export const AUDIT_READ_DEFAULT_LIMIT = 100;
export const AUDIT_READ_MAX_LIMIT = 1000;
/** `skip` at most (a deeper page is reached by narrowing the time range: `toTime`). */
export const AUDIT_READ_MAX_SKIP = 10000;
/** Records read at most to answer one filtered page, and per storage read. */
export const AUDIT_READ_SCAN_MAX = 20000;
const AUDIT_READ_SCAN_BATCH = 1000;
const PARAMS = new Set(['fromTime', 'toTime', 'methodId', 'subject', 'target', 'targetUsername', 'limit', 'skip']);
const METHOD_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const FILTER_MAX = 256;

type TrailEvent = { id?: string; time?: number; content?: { record?: { subject?: { userId?: unknown; via?: unknown }; target?: unknown } } };

function numberParam (value: unknown): number | null {
  if (value == null) return null;
  const n = value === '' ? NaN : Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/** Whether the record names `subject` as who acted. */
function actedBy (event: TrailEvent, subject: string): boolean {
  const s = event.content?.record?.subject;
  if (s == null) return false;
  if (s.userId === subject) return true;
  return (subject === 'admin-key' || subject === 'setup' || subject === 'cli') && s.via === subject;
}

/** Whether the record names `target` as (one of the values of) the object of the act. */
function actedOn (event: TrailEvent, target: string): boolean {
  const t = event.content?.record?.target;
  if (t == null || typeof t !== 'object') return t === target;
  return Object.values(t as Record<string, unknown>).some((v) => v === target);
}

/** Whether the record names, as the object of the act, the account whose name has the keyed hash `nameHash`. */
function actedOnName (event: TrailEvent, nameHash: string): boolean {
  const t = event.content?.record?.target as Record<string, unknown> | undefined;
  if (t == null || typeof t !== 'object') return false;
  return t.usernameHash === nameHash || t.delegateUsernameHash === nameHash;
}

type TrailStorage = { forUser: (id: string) => Promise<{ getEvents: (p: unknown) => Promise<TrailEvent[]> }>; acceptsPlatformTrail?: () => boolean };
/**
 * `targetUsername`: the records whose target names this username, matched by
 * its keyed hash (the trail never holds the name); the caller checks that a
 * key is available (`accountNameHash`).
 */
export type TrailQuery = { fromTime?: number | null; toTime?: number | null; methodId?: string; subject?: string; target?: string; targetUsername?: string; limit: number; skip: number };

/** Whether this audit storage keeps the platform trail. */
export function keepsPlatformTrail (storage: unknown): storage is TrailStorage {
  return storage != null && (storage as TrailStorage).acceptsPlatformTrail?.() === true;
}

/**
 * For a tool that reads the trail from a shell (bin/admin.js,
 * bin/breach-scope.js): whether opening it from this process could leave a
 * file the server cannot write. With a storage of one file per account
 * (SQLite): `absent` when the trail was never written on this core (opening
 * it would create it, owned by the shell's user; `creatable` when the closest
 * existing directory above it belongs to this user), `otherOwner` when its
 * file belongs to another OS user (its journal files would not). Null when
 * the trail can be opened (and always for a database server).
 */
export function trailFileProblem (storage: unknown): { absent: true; creatable: boolean } | { otherOwner: number; path: string } | null {
  const pathOf = (storage as { existingPathForUser?: (id: string) => string }).existingPathForUser;
  if (typeof pathOf !== 'function') return null;
  const file = pathOf.call(storage, PLATFORM_TRAIL_USER_ID);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const ownerOf = (p: string): number | null => {
    try { return nodeFs.statSync(p).uid; } catch { return null; }
  };
  const owner = ownerOf(file);
  if (owner != null) return uid != null && uid !== owner ? { otherOwner: owner, path: file } : null;
  let dir = nodePath.dirname(file);
  let dirOwner = ownerOf(dir);
  while (dirOwner == null && nodePath.dirname(dir) !== dir) {
    dir = nodePath.dirname(dir);
    dirOwner = ownerOf(dir);
  }
  return { absent: true, creatable: uid == null || dirOwner === uid };
}

export type TrailPage = { events: TrailEvent[]; hasMore: boolean; scanLimitReached?: true; scannedToTime?: number };

/**
 * The records of the platform trail, most recent first (validated query):
 * what `system.audit.get` answers, also read by `bin/admin.js audit tail`.
 * `skip` and `limit` count matching records: with a `subject`, `target` or
 * `targetUsername` filter the trail is read in batches and filtered before the page is cut,
 * over at most AUDIT_READ_SCAN_MAX records. When that limit stops the scan
 * before the page is full: `scanLimitReached` and `scannedToTime`, the time of
 * the last record scanned; the next read continues with `toTime` =
 * `scannedToTime` and `skip: 0`. `toTime` is inclusive: records sharing that
 * time come again, the client drops by `id` those it already has.
 * `hasMore`: matching records may follow this page.
 */
export async function readPlatformTrail (storage: TrailStorage, q: TrailQuery): Promise<TrailPage> {
  const query = localStorePrepareQuery({
    streams: q.methodId != null ? [[{ any: ['action-' + q.methodId] }]] : undefined,
    fromTime: q.fromTime ?? null,
    toTime: q.toTime ?? null
  });
  const nameHash = q.targetUsername == null ? null : accountNameHash(q.targetUsername)?.hash;
  if (nameHash === undefined) throw new Error('no key to hash account names on this core');
  const trail = await storage.forUser(PLATFORM_TRAIL_USER_ID);
  const read = async (skip: number, limit: number) => await trail.getEvents({ query, options: localStorePrepareOptions({ sortAscending: false, skip, limit }) });
  const matches = (e: TrailEvent) => (q.subject == null || actedBy(e, q.subject)) && (q.target == null || actedOn(e, q.target)) &&
    (nameHash == null || actedOnName(e, nameHash));
  if (q.subject == null && q.target == null && nameHash == null) {
    const rows = await read(q.skip, q.limit + 1);
    return { events: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
  }
  const wanted = q.skip + q.limit + 1;
  const found: TrailEvent[] = [];
  // A record written between two batches shifts the rest down: the next
  // batch reads one record again (never skips one). Kept once.
  const seen = new Set<string>();
  let scanned = 0;
  let ended = false;
  let lastTime: number | undefined;
  while (found.length < wanted && scanned < AUDIT_READ_SCAN_MAX) {
    const size = Math.min(AUDIT_READ_SCAN_BATCH, AUDIT_READ_SCAN_MAX - scanned);
    const batch = await read(scanned, size);
    scanned += batch.length;
    for (const e of batch) {
      if (typeof e.id === 'string') {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
      }
      if (matches(e)) found.push(e);
    }
    if (batch.length > 0 && typeof batch[batch.length - 1].time === 'number') lastTime = batch[batch.length - 1].time;
    if (batch.length < size) { ended = true; break; } // the end of the trail
  }
  const page = found.slice(q.skip, q.skip + q.limit);
  const cut = !ended && found.length < wanted;
  if (!cut) return { events: page, hasMore: found.length > q.skip + q.limit };
  return lastTime != null
    ? { events: page, hasMore: true, scanLimitReached: true, scannedToTime: lastTime }
    : { events: page, hasMore: true, scanLimitReached: true };
}

export default async function (systemAPI: { register: (...args: unknown[]) => void }): Promise<void> {
  const config = await ready();

  systemAPI.register('system.audit.get',
    wrap(async function getPlatformTrail (_context: unknown, params: Record<string, unknown>, result: ResultBag) {
      const unknownParams = Object.keys(params).filter((k) => !PARAMS.has(k));
      if (unknownParams.length > 0) return errors.invalidParametersFormat('Unknown parameter(s): ' + unknownParams.join(', ') + '.', { parameters: unknownParams });
      const fromTime = numberParam(params.fromTime);
      const toTime = numberParam(params.toTime);
      if (Number.isNaN(fromTime) || Number.isNaN(toTime)) return errors.invalidParametersFormat('`fromTime` and `toTime` must be times in seconds since the epoch.', { fromTime: params.fromTime, toTime: params.toTime });
      const limit = params.limit == null ? AUDIT_READ_DEFAULT_LIMIT : numberParam(params.limit)!;
      if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_READ_MAX_LIMIT) return errors.invalidParametersFormat(`\`limit\` must be a whole number from 1 to ${AUDIT_READ_MAX_LIMIT}.`, { limit: params.limit });
      const skip = params.skip == null ? 0 : numberParam(params.skip)!;
      if (!Number.isInteger(skip) || skip < 0 || skip > AUDIT_READ_MAX_SKIP) {
        return errors.invalidParametersFormat(`\`skip\` must be a whole number from 0 to ${AUDIT_READ_MAX_SKIP} (narrow the time range with \`toTime\` to read further).`, { skip: params.skip });
      }
      if (params.methodId != null && (typeof params.methodId !== 'string' || !METHOD_ID_RE.test(params.methodId))) {
        return errors.invalidParametersFormat('`methodId` must be a method id (letters, digits, `.`, `_`, `-`).', { methodId: params.methodId });
      }
      for (const key of ['subject', 'target']) {
        const v = params[key];
        if (v != null && (typeof v !== 'string' || v.length === 0 || v.length > FILTER_MAX)) {
          return errors.invalidParametersFormat(`\`${key}\` must be a text of 1 to ${FILTER_MAX} characters.`, { [key]: v });
        }
      }
      // A username is never echoed: neither its value in an error nor in the answer.
      const targetUsername = params.targetUsername;
      if (targetUsername != null && (typeof targetUsername !== 'string' || targetUsername.length === 0 || targetUsername.length > FILTER_MAX)) {
        return errors.invalidParametersFormat(`\`targetUsername\` must be a text of 1 to ${FILTER_MAX} characters.`);
      }

      const storage = storages.auditStorage;
      if (config.get('audit:active') !== true || !keepsPlatformTrail(storage)) {
        return errors.apiUnavailable('This core keeps no platform trail: audit is off, or its audit storage does not keep the trail.');
      }
      if (typeof targetUsername === 'string' && accountNameHash(targetUsername, config) == null) {
        return errors.apiUnavailable('This core has no key to hash account names (accountErasure.ledger.hmacKey or auth.adminAccessKey): the trail cannot be searched by username.');
      }
      const page = await readPlatformTrail(storage, {
        fromTime,
        toTime,
        methodId: typeof params.methodId === 'string' ? params.methodId : undefined,
        subject: typeof params.subject === 'string' ? params.subject : undefined,
        target: typeof params.target === 'string' ? params.target : undefined,
        targetUsername: typeof targetUsername === 'string' ? targetUsername : undefined,
        limit,
        skip
      });
      result.auditEvents = page.events;
      result.limit = limit;
      result.skip = skip;
      result.hasMore = page.hasMore;
      if (page.scanLimitReached === true) {
        result.scanLimitReached = true;
        if (page.scannedToTime != null) result.scannedToTime = page.scannedToTime;
      }
    })
  );
}
