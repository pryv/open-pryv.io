/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Per-core (per-process) cache of the revoked-client epochs, so the
 * resource-server hot path pays at most ONE PlatformDB read per TTL rather
 * than one per request. An operator revoke (a PlatformDB write on any core)
 * takes effect cluster-wide within one TTL — every core reads the shared
 * PlatformDB locally, which is the only cross-core mechanism the independent-
 * cores design allows.
 *
 * Revoke is a token EPOCH: `getRevokedAt(clientId)` returns the revoke time
 * (ms) or null. A token is dead iff it was minted before that time — so a
 * re-registered client's fresh tokens work while its old ones stay dead.
 *
 * Fail-open on a read error: a transient PlatformDB hiccup keeps the last
 * known map (and backs off one TTL) rather than blocking every oauth session —
 * revoke is a bounded-SLA best-effort control, not an availability gate.
 */

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import { listRevokedClients } from './storage.ts';
import { logServerError } from './serverLog.ts';

// loadedAt === null ⇒ never loaded (force a cold load on first use, whatever
// the clock reads — the TTL math alone can't distinguish "just booted" from
// "loaded a moment ago").
type CacheState = { loadedAt: number | null; epochs: Map<string, number> };

let cache: CacheState = { loadedAt: null, epochs: new Map() };
let refreshing: Promise<void> | null = null;

/**
 * The revoke epoch (ms) for `clientId`, or null if not revoked — using the
 * cached map, refreshed from PlatformDB on first use and whenever older than
 * `ttlSeconds`.
 */
export async function getRevokedAt (
  platform: PlatformDB, clientId: string, ttlSeconds: number, now: number = Date.now()
): Promise<number | null> {
  if (cache.loadedAt == null || (now - cache.loadedAt) > ttlSeconds * 1000) {
    await refresh(platform, now);
  }
  const at = cache.epochs.get(clientId);
  return at == null ? null : at;
}

/**
 * @private
 * Reload the epoch map. Concurrent callers share one in-flight load. On error,
 * keep the stale map but advance `loadedAt` so the hot path doesn't storm a
 * failing store (retry next TTL).
 */
async function refresh (platform: PlatformDB, now: number): Promise<void> {
  if (refreshing != null) return refreshing;
  refreshing = (async () => {
    try {
      const entries = await listRevokedClients(platform);
      const epochs = new Map<string, number>();
      for (const e of entries) epochs.set(e.clientId, e.revokedAt);
      cache = { loadedAt: now, epochs };
    } catch (err: unknown) {
      cache = { loadedAt: now, epochs: cache.epochs };
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
  cache = { loadedAt: null, epochs: new Map() };
  refreshing = null;
}
