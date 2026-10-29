/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The core's record of account erasures in progress, from the base storage
 * engine (one instance per process, created on first use). See
 * `storages/interfaces/baseStorage/ErasuresLocalDB.ts`.
 */

import { pluginLoader } from 'storages';
import { validateErasuresLocalDB } from 'storages/interfaces/baseStorage/ErasuresLocalDB.ts';
import type { ErasuresLocalDB } from 'storages/interfaces/baseStorage/ErasuresLocalDB.ts';

/**
 * A record whose `updatedAt` did not move for this long belongs to an erasure
 * that stopped (a failed step, a crash): it may be completed. A running
 * erasure refreshes it every `ERASURE_HEARTBEAT_MS`, even inside a long step.
 */
export const STALE_ERASURE_MS = 15 * 60 * 1000;
export const ERASURE_HEARTBEAT_MS = 60 * 1000;

let instance: Promise<ErasuresLocalDB> | null = null;

async function create (): Promise<ErasuresLocalDB> {
  const engine: string | null = pluginLoader.getEngineFor('baseStorage');
  if (engine == null) throw new Error('account erasures: no baseStorage engine (storages.init() not run?)');
  const engineModule = pluginLoader.getEngineModule(engine) as { getErasuresLocal: () => new () => ErasuresLocalDB };
  const Cls = engineModule.getErasuresLocal();
  const db = new Cls();
  await db.init();
  return validateErasuresLocalDB(db);
}

export function getErasuresLocal (): Promise<ErasuresLocalDB> {
  if (instance == null) {
    instance = create();
    instance.catch(() => { instance = null; });
  }
  return instance;
}
