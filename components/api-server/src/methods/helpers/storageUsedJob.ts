/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { getLogger } from '@pryv/boiler';
import type { ConfigLike, Logger } from '@pryv/boiler';
import { Size } from 'storage';
import { getUsersRepository } from 'business/src/users/index.ts';

/**
 * The storage-size job of this core: recomputes every local account's
 * `storageUsed` (`dbDocuments`, `attachedFiles`), the figure `account.get`
 * answers. Nothing else writes it, so without this job every account reads
 * 0 / 0. It runs in the API worker the master designates for the core's
 * background loops, a first pass after a boot delay, then one pass every
 * `account.storageUsed.intervalHours` (0 turns it off).
 * `components/api-server/bin/nightly` runs the same pass once, by hand.
 */

const FIRST_PASS_DELAY_MS = 15 * 60 * 1000;
export const DEFAULT_INTERVAL_HOURS = 24;

/** The pass interval in ms, or 0 when the job is off. */
export function storageUsedIntervalMs (config: ConfigLike): number {
  const raw = config.get('account:storageUsed:intervalHours');
  const hours = raw == null ? DEFAULT_INTERVAL_HOURS : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return hours * 60 * 60 * 1000;
}

/**
 * Recompute `storageUsed` for every account of this core. An account that
 * fails is logged and skipped: one bad account never stops the pass.
 */
export async function computeStorageUsedForAllAccounts (logger: Logger = getLogger('storage-used')): Promise<{ accounts: number; updated: number; failed: number }> {
  const repository = await getUsersRepository();
  const size = new Size();
  const accounts = await repository.getAllUsersIdAndName();
  let updated = 0;
  let failed = 0;
  for (const { id, username } of accounts) {
    try {
      const user = await repository.getUserById(id);
      if (user == null) throw new Error('listed in the users index but not found');
      await size.computeForUser(user);
      updated++;
    } catch (err: unknown) {
      failed++;
      logger.error(`storage size of account "${username}" (${id}) not computed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { accounts: accounts.length, updated, failed };
}

/**
 * Start the job: first pass after a boot delay, then one pass every interval
 * after the previous one ended (passes never overlap). Returns null when the
 * job is off.
 */
export function startStorageUsedJob (config: ConfigLike, options: { firstPassDelayMs?: number } = {}): { stop: () => void } | null {
  const logger = getLogger('storage-used');
  const intervalMs = storageUsedIntervalMs(config);
  if (intervalMs === 0) {
    logger.info('storage-size job is off (account.storageUsed.intervalHours: 0): storageUsed is not recomputed by the core');
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      const t0 = Date.now();
      computeStorageUsedForAllAccounts(logger)
        .then((r) => logger.info(`storage-size pass: ${r.updated} of ${r.accounts} account(s) updated${r.failed > 0 ? `, ${r.failed} failed` : ''} in ${Date.now() - t0} ms`))
        .catch((err: unknown) => logger.error('storage-size pass failed: ' + (err instanceof Error ? err.message : String(err))))
        .finally(() => schedule(intervalMs));
    }, delayMs);
    timer.unref();
  };
  schedule(options.firstPassDelayMs ?? FIRST_PASS_DELAY_MS);
  logger.info(`storage-size job started: every ${intervalMs / 3600000} h`);
  return {
    stop: () => {
      stopped = true;
      if (timer != null) clearTimeout(timer);
    }
  };
}
