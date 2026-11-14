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
import { SUMMARY_BUDGET_ERROR_CODE, SUMMARY_INTERRUPTED_ERROR_CODE, summaryInterruptedError } from 'storages/interfaces/auditStorage/UserAuditDatabase.ts';
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

/** Longest a summary may work before it is refused (no partial answer); starts when the read starts. */
const SUMMARY_BUDGET_MS = 20 * 1000;
/** Calls of one account waiting behind the one in flight (per worker). */
const SUMMARY_MAX_WAITING = 4;
/** Summaries reading a store at once, all accounts together (per worker). */
const SUMMARY_MAX_RUNNING = 2;
/** Calls waiting for one of those slots (per worker); the next is refused at once. */
const SUMMARY_MAX_QUEUED = 8;
/** A call whose turn comes later than this after its arrival is refused without reading. */
const SUMMARY_MAX_WAIT_MS = 10 * 1000;

/** Per-account queue: one summary in flight per account, a few waiting. */
const queues = new Map<string, { tail: Promise<unknown>; waiting: number }>();

/** Worker-wide slots: how many summaries read now, and the calls waiting for a slot (first in, first out). */
const slots = { running: 0, waiting: [] as Array<() => void> };

function tooManyRequests (message = 'Too many audit summaries are pending for this account. Please retry later.'): Error {
  return new APIError(ErrorIds.TooManyRequests, message, { httpStatus: 429 });
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

/**
 * Runs `work` in one of the worker's summary slots, waiting for one in arrival
 * order. Refused at once when too many wait, and without reading when the
 * turn comes more than the wait limit after `arrived`. The slot is released
 * whatever the outcome.
 */
async function withSlot<T> (arrived: number, work: () => Promise<T>): Promise<T> {
  if (slots.running >= SUMMARY_MAX_RUNNING) {
    if (slots.waiting.length >= SUMMARY_MAX_QUEUED) throw tooManyRequests('Too many audit summaries are pending. Please retry later.');
    await new Promise<void>((resolve) => { slots.waiting.push(resolve); });
  } else {
    slots.running++;
  }
  // The slot is ours here: either taken above or handed over by `release`.
  try {
    if (Date.now() - arrived > testHooks.maxWaitMs) throw tooManyRequests('The audit summary waited too long for its turn. Please retry later.');
    return await work();
  } finally {
    const next = slots.waiting.shift();
    if (next != null) next();
    else slots.running--;
  }
}

const testHooks: {
  forceDeadlineInPast: boolean;
  holdBefore: ((userId: string) => Promise<unknown> | null | undefined) | null;
  interruptions: number;
  maxWaitMs: number;
  storeReads: number;
} = { forceDeadlineInPast: false, holdBefore: null, interruptions: 0, maxWaitMs: SUMMARY_MAX_WAIT_MS, storeReads: 0 };
/**
 * Test seams: an expired budget, a gate held (per account) once the worker
 * slot is taken and before the store is read, a number of coming store reads
 * replaced by the interruption error, the wait limit, and a count of store
 * reads started.
 */
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
      const arrived = Date.now();
      try {
        const groups = await enqueue(userId, () => withSlot(arrived, async () => {
          const hold = testHooks.holdBefore?.(userId);
          if (hold != null) await hold;
          const deadline = testHooks.forceDeadlineInPast ? Date.now() - 1 : Date.now() + SUMMARY_BUDGET_MS;
          const read = async (): Promise<Group[]> => {
            testHooks.storeReads++;
            // Resolved on every attempt: a store closed meanwhile is opened again.
            const userDb: UserAuditDb = await require('storages').auditStorage.forUser(userId);
            if (testHooks.interruptions > 0) {
              testHooks.interruptions--;
              throw summaryInterruptedError();
            }
            return await userDb.summarize({ fromTime, toTime, slotSeconds: plan.slotSeconds, accessStreamIds, deadline });
          };
          try {
            return await read();
          } catch (err) {
            if ((err as { code?: string })?.code !== SUMMARY_INTERRUPTED_ERROR_CODE) throw err;
            // Once more, under the same deadline; a second interruption is refused.
            try {
              return await read();
            } catch (again) {
              if ((again as { code?: string })?.code === SUMMARY_INTERRUPTED_ERROR_CODE) {
                throw tooManyRequests('The audit summary was interrupted. Please retry.');
              }
              throw again;
            }
          }
        }));
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
