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
 * Per-address budget of an unauthenticated route that would otherwise let a
 * caller probe at request rate (an invitation token check, an external-id
 * lookup).
 *
 * Each address bucket (an IPv4 address, or the /64 of an IPv6 one) may count
 * `perWindow` times in a window opened by its first count; past it the caller
 * is refused until the window ends. The counters live in `cluster_kv`, shared
 * by the API workers of this core (a budget per core), under a hash of the
 * bucket so no address lands in a key. Counting is compare-and-set, so
 * concurrent requests each take their own slot. When the store cannot answer
 * the request proceeds: losing the budget must not take the route down.
 */

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

function isCounter (v: unknown): v is Counter {
  return v != null && typeof v === 'object' &&
    typeof (v as Counter).count === 'number' && typeof (v as Counter).windowEndsAt === 'number';
}

export interface AddressBudget {
  /** Count one from `ip`: null when it may run, else the seconds until the window ends. */
  reserve (ip: string | null | undefined): Promise<number | null>;
  /** Same answer as `reserve`, without counting. */
  check (ip: string | null | undefined): Promise<number | null>;
  /** Drop the counters written by this process (tests). */
  clear (): Promise<void>;
}

export function createAddressBudget (options: { namespace: string, perWindow: number, windowMs: number }): AddressBudget {
  const { namespace, perWindow, windowMs } = options;
  const knownKeys = new Set<string>();

  function keyFor (ip: string): string {
    return namespace + createHash('sha256').update(addressBucket(ip)).digest('hex').slice(0, 32);
  }

  function retryAfter (live: Counter, now: number): number {
    return Math.max(1, Math.ceil((live.windowEndsAt - now) / 1000));
  }

  return {
    // An empty `ip` (no address known) is not counted.
    async reserve (ip) {
      if (ip == null || ip === '') return null;
      const key = keyFor(ip);
      try {
        for (let tries = 0; tries < CAS_TRIES; tries++) {
          const now = Date.now();
          const row = await getKv().get(key);
          const live = isCounter(row) && row.windowEndsAt > now ? row : null;
          if (live != null && live.count >= perWindow) return retryAfter(live, now);
          const next: Counter = { count: (live?.count ?? 0) + 1, windowEndsAt: live?.windowEndsAt ?? now + windowMs };
          if (await getKv().set(key, next, { ttlMs: Math.max(1, next.windowEndsAt - now), ifEquals: row ?? null }) === true) {
            if (TRACK_KEYS) knownKeys.add(key);
            return null;
          }
        }
        // Kept losing to concurrent requests: refuse rather than run uncounted.
        return 1;
      } catch {
        return null;
      }
    },

    async check (ip) {
      if (ip == null || ip === '') return null;
      try {
        const now = Date.now();
        const row = await getKv().get(keyFor(ip));
        const live = isCounter(row) && row.windowEndsAt > now ? row : null;
        return live != null && live.count >= perWindow ? retryAfter(live, now) : null;
      } catch {
        return null;
      }
    },

    async clear () {
      for (const key of [...knownKeys]) {
        await getKv().delete(key);
        knownKeys.delete(key);
      }
    }
  };
}
