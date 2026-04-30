/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Engine-agnostic schema-migration runner.
 *
 * Consumes a list of `MigrationCapableEngine` objects and applies each
 * engine's pending migrations in filename order, bumping
 * `schema_migrations.version` by +1 per successful migration.
 *
 * Filename format: `YYYYMMDD_HHMMSS_<slug>.js` — see `README.md`.
 */

import type { Migration, MigrationContext } from './migration';

const fs = require('fs');
const path = require('path');

export interface DiscoveredMigration {
  /** Absolute path to the file. */
  path: string;
  /** Bare filename, e.g. `20260414_143022_add_access_hash.js`. */
  filename: string;
  /** 1-based position after lex-sort. Equals the version it takes the engine to. */
  targetVersion: number;
  /** Loaded module. */
  module: Migration;
}

export interface MigrationCapableEngine {
  id: string;
  migrationsDir: string;
  getVersion (): Promise<number>;
  setVersion (version: number): Promise<void>;
  buildContext (): MigrationContext;
}

export interface EngineStatus {
  engineId: string;
  currentVersion: number;
  discovered: DiscoveredMigration[];
  pending: DiscoveredMigration[];
}

export interface AppliedMigration {
  engineId: string;
  filename: string;
  fromVersion: number;
  toVersion: number;
  /** Milliseconds spent inside `up()`. */
  durationMs: number;
  /** True when invoked with `dryRun: true` — migration was not actually executed. */
  dryRun: boolean;
}

interface RunOptions { targetVersion?: number; dryRun?: boolean }
interface RunnerOptions { logger?: { debug?: Function; info?: Function; warn?: Function; error?: Function } }

class MigrationRunner {
  engines: MigrationCapableEngine[];
  logger: { info: Function; warn: Function; error: Function; debug: Function };

  constructor (engines: MigrationCapableEngine[], { logger }: RunnerOptions = {}) {
    this.engines = engines;
    this.logger = (logger as any) || { info () {}, warn () {}, error () {}, debug () {} };
  }

  async status (): Promise<EngineStatus[]> {
    const out: EngineStatus[] = [];
    for (const engine of this.engines) {
      const discovered = discoverMigrations(engine.migrationsDir);
      const currentVersion = await engine.getVersion();
      const pending = discovered.filter(m => m.targetVersion > currentVersion);
      out.push({ engineId: engine.id, currentVersion, discovered, pending });
    }
    return out;
  }

  async runAll ({ targetVersion, dryRun = false }: RunOptions = {}): Promise<AppliedMigration[]> {
    const applied: AppliedMigration[] = [];
    for (const engine of this.engines) {
      const discovered = discoverMigrations(engine.migrationsDir);
      let current = await engine.getVersion();
      const cap = targetVersion ?? Number.POSITIVE_INFINITY;

      for (const migration of discovered) {
        if (migration.targetVersion <= current) continue;
        if (migration.targetVersion > cap) break;

        if (dryRun) {
          applied.push({
            engineId: engine.id,
            filename: migration.filename,
            fromVersion: current,
            toVersion: migration.targetVersion,
            durationMs: 0,
            dryRun: true
          });
          current = migration.targetVersion;
          continue;
        }

        this.logger.info(`[migrations] ${engine.id}: applying ${migration.filename} (→ v${migration.targetVersion})`);
        const ctx = engine.buildContext();
        const t0 = Date.now();
        try {
          await migration.module.up(ctx);
        } catch (err: any) {
          this.logger.error(`[migrations] ${engine.id}: ${migration.filename} FAILED: ${err.message}`);
          throw err;
        }
        const durationMs = Date.now() - t0;
        await engine.setVersion(migration.targetVersion);
        current = migration.targetVersion;
        applied.push({
          engineId: engine.id,
          filename: migration.filename,
          fromVersion: current - 1,
          toVersion: current,
          durationMs,
          dryRun: false
        });
        this.logger.info(`[migrations] ${engine.id}: ${migration.filename} applied in ${durationMs}ms`);
      }
    }
    return applied;
  }
}

/**
 * Discover migration files in a directory and return them lex-sorted.
 * Each file's `targetVersion` is its 1-based position in the sort.
 * Returns [] if the directory is missing or contains no .js files.
 */
function discoverMigrations (dir: string): DiscoveredMigration[] {
  if (!fs.existsSync(dir)) return [];
  const filenames: string[] = fs.readdirSync(dir)
    .filter((name: string) => name.endsWith('.js') && !name.startsWith('.') && !name.startsWith('_'))
    .sort();
  return filenames.map((filename: string, idx: number) => {
    const filepath = path.join(dir, filename);

    const mod = require(filepath);
    if (typeof mod.up !== 'function') {
      throw new Error(`Migration ${filepath} must export an 'up' function`);
    }
    return {
      path: filepath,
      filename,
      targetVersion: idx + 1,
      module: mod
    };
  });
}

/**
 * Build a runner from the storages barrel's active engines.
 * Each engine that exports `getMigrationsCapability()` and returns a non-null
 * capability participates.
 */
async function createMigrationRunner ({ logger }: RunnerOptions = {}): Promise<MigrationRunner> {
  const storages = require('storages');
  const capabilities: MigrationCapableEngine[] = [];
  for (const engineName of storages.pluginLoader.listEngines()) {
    const mod = storages.pluginLoader.getEngineModule(engineName);
    if (typeof mod.getMigrationsCapability !== 'function') continue;
    const cap = mod.getMigrationsCapability();
    if (cap) capabilities.push(cap);
  }
  return new MigrationRunner(capabilities, { logger });
}

module.exports = {
  MigrationRunner,
  discoverMigrations,
  createMigrationRunner
};
