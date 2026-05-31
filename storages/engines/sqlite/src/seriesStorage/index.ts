/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { SeriesConnectionSQLite } = require('./SeriesConnectionSQLite.ts');

let instance: any = null;

/**
 * SQLite series connection factory. Returns a singleton so callers across
 * the api-server / hfs-server / backup code share one cache of per-user
 * file handles (the `SeriesConnectionSQLite.cache` LRU).
 */
function createSeriesConnection (_config: any): any {
  if (instance == null) instance = new SeriesConnectionSQLite();
  return instance;
}

export { createSeriesConnection };
