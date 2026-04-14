/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { Migration, MigrationContext } from './migration';

/**
 * One migration file on disk, as discovered by the runner.
 */
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

/**
 * What a migration-capable engine must provide to the runner.
 *
 * Each storage engine that wants to participate in the migration system
 * registers itself through its `_internals.migrationsCapability` object.
 */
export interface MigrationCapableEngine {
  /** Human-readable engine identifier, e.g. 'postgresql', 'rqlite'. */
  id: string;
  /** Absolute path to the engine's `migrations/` directory. */
  migrationsDir: string;
  /** Read the engine's current applied-version integer (0 if none). */
  getVersion(): Promise<number>;
  /** Persist the engine's new applied-version integer. Called once per successful migration. */
  setVersion(version: number): Promise<void>;
  /** Build the per-migration context handed to `up()`. */
  buildContext(): MigrationContext;
}

/**
 * Runner status for a single engine.
 */
export interface EngineStatus {
  engineId: string;
  currentVersion: number;
  discovered: DiscoveredMigration[];
  pending: DiscoveredMigration[];
}

/**
 * Runner contract.
 */
export interface MigrationRunner {
  /** Discover migrations for each registered engine and compute pending vs applied. */
  status(): Promise<EngineStatus[]>;
  /**
   * Apply pending migrations across all registered engines.
   * If `targetVersion` is set, stops when each engine reaches it (engines ahead
   * of the target are unaffected).
   * Returns the list of migrations actually applied, in order.
   */
  runAll(options?: { targetVersion?: number; dryRun?: boolean }): Promise<AppliedMigration[]>;
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
