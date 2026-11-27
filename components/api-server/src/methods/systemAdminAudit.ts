/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { ResultBag } from './_types.ts';
import { ready } from '@pryv/boiler';
import { factory as errors } from 'errors';
import * as storages from 'storages';
import { localStorePrepareOptions, localStorePrepareQuery } from 'storage/src/localStoreEventQueries.ts';
import { PLATFORM_TRAIL_USER_ID } from 'storages/interfaces/auditStorage/AuditStorage.ts';
import { wrap } from './helpers/adminAudit.ts';

/**
 * Methods of the administration audit trail (routes in routes/system-admin-audit.ts, method ids declared in
 * audit/src/apiMethods/adminAudit.ts). Audit steps: methods/helpers/adminAudit.ts.
 *
 * `system.audit.get`: the platform trail of this core, the stored records of
 * the audited calls without an account of this core (administration acts),
 * most recent first. Filters: `fromTime` / `toTime` (seconds), `methodId`
 * (read by the storage), `subject` (an administrator's user id, `admin-key`
 * or `setup`) and `target` (a value the act names) applied before the page is
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
const PARAMS = new Set(['fromTime', 'toTime', 'methodId', 'subject', 'target', 'limit', 'skip']);
const METHOD_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const FILTER_MAX = 256;

type TrailEvent = { content?: { record?: { subject?: { userId?: unknown; via?: unknown }; target?: unknown } } };

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
  return (subject === 'admin-key' || subject === 'setup') && s.via === subject;
}

/** Whether the record names `target` as (one of the values of) the object of the act. */
function actedOn (event: TrailEvent, target: string): boolean {
  const t = event.content?.record?.target;
  if (t == null || typeof t !== 'object') return t === target;
  return Object.values(t as Record<string, unknown>).some((v) => v === target);
}

type TrailStorage = { forUser: (id: string) => Promise<{ getEvents: (p: unknown) => Promise<TrailEvent[]> }>; acceptsPlatformTrail?: () => boolean };
export type TrailQuery = { fromTime?: number | null; toTime?: number | null; methodId?: string; subject?: string; target?: string; limit: number; skip: number };

/** Whether this audit storage keeps the platform trail. */
export function keepsPlatformTrail (storage: unknown): storage is TrailStorage {
  return storage != null && (storage as TrailStorage).acceptsPlatformTrail?.() === true;
}

export type TrailPage = { events: TrailEvent[]; hasMore: boolean; scanLimitReached?: true };

/**
 * The records of the platform trail, most recent first (validated query):
 * what `system.audit.get` answers, also read by `bin/admin.js audit tail`.
 * `skip` and `limit` count matching records: with a `subject` or `target`
 * filter the trail is read in batches and filtered before the page is cut,
 * over at most AUDIT_READ_SCAN_MAX records (`scanLimitReached` then; narrow the
 * time range, e.g. `toTime` = the time of the last record answered).
 * `hasMore`: matching records may follow this page.
 */
export async function readPlatformTrail (storage: TrailStorage, q: TrailQuery): Promise<TrailPage> {
  const query = localStorePrepareQuery({
    streams: q.methodId != null ? [[{ any: ['action-' + q.methodId] }]] : undefined,
    fromTime: q.fromTime ?? null,
    toTime: q.toTime ?? null
  });
  const trail = await storage.forUser(PLATFORM_TRAIL_USER_ID);
  const read = async (skip: number, limit: number) => await trail.getEvents({ query, options: localStorePrepareOptions({ sortAscending: false, skip, limit }) });
  const matches = (e: TrailEvent) => (q.subject == null || actedBy(e, q.subject)) && (q.target == null || actedOn(e, q.target));
  if (q.subject == null && q.target == null) {
    const rows = await read(q.skip, q.limit + 1);
    return { events: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
  }
  const wanted = q.skip + q.limit + 1;
  const found: TrailEvent[] = [];
  let scanned = 0;
  let ended = false;
  while (found.length < wanted && scanned < AUDIT_READ_SCAN_MAX) {
    const size = Math.min(AUDIT_READ_SCAN_BATCH, AUDIT_READ_SCAN_MAX - scanned);
    const batch = await read(scanned, size);
    scanned += batch.length;
    for (const e of batch) if (matches(e)) found.push(e);
    if (batch.length < size) { ended = true; break; } // the end of the trail
  }
  const page = found.slice(q.skip, q.skip + q.limit);
  const cut = !ended && found.length < wanted;
  return cut ? { events: page, hasMore: true, scanLimitReached: true } : { events: page, hasMore: found.length > q.skip + q.limit };
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

      const storage = storages.auditStorage;
      if (config.get('audit:active') !== true || !keepsPlatformTrail(storage)) {
        return errors.apiUnavailable('This core keeps no platform trail: audit is off, or its audit storage does not keep the trail.');
      }
      const page = await readPlatformTrail(storage, {
        fromTime,
        toTime,
        methodId: typeof params.methodId === 'string' ? params.methodId : undefined,
        subject: typeof params.subject === 'string' ? params.subject : undefined,
        target: typeof params.target === 'string' ? params.target : undefined,
        limit,
        skip
      });
      result.auditEvents = page.events;
      result.limit = limit;
      result.skip = skip;
      result.hasMore = page.hasMore;
      if (page.scanLimitReached === true) result.scanLimitReached = true;
    })
  );
}
