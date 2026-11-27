/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import * as storages from 'storages';
import { readLockdown } from './lockdown.ts';
import type { AdminStore } from './store.ts';

/**
 * Boot step of the lockdown (`lockdown.ts`), run by each API process before
 * it serves:
 * - logs what this core locks, when it locks something;
 * - writes the digest of this core's lockdown to the platform store
 *   (`admin-lockdown-hash/<coreId>` = `{ digest, at }`) when it changed;
 *   nothing for a core that locks nothing and never wrote one; and logs
 *   `WARN [admin-lockdown-drift]` when a core of the platform carries another
 *   digest. Lockdown is per core by design: the warning tells an operator
 *   whose cores are meant to be managed alike that one of them differs.
 * A failure of the store never stops the boot (the lockdown itself is
 * applied from this core's configuration only).
 */

type ConfigReader = { get: (key: string) => unknown };
type LoggerLike = { info: (msg: string) => void; warn: (msg: string) => void };

export const LOCKDOWN_HASH_PREFIX = 'admin-lockdown-hash/';

export type LockdownBootStore = Pick<AdminStore, 'setPlatformKv' | 'listPlatformKvEntries'> & {
  getAllCoreInfos?: () => Promise<Array<{ id?: string } | null>>;
};

export type LockdownBootOptions = {
  config: ConfigReader;
  logger: LoggerLike;
  /** Default: the platform store of `storages`. */
  db?: LockdownBootStore;
  /** Default: `core.id` (`single` when unset, as the platform names it). */
  coreId?: string;
  now?: () => number;
};

export type LockdownBootResult = { digest: string; drift: string[] };

function digestOf (raw: string): string | null {
  try {
    const v = JSON.parse(raw);
    return v != null && typeof v.digest === 'string' ? v.digest : null;
  } catch {
    return null;
  }
}

export async function runLockdownBoot (opts: LockdownBootOptions): Promise<LockdownBootResult | null> {
  const { config, logger } = opts;
  const lockdown = readLockdown(config);
  if (lockdown.view != null) {
    const caps = Object.entries(lockdown.view.capabilities).map(([n, s]) => `${n} (${s})`);
    const keys = lockdown.view.platformConfig.readonly;
    logger.info('[admin-lockdown] managed outside the API on this core: ' +
      [caps.length > 0 ? 'capabilities ' + caps.join(', ') : null, keys.length > 0 ? 'platform configuration keys ' + keys.join(', ') : null]
        .filter((s) => s != null).join('; '));
  }

  const coreId = opts.coreId ?? ((config.get('core:id') as string) || 'single');
  try {
    const db: LockdownBootStore = opts.db ?? (storages.platformDB as LockdownBootStore);
    const now = opts.now ?? Date.now;
    const rows = await db.listPlatformKvEntries(LOCKDOWN_HASH_PREFIX);
    const own = rows.find((r) => r.key === LOCKDOWN_HASH_PREFIX + coreId) ?? null;
    // Written only when it changed, and never for a core that locks nothing
    // and has no row yet (an upgrade writes nothing).
    if (!(lockdown.view == null && own == null) && (own == null || digestOf(own.value) !== lockdown.digest)) {
      await db.setPlatformKv(LOCKDOWN_HASH_PREFIX + coreId, JSON.stringify({ digest: lockdown.digest, at: now() }));
    }
    let registered: Set<string> | null = null;
    if (typeof db.getAllCoreInfos === 'function') {
      registered = new Set((await db.getAllCoreInfos()).map((c) => c?.id).filter((id): id is string => typeof id === 'string'));
    }
    const drift: string[] = [];
    for (const { key, value } of rows) {
      const other = key.slice(LOCKDOWN_HASH_PREFIX.length);
      if (other === coreId || (registered != null && !registered.has(other))) continue;
      const digest = digestOf(value);
      if (digest != null && digest !== lockdown.digest) drift.push(other);
    }
    drift.sort();
    if (drift.length > 0) {
      logger.warn(`[admin-lockdown-drift] this core's admin.lockdown differs from the one of core(s) ${drift.join(', ')}: ` +
        'lockdown is per core (each core\'s own configuration file); if these cores are managed alike, give them the same admin.lockdown block');
    }
    return { digest: lockdown.digest, drift };
  } catch (err) {
    logger.warn(`[admin-lockdown-drift] could not compare this core's admin.lockdown with the other cores: ${(err as Error).message}`);
    return null;
  }
}
