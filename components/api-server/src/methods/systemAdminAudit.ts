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
 * or `setup`) and `target` (a value the act names) applied to the rows read,
 * so a page may hold fewer than `limit` rows. No aggregation across cores:
 * each core answers for its own trail. Not itself audited.
 */

export const AUDIT_READ_DEFAULT_LIMIT = 100;
export const AUDIT_READ_MAX_LIMIT = 1000;
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
      if (!Number.isInteger(skip) || skip < 0) return errors.invalidParametersFormat('`skip` must be a whole number, 0 or more.', { skip: params.skip });
      if (params.methodId != null && (typeof params.methodId !== 'string' || !METHOD_ID_RE.test(params.methodId))) {
        return errors.invalidParametersFormat('`methodId` must be a method id (letters, digits, `.`, `_`, `-`).', { methodId: params.methodId });
      }
      for (const key of ['subject', 'target']) {
        const v = params[key];
        if (v != null && (typeof v !== 'string' || v.length === 0 || v.length > FILTER_MAX)) {
          return errors.invalidParametersFormat(`\`${key}\` must be a text of 1 to ${FILTER_MAX} characters.`, { [key]: v });
        }
      }

      const storage = storages.auditStorage as { forUser: (id: string) => Promise<{ getEvents: (p: unknown) => Promise<TrailEvent[]> }>; acceptsPlatformTrail?: () => boolean } | null;
      if (config.get('audit:active') !== true || storage == null || storage.acceptsPlatformTrail?.() !== true) {
        return errors.apiUnavailable('This core keeps no platform trail: audit is off, or its audit storage does not keep the trail.');
      }
      const query = localStorePrepareQuery({
        streams: typeof params.methodId === 'string' ? [[{ any: ['action-' + params.methodId] }]] : undefined,
        fromTime,
        toTime
      });
      const options = localStorePrepareOptions({ sortAscending: false, skip, limit });
      const trail = await storage.forUser(PLATFORM_TRAIL_USER_ID);
      let events = await trail.getEvents({ query, options });
      if (typeof params.subject === 'string') events = events.filter((e) => actedBy(e, params.subject as string));
      if (typeof params.target === 'string') events = events.filter((e) => actedOn(e, params.target as string));
      result.auditEvents = events;
      result.limit = limit;
      result.skip = skip;
    })
  );
}
