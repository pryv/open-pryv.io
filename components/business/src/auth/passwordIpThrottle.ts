/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Failed-password budget per client address (`auth.passwordAttempts.perIp`),
 * on PlatformDB's cluster-wide TTL store (same store as the password reset
 * throttle), so it holds across cores.
 *
 * The per-account delay bounds guesses against one account; this bounds a
 * caller spraying passwords across many accounts. Every failed password check
 * from an address (an IPv4 address, or the /64 of an IPv6 one) counts in a
 * fixed window of `windowSeconds`; once `maxFailures` have counted, every
 * password check from that address is refused, unchecked, until the window
 * ends: 429 too-many-attempts with Retry-After. Successes do not count, and do
 * not clear the budget (a caller signing in to an account of their own must
 * not buy a fresh budget).
 *
 * Counting is exact across API workers and cores: each failure claims its own
 * row (`<bucket>/<window>/<n>`, n < maxFailures) with an atomic set-if-absent,
 * so failures sent in parallel never share a count. Rows are claimed in order,
 * so the claimed ones always form a prefix: the budget is spent when row
 * `maxFailures - 1` exists, and the first free row is found by bisection.
 * Checks that were already past the refusal when the budget ran out still
 * complete: a burst overshoots by at most its own width, once per window.
 */

import { factory as errors } from 'errors';
import * as storages from 'storages';
import { getLogger } from '@pryv/boiler';
import { addressBucket } from 'middleware/src/clientIp.ts';
import { hashToken } from '../emails/tokens.ts';
import type { PasswordIpCfg } from './passwordAttempts.ts';

const NAMESPACE = 'password-fail-ip/';

type StateRow = { value: unknown; expiresAt: number };
type ThrottleStore = {
  setAccessStateIfAbsent: (key: string, value: unknown, expiresAt: number) => Promise<boolean>;
  getAccessState: (key: string) => Promise<StateRow | null>;
  deleteAccessState: (key: string) => Promise<void>;
};

let logger: { warn (msg: string): void } | null = null;

function getStore (): ThrottleStore {
  const db = storages.platformDB as ThrottleStore | undefined;
  if (db == null || typeof db.setAccessStateIfAbsent !== 'function') {
    throw errors.unexpectedError(new Error('password address budget: PlatformDB is not initialised'));
  }
  return db;
}

/** Hashed so no client address lands in a cluster-wide key. */
function bucketKey (ip: string): string {
  return NAMESPACE + hashToken(addressBucket(ip));
}

function windowAt (now: number, cfg: PasswordIpCfg): { index: number; endsAt: number } {
  const ms = cfg.windowSeconds * 1000;
  const index = Math.floor(now / ms);
  return { index, endsAt: (index + 1) * ms };
}

function slotKey (bucket: string, windowIndex: number, n: number): string {
  return bucket + '/' + windowIndex + '/' + n;
}

function applies (ip: string | null | undefined, cfg: PasswordIpCfg): ip is string {
  return ip != null && ip !== '' && cfg.maxFailures > 0;
}

function refusal (retryAfterSeconds: number): Error {
  return errors.tooManyAttempts(retryAfterSeconds, {
    message: `Too many failed password attempts from this address; retry in ${retryAfterSeconds} s.`,
    data: { retryAfterSeconds }
  });
}

/**
 * The error to surface before a password is checked, or null to proceed.
 * Read-only. `ip` may be empty when the transport carries no address; the
 * budget is then skipped.
 */
async function passwordIpRefusal (ip: string | null | undefined, cfg: PasswordIpCfg): Promise<Error | null> {
  if (!applies(ip, cfg)) return null;
  const now = Date.now();
  const w = windowAt(now, cfg);
  const last = await getStore().getAccessState(slotKey(bucketKey(ip), w.index, cfg.maxFailures - 1));
  if (last == null) return null;
  return refusal(Math.max(1, Math.ceil((w.endsAt - now) / 1000)));
}

/** Count one failed password check from `ip`. */
async function countPasswordIpFailure (ip: string | null | undefined, cfg: PasswordIpCfg): Promise<void> {
  if (!applies(ip, cfg)) return;
  const store = getStore();
  const bucket = bucketKey(ip);
  const w = windowAt(Date.now(), cfg);
  const exists = async (n: number) => (await store.getAccessState(slotKey(bucket, w.index, n))) != null;
  // First free row: the claimed rows form a prefix.
  let lo = 0;
  let hi = cfg.maxFailures;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (await exists(mid)) lo = mid + 1; else hi = mid;
  }
  // Concurrent failures race for the same row: a loser takes the next one.
  for (let n = lo; n < cfg.maxFailures; n++) {
    if (await store.setAccessStateIfAbsent(slotKey(bucket, w.index, n), 1, w.endsAt)) {
      // Logged once per address and window, never per failure: under an
      // attack the per-failure line would itself be the amplification.
      if (n === cfg.maxFailures - 1) {
        logger ??= getLogger('auth:password-ip-budget');
        logger.warn(`Failed passwords from one client address reached ${cfg.maxFailures} within ${cfg.windowSeconds} s: password checks from it are refused until the window ends.`);
      }
      return;
    }
  }
}

/** Drop the budget of the given addresses in the current window (tests). */
async function clearPasswordIpThrottle (ips: string[], cfg: PasswordIpCfg): Promise<void> {
  const store = getStore();
  const w = windowAt(Date.now(), cfg);
  for (const ip of ips) {
    const bucket = bucketKey(ip);
    for (let n = 0; n < cfg.maxFailures; n++) await store.deleteAccessState(slotKey(bucket, w.index, n));
  }
}

export { passwordIpRefusal, countPasswordIpFailure, clearPasswordIpThrottle };
