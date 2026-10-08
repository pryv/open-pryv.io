/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHash } = require('node:crypto');
const errors = require('errors').factory;

/**
 * Limits on SMS sends, checked before every SMS the core has sent (a login
 * challenge, an `mfa.challenge` re-send, an SMS `mfa.activate`), in both SMS
 * modes. Three budgets, each 0 to disable:
 *  - `minIntervalSeconds` between two sends on one MFA session;
 *  - `perUserPerHour` sends for one user, in a window opened by the first;
 *  - `perDestinationPerDay` sends to one destination (phone), whoever the
 *    user, in a window opened by the first.
 * A send over a budget is refused with 429 too-many-attempts and its
 * `retryAfterSeconds`; nothing is sent.
 *
 * The counters live in cluster_kv (shared by the API workers of the core).
 * The destination is keyed by a hash of the phone, never the phone itself: a
 * pseudonym (a phone number hash is reversible by enumeration), so that a key
 * listing does not hand over phone numbers; the entries are short-lived.
 * A send counts once its budgets are reserved, even when the provider then
 * fails: a failing send still reached the provider.
 */

type SendLimits = {
  minIntervalSeconds: number;
  perUserPerHour: number;
  perDestinationPerDay: number;
};

const SEND_LIMIT_DEFAULTS: SendLimits = {
  minIntervalSeconds: 30,
  perUserPerHour: 5,
  perDestinationPerDay: 10
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CAS_TRIES = 20;

interface KvLike {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, opts?: { ttlMs?: number; ifEquals?: unknown }) => Promise<boolean>;
  delete: (key: string) => Promise<void>;
}

type Counter = { count: number; windowEndsAt: number };
type Send = { sessionId: string; username: string; destination: string };

function isCounter (v: unknown): v is Counter {
  return v != null && typeof v === 'object' &&
    typeof (v as Counter).count === 'number' && typeof (v as Counter).windowEndsAt === 'number';
}

/** The destination of an SMS enrolment: its phone, else its whole content. */
function smsDestination (content: Record<string, unknown> | null | undefined): string {
  const phone = content?.phone;
  if (typeof phone === 'string' && phone !== '') return phone;
  const sorted = Object.keys(content || {}).sort().map((k) => [k, (content as Record<string, unknown>)[k]]);
  return JSON.stringify(sorted);
}

function destinationKeyPart (destination: string): string {
  return createHash('sha256').update('mfa-sms-destination:' + destination).digest('hex');
}

function refusal (retryAt: number, now: number): Error {
  const retryAfterSeconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
  return errors.tooManyAttempts(retryAfterSeconds, {
    message: `Too many MFA SMS codes sent; retry in ${retryAfterSeconds} s.`,
    data: { retryAfterSeconds }
  });
}

class SmsSendLimiter {
  limits: SendLimits;
  kv: KvLike;
  namespace: string;

  constructor (limits: SendLimits, opts: { kvClient?: KvLike; namespace?: string } = {}) {
    this.limits = limits;
    this.kv = opts.kvClient || require('messages/src/cluster_kv.ts').clientFor();
    this.namespace = opts.namespace || 'mfa-sms-send/';
  }

  /**
   * Reserve one send on every budget, or throw the 429 to surface (no budget
   * is left taken then).
   */
  async reserve ({ sessionId, username, destination }: Send): Promise<void> {
    const now = Date.now();
    const sessionKey = this.namespace + 'session/' + sessionId;
    const intervalMs = this.limits.minIntervalSeconds * 1000;
    if (intervalMs > 0) {
      // Absent-only write: of two sends in flight on one session, one wins.
      const until = now + intervalMs;
      if (!await this.kv.set(sessionKey, { until }, { ttlMs: intervalMs, ifEquals: null })) {
        const held = await this.kv.get(sessionKey) as { until?: number } | null;
        throw refusal(typeof held?.until === 'number' ? held.until : until, now);
      }
    }
    const userKey = this.namespace + 'user/' + username;
    const userRefused = await this.bump(userKey, this.limits.perUserPerHour, HOUR_MS, now);
    if (userRefused != null) {
      if (intervalMs > 0) await this.kv.delete(sessionKey);
      throw refusal(userRefused, now);
    }
    const destinationKey = this.namespace + 'destination/' + destinationKeyPart(destination);
    const destinationRefused = await this.bump(destinationKey, this.limits.perDestinationPerDay, DAY_MS, now);
    if (destinationRefused != null) {
      await this.release(userKey, this.limits.perUserPerHour);
      if (intervalMs > 0) await this.kv.delete(sessionKey);
      throw refusal(destinationRefused, now);
    }
  }

  /**
   * Count one send on a windowed counter, compare-and-set so concurrent sends
   * each take their own slot. Answers null when counted, else when to retry.
   */
  async bump (key: string, max: number, windowMs: number, now: number): Promise<number | null> {
    if (!(max > 0)) return null;
    for (let tries = 0; tries < CAS_TRIES; tries++) {
      const row = await this.kv.get(key);
      const live = isCounter(row) && row.windowEndsAt > now ? row : null;
      if (live != null && live.count >= max) return live.windowEndsAt;
      const next: Counter = { count: (live?.count ?? 0) + 1, windowEndsAt: live?.windowEndsAt ?? now + windowMs };
      if (await this.kv.set(key, next, { ttlMs: Math.max(1, next.windowEndsAt - now), ifEquals: row ?? null })) return null;
    }
    // Kept losing to concurrent sends: refuse rather than send uncounted.
    return now + 1000;
  }

  /** Give back one slot taken by bump. Best effort. */
  async release (key: string, max: number): Promise<void> {
    if (!(max > 0)) return;
    for (let tries = 0; tries < CAS_TRIES; tries++) {
      const row = await this.kv.get(key);
      if (!isCounter(row) || row.count <= 0) return;
      const now = Date.now();
      const next: Counter = { count: row.count - 1, windowEndsAt: row.windowEndsAt };
      if (await this.kv.set(key, next, { ttlMs: Math.max(1, row.windowEndsAt - now), ifEquals: row })) return;
    }
  }
}

export { SmsSendLimiter, SEND_LIMIT_DEFAULTS, smsDestination };
export type { SendLimits };
