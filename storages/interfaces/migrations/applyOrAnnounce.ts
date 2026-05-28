/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Boot-time migration policy: apply pending migrations, or announce that
 * they were skipped.
 *
 * Lives apart from `MigrationRunner` so the announce path stays unit-testable
 * with a fake runner — no engines, no DB, no master process.
 *
 * Behaviour matrix:
 *
 *  | autoRun | pending     | log level | shape                              |
 *  |---------|-------------|-----------|------------------------------------|
 *  | true    | any         | info      | (existing master.js boot output)   |
 *  | false   | none        | info      | 1 line: "Migrations skipped …"     |
 *  | false   | >= 1        | warn      | summary + per-engine WARNING lines |
 *
 * The warning is deliberately loud — a demo deploy outage was caused
 * by pending access-versioning migrations being silently skipped
 * because `migrations:autoRunOnStart` was false in the operator's
 * override.
 */

import type { AppliedMigration, EngineStatus } from './MigrationRunner.js';

export interface ApplyOrAnnounceLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface ApplyOrAnnounceRunner {
  runAll: () => Promise<AppliedMigration[]>;
  status: () => Promise<EngineStatus[]>;
}

export interface ApplyOrAnnounceResult {
  /** `applied` when migrations were executed (autoRun=true), `skipped` otherwise. */
  mode: 'applied' | 'skipped';
  /** Migrations executed this call. Empty when mode === 'skipped'. */
  applied: AppliedMigration[];
  /** Engines with at least one pending migration. Empty when mode === 'applied'. */
  pending: EngineStatus[];
}

export async function applyOrAnnounce ({
  runner,
  logger,
  autoRun
}: {
  runner: ApplyOrAnnounceRunner;
  logger: ApplyOrAnnounceLogger;
  autoRun: boolean;
}): Promise<ApplyOrAnnounceResult> {
  if (autoRun) {
    logger.info('Running pending schema migrations...');
    const applied = await runner.runAll();
    if (applied.length === 0) {
      logger.info('No pending migrations.');
    } else {
      for (const m of applied) {
        logger.info(`  ${m.engineId}: ${m.filename} (→ v${m.toVersion}, ${m.durationMs}ms)`);
      }
      logger.info(`Applied ${applied.length} migration(s).`);
    }
    return { mode: 'applied', applied, pending: [] };
  }

  const statuses = await runner.status();
  const enginesWithPending = statuses.filter(s => s.pending.length > 0);
  const pendingCount = enginesWithPending.reduce((n, s) => n + s.pending.length, 0);

  if (pendingCount === 0) {
    logger.info('Migrations skipped (autoRunOnStart=false); no pending migrations.');
  } else {
    logger.warn(
      `Migrations skipped (autoRunOnStart=false) but ${pendingCount} pending migration(s) across ` +
      `${enginesWithPending.length} engine(s) — server may serve errors on schema-dependent ` +
      'endpoints. Run `node bin/migrate.js up` to apply.'
    );
    for (const s of enginesWithPending) {
      const fnames = s.pending.map(p => p.filename).join(', ');
      logger.warn(`  ${s.engineId}: at v${s.currentVersion}, pending: ${fnames}`);
    }
  }

  return { mode: 'skipped', applied: [], pending: enginesWithPending };
}
