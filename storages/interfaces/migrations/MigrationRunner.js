/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Engine-agnostic schema-migration runner.
 *
 * Consumes a list of `MigrationCapableEngine` objects (see `MigrationRunner.d.ts`)
 * and applies each engine's pending migrations in filename order, bumping
 * `schema_migrations.version` by +1 per successful migration.
 *
 * Filename format: `YYYYMMDD_HHMMSS_<slug>.js` — see `README.md`.
 */

const fs = require('fs');
const path = require('path');

class MigrationRunner {
  /**
   * @param {Array} engines - array of MigrationCapableEngine (see .d.ts)
   * @param {Object} [options]
   * @param {Object} [options.logger] - logger with .info/.warn/.error
   */
  constructor (engines, { logger } = {}) {
    this.engines = engines;
    this.logger = logger || { info () {}, warn () {}, error () {}, debug () {} };
  }

  /**
   * @returns {Promise<Array>} per-engine { engineId, currentVersion, discovered, pending }
   */
  async status () {
    const out = [];
    for (const engine of this.engines) {
      const discovered = discoverMigrations(engine.migrationsDir);
      const currentVersion = await engine.getVersion();
      const pending = discovered.filter(m => m.targetVersion > currentVersion);
      out.push({ engineId: engine.id, currentVersion, discovered, pending });
    }
    return out;
  }

  /**
   * Apply pending migrations across all registered engines.
   * @param {Object} [options]
   * @param {number} [options.targetVersion] - stop per-engine at this version
   * @param {boolean} [options.dryRun] - compute plan but do not execute
   * @returns {Promise<Array>} AppliedMigration[]
   */
  async runAll ({ targetVersion, dryRun = false } = {}) {
    const applied = [];
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
        } catch (err) {
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
 *
 * @param {string} dir
 * @returns {Array<{ path, filename, targetVersion, module }>}
 */
function discoverMigrations (dir) {
  if (!fs.existsSync(dir)) return [];
  const filenames = fs.readdirSync(dir)
    .filter(name => name.endsWith('.js') && !name.startsWith('.') && !name.startsWith('_'))
    .sort();
  return filenames.map((filename, idx) => {
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
async function createMigrationRunner ({ logger } = {}) {
  const storages = require('storages');
  const capabilities = [];
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
