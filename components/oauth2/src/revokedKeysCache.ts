/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Per-core (per-process) cache of the operator-revoked DPoP key thumbprints, so
 * the resource-server hot path pays at most ONE PlatformDB read per TTL rather
 * than one per request. An operator revoke-key (a PlatformDB write on any core)
 * takes effect cluster-wide within one TTL — every core reads the shared
 * PlatformDB locally, which is the only cross-core mechanism the independent-
 * cores design allows.
 *
 * Semantics are PRESENCE (a blocklist Set), NOT the token-EPOCH used for client
 * revoke (revokedClientsCache.ts): a jkt IS the key, so any token bound to a
 * revoked jkt is dead regardless of mint time — including one a refresh rotation
 * re-mints on the same key AFTER the revoke (which an epoch check would wrongly
 * honour). See storage.ts revokeDpopKey for the full rationale.
 *
 * Fail-open on a read error: a transient PlatformDB hiccup keeps the last known
 * set (and backs off one TTL) rather than blocking every DPoP session — revoke
 * is a bounded-SLA best-effort control, not an availability gate.
 */

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import { listRevokedDpopKeys } from './storage.ts';
import { logServerError } from './serverLog.ts';

// loadedAt === null ⇒ never loaded (force a cold load on first use, whatever
// the clock reads — the TTL math alone can't distinguish "just booted" from
// "loaded a moment ago").
type CacheState = { loadedAt: number | null; revoked: Set<string> };

let cache: CacheState = { loadedAt: null, revoked: new Set() };
let refreshing: Promise<void> | null = null;

/**
 * True iff `jkt` is operator-revoked — using the cached set, refreshed from
 * PlatformDB on first use and whenever older than `ttlSeconds`.
 */
export async function isKeyRevoked (
  platform: PlatformDB, jkt: string, ttlSeconds: number, now: number = Date.now()
): Promise<boolean> {
  if (cache.loadedAt == null || (now - cache.loadedAt) > ttlSeconds * 1000) {
    await refresh(platform, now);
  }
  return cache.revoked.has(jkt);
}

/**
 * @private
 * Reload the revoked set. Concurrent callers share one in-flight load. On error,
 * keep the stale set but advance `loadedAt` so the hot path doesn't storm a
 * failing store (retry next TTL).
 */
async function refresh (platform: PlatformDB, now: number): Promise<void> {
  if (refreshing != null) return refreshing;
  refreshing = (async () => {
    try {
      const entries = await listRevokedDpopKeys(platform);
      const revoked = new Set<string>();
      for (const e of entries) revoked.add(e.jkt);
      cache = { loadedAt: now, revoked };
    } catch (err: unknown) {
      cache = { loadedAt: now, revoked: cache.revoked };
      logServerError('revokedKeysCache refresh failed', err);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * Test seam: reset the cache so a suite starts cold.
 * @private
 */
export function _resetForTests (): void {
  cache = { loadedAt: null, revoked: new Set() };
  refreshing = null;
}
