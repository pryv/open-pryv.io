/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The core's outbox of revoke notices from deleted accounts, from the base
 * storage engine (one instance per process, created on first use).
 */

import { pluginLoader } from 'storages';
import { validateDeletionNoticesLocalDB } from 'storages/interfaces/baseStorage/DeletionNoticesLocalDB.ts';
import type { DeletionNoticesLocalDB } from 'storages/interfaces/baseStorage/DeletionNoticesLocalDB.ts';

let instance: Promise<DeletionNoticesLocalDB> | null = null;

async function create (): Promise<DeletionNoticesLocalDB> {
  const engine: string | null = pluginLoader.getEngineFor('baseStorage');
  if (engine == null) throw new Error('deletion notices: no baseStorage engine (storages.init() not run?)');
  const engineModule = pluginLoader.getEngineModule(engine) as { getDeletionNoticesLocal: () => new () => DeletionNoticesLocalDB };
  const Cls = engineModule.getDeletionNoticesLocal();
  const db = new Cls();
  await db.init();
  return validateDeletionNoticesLocalDB(db);
}

export function getDeletionNoticesLocal (): Promise<DeletionNoticesLocalDB> {
  if (instance == null) {
    instance = create();
    instance.catch(() => { instance = null; });
  }
  return instance;
}
