/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);

const { DBrqlite } = require('./DBrqlite.ts');
const { buildMigrationsCapability } = require('./SchemaMigrations.ts');

type PlatformDB = InstanceType<typeof DBrqlite>;
type GetLoggerFn = (name: string) => Logger;
type MigrationsCapability = unknown;

let platformDB: PlatformDB | null = null;
let _getLogger: GetLoggerFn | null = null;

/**
 * Initialize the rqlite engine.
 */
function init (config: { url?: string }, getLogger?: GetLoggerFn): void {
  platformDB = new DBrqlite(config.url);
  if (getLogger) _getLogger = getLogger;
}

/**
 * Create and return the PlatformDB instance.
 */
function createPlatformDB (): PlatformDB {
  if (!platformDB) {
    platformDB = new DBrqlite();
  }
  return platformDB;
}

/**
 * Build the migrations capability for the engine-agnostic MigrationRunner.
 * Returns null when the engine hasn't been initialized yet.
 */
function getMigrationsCapability (): MigrationsCapability | null {
  if (!platformDB) return null;
  return buildMigrationsCapability(platformDB, _getLogger);
}

export { init, createPlatformDB, getMigrationsCapability };
