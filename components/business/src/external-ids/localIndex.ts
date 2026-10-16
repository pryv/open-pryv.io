/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The home core's external-ids table, from the base storage engine (one
 * instance per process, created on first use).
 */

import { pluginLoader } from 'storages';
import { validateExternalIdsLocalDB } from 'storages/interfaces/baseStorage/ExternalIdsLocalDB.ts';
import type { ExternalIdsLocalDB } from 'storages/interfaces/baseStorage/ExternalIdsLocalDB.ts';

let instance: Promise<ExternalIdsLocalDB> | null = null;

async function create (): Promise<ExternalIdsLocalDB> {
  const engine: string | null = pluginLoader.getEngineFor('baseStorage');
  if (engine == null) throw new Error('external ids: no baseStorage engine (storages.init() not run?)');
  const engineModule = pluginLoader.getEngineModule(engine) as { getExternalIdsLocal: () => new () => ExternalIdsLocalDB };
  const Cls = engineModule.getExternalIdsLocal();
  const db = new Cls();
  await db.init();
  return validateExternalIdsLocalDB(db);
}

export function getExternalIdsLocal (): Promise<ExternalIdsLocalDB> {
  if (instance == null) {
    instance = create();
    instance.catch(() => { instance = null; });
  }
  return instance;
}
