/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Throttle for password reset requests, on PlatformDB's cluster-wide TTL
 * store (same pattern as the registration email challenge):
 *   - per account: one request per minute, five per rolling day;
 *   - per client address: twenty per rolling hour.
 * Only accepted requests are counted. Counters are read-modify-write: two
 * concurrent callers may let one extra request through, which is acceptable
 * for a cap whose job is to stop bulk mailing, not to be exact. The
 * per-account cooldown is exact (atomic set-if-absent).
 */

import { factory as errors } from 'errors';
import * as storages from 'storages';
import { hashToken } from '../emails/tokens.ts';

export const ACCOUNT_COOLDOWN_MS = 60 * 1000;
export const ACCOUNT_DAILY_LIMIT = 5;
export const IP_HOURLY_LIMIT = 20;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type StateRow = { value: unknown; expiresAt: number };
type ThrottleStore = {
  setAccessState: (key: string, value: unknown, expiresAt: number) => Promise<void>;
  setAccessStateIfAbsent: (key: string, value: unknown, expiresAt: number) => Promise<boolean>;
  getAccessState: (key: string) => Promise<StateRow | null>;
  deleteAccessState: (key: string) => Promise<void>;
};

export type ReserveOutcome =
  | { ok: true }
  | { ok: false; reason: 'ip-limit' | 'daily-limit' | 'cooldown'; retryAfterSeconds: number };

function getStore (): ThrottleStore {
  const db = storages.platformDB as ThrottleStore | undefined;
  if (db == null || typeof db.setAccessStateIfAbsent !== 'function') {
    throw errors.unexpectedError(new Error('password reset throttle: PlatformDB is not initialised'));
  }
  return db;
}

export function cooldownKey (userId: string): string {
  return 'password-reset-sent/' + userId;
}

export function dailyKey (userId: string): string {
  return 'password-reset-daily/' + userId;
}

/** Hashed so no client address lands in a cluster-wide key. */
export function ipKey (ip: string): string {
  return 'password-reset-ip/' + hashToken(ip);
}

function counterOf (row: StateRow | null): number {
  const value = row?.value as { count?: unknown } | undefined;
  return typeof value?.count === 'number' ? value.count : 0;
}

function secondsUntil (expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}

/**
 * Reserve a password reset request for this account from this address.
 * `ip` may be empty when the transport carries no address; the address
 * budget is then skipped.
 */
export async function reservePasswordReset (userId: string, ip: string | null | undefined): Promise<ReserveOutcome> {
  const store = getStore();
  const now = Date.now();

  const ipRow = ip ? await store.getAccessState(ipKey(ip)) : null;
  if (ipRow != null && counterOf(ipRow) >= IP_HOURLY_LIMIT) {
    return { ok: false, reason: 'ip-limit', retryAfterSeconds: secondsUntil(ipRow.expiresAt, now) };
  }

  const daily = await store.getAccessState(dailyKey(userId));
  if (daily != null && counterOf(daily) >= ACCOUNT_DAILY_LIMIT) {
    return { ok: false, reason: 'daily-limit', retryAfterSeconds: secondsUntil(daily.expiresAt, now) };
  }

  const reserved = await store.setAccessStateIfAbsent(cooldownKey(userId), 1, now + ACCOUNT_COOLDOWN_MS);
  if (!reserved) {
    return { ok: false, reason: 'cooldown', retryAfterSeconds: Math.ceil(ACCOUNT_COOLDOWN_MS / 1000) };
  }

  await store.setAccessState(dailyKey(userId), { count: counterOf(daily) + 1 }, daily?.expiresAt ?? now + DAY_MS);
  if (ip) {
    await store.setAccessState(ipKey(ip), { count: counterOf(ipRow) + 1 }, ipRow?.expiresAt ?? now + HOUR_MS);
  }
  return { ok: true };
}

/** Drop the throttle state of an account and of the given addresses. */
export async function clearPasswordResetThrottle (userId: string | null, ips: string[] = []): Promise<void> {
  const store = getStore();
  if (userId != null) {
    await store.deleteAccessState(cooldownKey(userId));
    await store.deleteAccessState(dailyKey(userId));
  }
  for (const ip of ips) await store.deleteAccessState(ipKey(ip));
}
