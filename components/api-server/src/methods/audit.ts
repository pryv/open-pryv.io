/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Audit trail views.
 *
 * `audit.getSummary` counts the account's audit rows per hour, day or week, by
 * method class (the classes of an access's `usage`) plus an error overlay.
 *
 * Who may call it: personal accesses only (the owner's sessions and a
 * delegate's personal access), which already read the whole audit store with
 * events.get. Invariant: the summary is computed only from rows that events.get
 * would return to the same caller for the same range and access filter, so it
 * never reveals a count the caller could not obtain by listing the rows. A
 * non-personal caller must never get an unfiltered summary: it would count the
 * activity of every other access.
 */

import { createRequire } from 'node:module';
import { getConfig } from '@pryv/boiler';
import timestamp from 'unix-timestamp';
import { factory as errors, APIError, ErrorIds } from 'errors';
import type { MethodNext as Next, ResultBag } from './_types.ts';
import type { MethodContext } from 'business/src/MethodContext.ts';
import { getParamsValidation, requirePersonalAccess } from './helpers/commonFunctions.ts';
import * as methodsSchema from '../schema/auditMethods.ts';
import { MAX_BUCKETS, isValidTimeZone, buildBoundaries, foldGroups, BucketCapError } from 'business/src/audit/summaryBuckets.ts';
import { SUMMARY_BUDGET_ERROR_CODE } from 'storages/interfaces/auditStorage/UserAuditDatabase.ts';
const require = createRequire(import.meta.url);

type Api = { register: (...args: unknown[]) => void };
type SummaryParams = {
  fromTime: number;
  toTime?: number;
  bucket: 'hour' | 'day' | 'week';
  timezone?: string;
  accessIds?: string[];
};
type Group = { slot: number; action: string | null; error: boolean; count: number };
type UserAuditDb = {
  summarize (params: { fromTime: number; toTime: number; slotSeconds: number; accessStreamIds?: string[]; deadline?: number }): Promise<Group[]>;
};

/** Longest a summary may work before it is refused (no partial answer). */
const SUMMARY_BUDGET_MS = 20 * 1000;
/** Calls of one account waiting behind the one in flight (per worker). */
const SUMMARY_MAX_WAITING = 4;

/** Per-account queue: one summary in flight per account, a few waiting. */
const queues = new Map<string, { tail: Promise<unknown>; waiting: number }>();

function tooManyRequests (): Error {
  return new APIError(ErrorIds.TooManyRequests,
    'Too many audit summaries are pending for this account. Please retry later.',
    { httpStatus: 429 });
}

function summaryTooLarge (): Error {
  return errors.invalidOperation('There are too many audit records in this range to summarise in one call; ask for a shorter range.',
    { reason: 'summary-too-large' });
}

/** Runs `work` after the account's previous summaries, or refuses when too many wait. */
function enqueue<T> (userId: string, work: () => Promise<T>): Promise<T> {
  const queue = queues.get(userId) ?? { tail: Promise.resolve(), waiting: 0 };
  if (queue.waiting >= SUMMARY_MAX_WAITING + 1) return Promise.reject(tooManyRequests());
  queue.waiting++;
  queues.set(userId, queue);
  const run = queue.tail.then(work, work);
  queue.tail = run.then(() => {}, () => {}).then(() => {
    queue.waiting--;
    if (queue.waiting === 0 && queues.get(userId) === queue) queues.delete(userId);
  });
  return run;
}

const testHooks: { forceDeadlineInPast: boolean; holdBefore: Promise<unknown> | null } = { forceDeadlineInPast: false, holdBefore: null };
/** Test seams: an expired budget, and a gate held before the store is read. */
export const _testHooks = testHooks;

export default async function produceAuditApiMethods (api: Api) {
  const config = await getConfig();

  function checkAuditActive (_context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    if (config.get('audit:active') !== true) {
      return next(errors.unavailableMethod('The audit trail is disabled on this platform.'));
    }
    next();
  }

  api.register('audit.getSummary',
    checkAuditActive,
    getParamsValidation(methodsSchema.getSummary.params),
    requirePersonalAccess,
    async function getSummary (context: MethodContext, params: SummaryParams, result: ResultBag, next: Next) {
      const fromTime = params.fromTime;
      const toTime = params.toTime ?? timestamp.now();
      const timezone = params.timezone ?? 'UTC';
      if (!(toTime > fromTime)) {
        return next(errors.invalidParametersFormat('`toTime` must be later than `fromTime`.'));
      }
      if (!isValidTimeZone(timezone)) {
        return next(errors.invalidParametersFormat('Unknown `timezone`: use an IANA time zone name such as "Europe/Zurich".'));
      }
      let plan: ReturnType<typeof buildBoundaries>;
      try {
        plan = buildBoundaries({ fromTime, toTime, bucket: params.bucket, timezone });
      } catch (err) {
        if (err instanceof BucketCapError) {
          return next(errors.invalidParametersFormat('The range spans more than ' + MAX_BUCKETS + ' buckets; ask for a shorter range or a larger bucket.',
            { maxBuckets: MAX_BUCKETS }));
        }
        // The schema bounds the times; this is a second line for a range the
        // time-zone arithmetic still cannot represent.
        if (err instanceof RangeError) {
          return next(errors.invalidParametersFormat('The range cannot be divided into buckets: ' + err.message));
        }
        return next(err);
      }
      const userId = (context.user as { id: string }).id;
      const accessStreamIds = params.accessIds?.map((id) => 'access-' + id);
      try {
        const groups = await enqueue(userId, async () => {
          if (testHooks.holdBefore != null) await testHooks.holdBefore;
          const deadline = testHooks.forceDeadlineInPast ? Date.now() - 1 : Date.now() + SUMMARY_BUDGET_MS;
          const userDb: UserAuditDb = await require('storages').auditStorage.forUser(userId);
          return await userDb.summarize({ fromTime, toTime, slotSeconds: plan.slotSeconds, accessStreamIds, deadline });
        });
        result.summary = {
          bucket: params.bucket,
          timezone,
          fromTime,
          toTime,
          buckets: foldGroups(groups, { boundaries: plan.boundaries, slotSeconds: plan.slotSeconds, fromTime, toTime })
        };
        next();
      } catch (err) {
        if ((err as { code?: string })?.code === SUMMARY_BUDGET_ERROR_CODE) return next(summaryTooLarge());
        next(err);
      }
    }
  );
}
