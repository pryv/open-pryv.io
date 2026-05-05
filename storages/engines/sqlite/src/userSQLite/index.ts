/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { SqliteStorage } = require('./Storage');

const storages: Record<string, any> = {};

async function getStorage (name: string): Promise<any> {
  if (!storages[name]) {
    storages[name] = new SqliteStorage(name);
    await storages[name].init();
  }
  return storages[name];
}

function closeStorage (name: string): void {
  if (storages[name]) {
    storages[name].close();
    delete storages[name];
  }
}

export { getStorage, closeStorage };
