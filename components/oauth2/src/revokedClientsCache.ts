/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Per-core (per-process) cache of the revoked-client tombstone set, so the
 * resource-server hot path pays at most ONE PlatformDB read per TTL rather
 * than one per request. An operator revoke (a PlatformDB write on any core)
 * takes effect cluster-wide within one TTL — every core reads the shared
 * PlatformDB locally, which is the only cross-core mechanism the independent-
 * cores design allows.
 *
 * Fail-open on a read error: a transient PlatformDB hiccup keeps the last
 * known set (and backs off one TTL) rather than blocking every oauth session —
 * revoke is a bounded-SLA best-effort control, not an availability gate.
 */

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import { listRevokedClientIds } from './storage.ts';
import { logServerError } from './serverLog.ts';

// loadedAt === null ⇒ never loaded (force a cold load on first use, whatever
// the clock reads — the TTL math alone can't distinguish "just booted" from
// "loaded a moment ago").
type CacheState = { loadedAt: number | null; ids: Set<string> };

let cache: CacheState = { loadedAt: null, ids: new Set() };
let refreshing: Promise<void> | null = null;

/**
 * Whether `clientId` is currently revoked, using the cached set and
 * refreshing it from PlatformDB on first use and whenever older than
 * `ttlSeconds`.
 */
export async function isClientRevoked (
  platform: PlatformDB, clientId: string, ttlSeconds: number, now: number = Date.now()
): Promise<boolean> {
  if (cache.loadedAt == null || (now - cache.loadedAt) > ttlSeconds * 1000) {
    await refresh(platform, now);
  }
  return cache.ids.has(clientId);
}

/**
 * @private
 * Reload the tombstone set. Concurrent callers share one in-flight load. On
 * error, keep the stale set but advance `loadedAt` so the hot path doesn't
 * storm a failing store (retry next TTL).
 */
async function refresh (platform: PlatformDB, now: number): Promise<void> {
  if (refreshing != null) return refreshing;
  refreshing = (async () => {
    try {
      const ids = await listRevokedClientIds(platform);
      cache = { loadedAt: now, ids: new Set(ids) };
    } catch (err: unknown) {
      cache = { loadedAt: now, ids: cache.ids };
      logServerError('revokedClientsCache refresh failed', err);
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
  cache = { loadedAt: null, ids: new Set() };
  refreshing = null;
}
