/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createHash } from 'node:crypto';
import { addressBucket } from 'middleware/src/clientIp.ts';
import { clientFor } from 'messages/src/cluster_kv.ts';

/**
 * Per-address budget of `POST /access/invitationtoken/check`.
 *
 * The check takes no credentials and answers whether a token is valid, so
 * without a budget it lets a caller try tokens at request rate. Each address
 * bucket (an IPv4 address, or the /64 of an IPv6 one) may run
 * CHECKS_PER_WINDOW checks in a window opened by its first; past it the
 * check is refused with 429 until the window ends.
 *
 * The counters live in `cluster_kv`, shared by the API workers of this core
 * (a budget per core), under a hash of the bucket so no address lands in a
 * key. Counting is compare-and-set, so concurrent checks each take their own
 * slot. When the store cannot answer the check proceeds: losing the budget
 * must not take the check down.
 */

const CHECKS_PER_WINDOW = 10;
const WINDOW_MS = 60 * 1000;
const NAMESPACE = 'invitation-check-ip/';
const CAS_TRIES = 20;

type Counter = { count: number; windowEndsAt: number };
type KvClient = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, opts?: { ttlMs?: number; ifEquals?: unknown }) => Promise<boolean>;
  delete: (key: string) => Promise<void>;
};

let kvClient: KvClient | null = null;
function getKv (): KvClient {
  if (kvClient == null) kvClient = clientFor() as KvClient;
  return kvClient;
}

/** Keys written in this process, tracked in test runs only (see `clear`). */
const TRACK_KEYS = process.env.NODE_ENV === 'test';
const knownKeys = new Set<string>();

function keyFor (ip: string): string {
  return NAMESPACE + createHash('sha256').update(addressBucket(ip)).digest('hex').slice(0, 32);
}

function isCounter (v: unknown): v is Counter {
  return v != null && typeof v === 'object' &&
    typeof (v as Counter).count === 'number' && typeof (v as Counter).windowEndsAt === 'number';
}

/**
 * Count one check from `ip`. Answers null when it may run, else the seconds
 * until the address's window ends. An empty `ip` (no address known) is not
 * counted.
 */
async function reserveInvitationCheck (ip: string | null | undefined): Promise<number | null> {
  if (ip == null || ip === '') return null;
  const key = keyFor(ip);
  try {
    for (let tries = 0; tries < CAS_TRIES; tries++) {
      const now = Date.now();
      const row = await getKv().get(key);
      const live = isCounter(row) && row.windowEndsAt > now ? row : null;
      if (live != null && live.count >= CHECKS_PER_WINDOW) {
        return Math.max(1, Math.ceil((live.windowEndsAt - now) / 1000));
      }
      const next: Counter = { count: (live?.count ?? 0) + 1, windowEndsAt: live?.windowEndsAt ?? now + WINDOW_MS };
      if (await getKv().set(key, next, { ttlMs: Math.max(1, next.windowEndsAt - now), ifEquals: row ?? null }) === true) {
        if (TRACK_KEYS) knownKeys.add(key);
        return null;
      }
    }
    // Kept losing to concurrent checks: refuse rather than run uncounted.
    return 1;
  } catch {
    return null;
  }
}

/** Drop the counters written by this process (tests). */
async function clear (): Promise<void> {
  for (const key of [...knownKeys]) {
    await getKv().delete(key);
    knownKeys.delete(key);
  }
}

export { reserveInvitationCheck, clear, CHECKS_PER_WINDOW, WINDOW_MS };
