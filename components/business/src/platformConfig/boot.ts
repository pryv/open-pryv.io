/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { loadScope, startPolling } from './index.ts';
import type { ScopedConfig, KvStore } from './index.ts';

/**
 * Boot step of the platform-wide configuration held in the platform store,
 * run by each process that reads a store-backed key, after the storages are
 * ready and before it serves: loads the store's rows into the configuration,
 * then (`poll`, the default) checks for a change every
 * `platform.configPollSeconds` and reloads on a message of a sibling worker.
 *
 * A platform store that does not answer at boot leaves the local values in
 * force; the periodic check loads the rows once it answers.
 */

type LoggerLike = { info: (msg: string) => void; warn: (msg: string) => void };

/** The IPC message a worker sends after a write (the master relays it to the other workers). */
export const IPC_INVALIDATE = 'platform-config:invalidate';

let stopPolling: (() => void) | null = null;
let ipcInstalled = false;

/** This core's id, as the platform names it. */
export function coreIdOf (config: Pick<ScopedConfig, 'get'>): string {
  return (config.get('core:id') as string) || 'single';
}

async function platformDB (): Promise<KvStore> {
  // Loaded when the boot step runs (the storages are initialised by then).
  return (await import('storages')).platformDB as KvStore;
}

export async function runPlatformConfigBoot (opts: { config: ScopedConfig; logger: LoggerLike; db?: KvStore; poll?: boolean }): Promise<void> {
  const { config, logger } = opts;
  const db = opts.db ?? await platformDB();
  const coreId = coreIdOf(config);
  try {
    const state = await loadScope(config, db, coreId);
    if (state.keys.length > 0) logger.info(`[platform-config] revision ${state.rev}: ${state.keys.join(', ')} from the platform store`);
  } catch (err) {
    logger.warn('[platform-config] the platform store did not answer: the local values stay until the next check (' + (err as Error).message + ')');
  }
  if (opts.poll === false) return;
  if (stopPolling == null) stopPolling = startPolling(config, db, coreId);
  installIpcReload(config, db, coreId, logger);
}

/** Stops the periodic check of this process (tests, shutdown). */
export function stopPlatformConfigPolling (): void {
  if (stopPolling != null) stopPolling();
  stopPolling = null;
}

function installIpcReload (config: ScopedConfig, db: KvStore, coreId: string, logger: LoggerLike): void {
  if (ipcInstalled || typeof process.send !== 'function') return;
  ipcInstalled = true;
  process.on('message', (msg: unknown) => {
    if (msg == null || typeof msg !== 'object' || (msg as { type?: unknown }).type !== IPC_INVALIDATE) return;
    loadScope(config, db, coreId).catch((err: Error) => {
      logger.warn('[platform-config] reload after a change on this core failed (the next check retries): ' + err.message);
    });
  });
}

/**
 * After a write by this process: reload its scope, then tell the other
 * workers of this core. Other cores learn it at their next check.
 */
export async function reloadAfterWrite (config: ScopedConfig, db: KvStore): Promise<void> {
  await loadScope(config, db, coreIdOf(config));
  if (typeof process.send === 'function') {
    try { process.send({ type: IPC_INVALIDATE }); } catch { /* master not attached */ }
  }
}
