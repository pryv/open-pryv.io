/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { fromCallback } from 'utils';
import { factory as errors } from 'errors';
import { delayForFailures } from 'business/src/mfa/index.ts';
import type { BackoffCfg } from 'business/src/mfa/index.ts';

/**
 * Per-account attempt backoff, stored on the account.
 *
 * A failure tally accrues on the USER, across requests and sessions. Past
 * `backoff.freeFailures` failures each further one imposes a delay before the
 * next attempt (doubling, capped). Every attempt is counted BEFORE its secret
 * is checked (and the count cleared on success), so attempts sent in parallel
 * cannot all pass the check. It is a delay, never a lockout: whoever holds no
 * secret must not be able to lock the real user out, so the real user waits at
 * most `backoff.maxSeconds`, and a success clears the tally.
 *
 * The tally lives in the account's private profile item, under a field of its
 * own (`data.<field>`): one field per kind of secret (the second factor, the
 * password), so one kind of failure never delays the other, and a write of the
 * MFA enrolment cannot reset a tally as a side effect. The profile store only
 * expands one level of dot-notation, hence a top-level field under `data`.
 *
 * The counter lives on the user's home core, and that is complete: every
 * request that checks the user's secrets lands there.
 */

type UserRef = { id: string; username: string };
/** Times in ms; `lastFailureAt` is the last reserved attempt; `notBefore` is 0
 * when no delay applies. */
type ThrottleState = { failures: number; lastFailureAt: number; notBefore: number };
/** What may be stored: the current shape, or a former lockout shape
 * (`{ count, windowStartedAt, lockedUntil }`) on an upgraded deployment. */
type StoredThrottle = Partial<ThrottleState> & { count?: number; windowStartedAt?: number; lockedUntil?: number };
type Cb<T = unknown> = (err: Error | null, result?: T) => void;
type JsonGuard = { path: string[]; absent?: true; eq?: number };
type ProfileStorageLike = {
  findOne (user: UserRef, query: { id: string }, options: null, cb: Cb<unknown>): void;
  updateOne (user: UserRef, query: { id: string }, update: Record<string, unknown>, cb: Cb<unknown>): void;
  insertOne (user: UserRef, item: Record<string, unknown>, cb: Cb<unknown>): void;
  compareAndSetJson (user: UserRef, query: { id: string }, guards: JsonGuard[], sets: Array<{ path: string[]; value: unknown }>, cb: Cb<boolean>): void;
};
type WarnLogger = { warn (msg: string): void };

/** What governs one tally: how long a failure counts, and the delay curve. */
type AccountThrottleCfg = { windowSeconds: number; backoff: BackoffCfg };

type ThrottleOptions = {
  profileStorage: ProfileStorageLike;
  /** Field of the private profile's `data` holding the tally. */
  field: string;
  /** Names the secret in messages: 'MFA', 'password'. */
  label: string;
  /** Names one attempt in log lines: 'second-factor', 'password'. */
  attemptNoun: string;
  logger: WarnLogger;
};

const PROFILE_ID = 'private';

function createAccountAttemptThrottle (opts: ThrottleOptions) {
  const { profileStorage, field, label, attemptNoun, logger } = opts;
  const capitalized = label.charAt(0).toUpperCase() + label.slice(1);

  async function readItem (user: UserRef): Promise<{ data?: Record<string, unknown> } | null> {
    return await fromCallback((cb: Cb<unknown>) =>
      profileStorage.findOne(user, { id: PROFILE_ID }, null, cb)) as { data?: Record<string, unknown> } | null;
  }

  function storedOf (item: { data?: Record<string, unknown> } | null): StoredThrottle | null | undefined {
    return item?.data?.[field] as StoredThrottle | null | undefined;
  }

  /**
   * Read a stored tally as the current shape. A former lockout shape reads as
   * a tally, and its `lockedUntil` is deliberately NOT honoured: that lockout
   * is what the backoff replaces.
   */
  function asState (stored: StoredThrottle | null | undefined): ThrottleState | null {
    if (stored == null || typeof stored !== 'object') return null;
    if (typeof stored.failures === 'number') {
      return { failures: stored.failures, lastFailureAt: stored.lastFailureAt ?? 0, notBefore: stored.notBefore ?? 0 };
    }
    if (typeof stored.count === 'number') {
      return { failures: stored.count, lastFailureAt: stored.windowStartedAt ?? 0, notBefore: 0 };
    }
    return null;
  }

  /** A tally whose last attempt is older than the window counts as none. */
  function live (state: ThrottleState | null, now: number, cfg: AccountThrottleCfg): ThrottleState | null {
    if (state == null) return null;
    if (now - state.lastFailureAt > cfg.windowSeconds * 1000) return null;
    return state;
  }

  function backoffErrorFor (notBefore: number, now: number): Error {
    const retryAfterSeconds = Math.ceil((notBefore - now) / 1000);
    return errors.tooManyAttempts(retryAfterSeconds, {
      message: `Too many failed ${label} attempts for this account; retry in ${retryAfterSeconds} s.`,
      data: { retryAfterSeconds }
    });
  }

  function busyError (): Error {
    return errors.tooManyAttempts(1, {
      message: `Too many concurrent ${label} attempts for this account; retry in 1 s.`,
      data: { retryAfterSeconds: 1 }
    });
  }

  /**
   * The error to surface while a delay runs, or null to proceed. Read-only and
   * returns BEFORE any check: an attempt sent during the delay is neither
   * checked nor counted, so the caller learns nothing from it and cannot drive
   * storage writes by continuing to guess.
   */
  async function backoffError (user: UserRef, cfg: AccountThrottleCfg): Promise<Error | null> {
    if (cfg.backoff.maxSeconds === 0) return null;
    const now = Date.now();
    const state = live(asState(storedOf(await readItem(user))), now, cfg);
    if (state == null || state.notBefore <= now) return null;
    return backoffErrorFor(state.notBefore, now);
  }

  /**
   * Count one attempt against the account before it is checked, atomically
   * across API workers: a compare-and-set on the stored tally, so N attempts in
   * flight take N slots. Refused while the delay set by the PREVIOUS attempt
   * runs, so a burst reaches the check at most `freeFailures + 1` times. A
   * success clears the tally afterwards. A race is only ever lost to another
   * reservation that succeeded; one that keeps losing is refused (fail closed),
   * never let through uncounted. Returns the error to surface, or null.
   */
  async function reserve (user: UserRef, cfg: AccountThrottleCfg): Promise<Error | null> {
    if (cfg.backoff.maxSeconds === 0) return null; // backoff disabled
    const T = ['data', field];
    for (let tries = 0; tries < 10; tries++) {
      const now = Date.now();
      const item = await readItem(user);
      const stored = storedOf(item);
      const previous = live(asState(stored), now, cfg);
      if (previous != null && previous.notBefore > now) return backoffErrorFor(previous.notBefore, now);
      const failures = (previous?.failures ?? 0) + 1;
      const delaySeconds = delayForFailures(failures, cfg.backoff);
      const next: ThrottleState = { failures, lastFailureAt: now, notBefore: delaySeconds > 0 ? now + delaySeconds * 1000 : 0 };

      if (item == null) {
        // No private profile yet: create it. A concurrent creator wins the
        // primary key; loop and accrue on top of its row.
        try {
          await fromCallback((cb: Cb<unknown>) =>
            profileStorage.insertOne(user, { id: PROFILE_ID, data: { [field]: next } }, cb));
        } catch (err) {
          if ((err as { isDuplicate?: boolean }).isDuplicate) continue;
          throw err;
        }
      } else if (stored != null && typeof stored.failures !== 'number' && typeof stored.count !== 'number') {
        // An unreadable leftover offers nothing to guard on: replace it outright.
        await fromCallback((cb: Cb<unknown>) =>
          profileStorage.updateOne(user, { id: PROFILE_ID }, { data: { [field]: next } }, cb));
      } else {
        // Guard on exactly what was read: nothing, or the same stored count.
        const guard: JsonGuard = stored == null
          ? { path: T, absent: true }
          : typeof stored.failures === 'number'
            ? { path: [...T, 'failures'], eq: stored.failures }
            : { path: [...T, 'count'], eq: stored.count as number };
        const written = await fromCallback((cb: Cb<boolean>) =>
          profileStorage.compareAndSetJson(user, { id: PROFILE_ID }, [guard], [{ path: T, value: next }], cb));
        if (!written) continue;
      }
      // Logged when a delay first reaches the cap, never per failed attempt:
      // under an attack the per-attempt line would itself be the amplification.
      if (delaySeconds === cfg.backoff.maxSeconds && delayForFailures(failures - 1, cfg.backoff) < delaySeconds) {
        logger.warn(
          `${capitalized} failures for user "${user.username}" reached the maximum backoff: ${delaySeconds}s between ${attemptNoun} attempts until one succeeds or the window lapses.`
        );
      }
      return null;
    }
    logger.warn(`${capitalized} attempt for user "${user.username}" refused: lost the race to concurrent attempts 10 times in a row.`);
    return busyError();
  }

  /** Clear the tally, but only when there is one (avoids a write per success). */
  async function clearIfAny (user: UserRef): Promise<void> {
    const item = await readItem(user);
    if (storedOf(item) == null) return;
    await fromCallback((cb: Cb<unknown>) =>
      profileStorage.updateOne(user, { id: PROFILE_ID }, { data: { [field]: null } }, cb));
  }

  return { backoffError, reserve, clearIfAny, busyError };
}

type AccountAttemptThrottle = ReturnType<typeof createAccountAttemptThrottle>;

export { createAccountAttemptThrottle };
export type { AccountThrottleCfg, AccountAttemptThrottle };
