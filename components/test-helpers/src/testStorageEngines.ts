/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The storage engines a test run selects (`STORAGE_ENGINE`, set by the
 * `test` / `test-sqlite` recipes), applied to the test process and handed
 * over to the processes a test starts.
 */

const ENGINE_KINDS = ['base', 'series', 'file', 'audit'];

/**
 * Apply `STORAGE_ENGINE=sqlite` to this process's config: SQLite base
 * storage, series following the base engine unless `storages__series__engine`
 * says otherwise, file storage from `storages__file__engine` (default
 * filesystem). Set in the memory scope, so `injectTestConfig` resets keep it.
 *
 * Call it right after `boiler.init()` and before any storage initialises.
 * Under `STORAGE_ENGINE=postgresql` it changes nothing: PostgreSQL is the
 * default engine.
 */
export function applyTestStorageEngine (): void {
  if (process.env.STORAGE_ENGINE !== 'sqlite') return;
  const { getConfigUnsafe } = require('@pryv/boiler');
  const { resolveTestFileEngine } = require('./resolveTestFileEngine.ts');
  const { resolveTestSeriesEngine } = require('./resolveTestSeriesEngine.ts');
  const cfg = getConfigUnsafe(true);
  cfg.set('storages:base:engine', 'sqlite');
  cfg.set('storages:series:engine', resolveTestSeriesEngine('sqlite'));
  // Honour `storages__file__engine` over the 'filesystem' default so this
  // memory-scope value agrees with the env source forked children read.
  cfg.set('storages:file:engine', resolveTestFileEngine());
}

/**
 * Environment variables that make a separate process (a `bin/` tool run by a
 * test) use the same storage engines as this test process.
 *
 * The test process holds its engines in the memory config scope, which a
 * child process never sees: it reads the config files and its environment
 * only, so without these it would run on the default engines while the test
 * fixtures live elsewhere.
 */
export function childStorageEngineEnv (): Record<string, string> {
  const { getConfigUnsafe } = require('@pryv/boiler');
  const config = getConfigUnsafe(true);
  const env: Record<string, string> = {};
  for (const kind of ENGINE_KINDS) {
    const engine = config.get('storages:' + kind + ':engine');
    if (engine != null) env['storages__' + kind + '__engine'] = String(engine);
  }
  return env;
}

export default { applyTestStorageEngine, childStorageEngineEnv };
