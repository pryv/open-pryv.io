/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { DBrqlite } = require('./DBrqlite');
const { buildMigrationsCapability } = require('./SchemaMigrations');

let platformDB: any = null;
let _getLogger: ((name: string) => any) | null = null;

/**
 * Initialize the rqlite engine.
 */
function init (config: { url?: string }, getLogger?: (name: string) => any): void {
  platformDB = new DBrqlite(config.url);
  if (getLogger) _getLogger = getLogger;
}

/**
 * Create and return the PlatformDB instance.
 */
function createPlatformDB (): any {
  if (!platformDB) {
    platformDB = new DBrqlite();
  }
  return platformDB;
}

/**
 * Build the migrations capability for the engine-agnostic MigrationRunner.
 * Returns null when the engine hasn't been initialized yet.
 */
function getMigrationsCapability (): any | null {
  if (!platformDB) return null;
  return buildMigrationsCapability(platformDB, _getLogger);
}

export { init, createPlatformDB, getMigrationsCapability };
