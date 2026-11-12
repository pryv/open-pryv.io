/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * "Is the schema behind the code?" in one place. The boot announcement
 * (`applyOrAnnounce`) and the operator route `GET /system/migrations-status`
 * both derive their answer from this summary, so they cannot disagree.
 */

import type { EngineStatus } from './MigrationRunner.js';

export interface EngineStatusSummary {
  id: string;
  /** Version recorded in the engine's tracking table. */
  currentVersion: number;
  /** Version this code expects: the number of migration files shipped. */
  targetVersion: number;
  /** Filenames of the migrations not applied yet, in order. */
  pending: string[];
}

export interface MigrationStatusSummary {
  /** Migrations not applied yet, all engines together. */
  pending: number;
  upToDate: boolean;
  engines: EngineStatusSummary[];
}

export function summarizeStatus (statuses: EngineStatus[]): MigrationStatusSummary {
  const engines = statuses.map((s) => ({
    id: s.engineId,
    currentVersion: s.currentVersion,
    targetVersion: s.discovered.length,
    pending: s.pending.map((m) => m.filename)
  }));
  const pending = engines.reduce((n, e) => n + e.pending.length, 0);
  return { pending, upToDate: pending === 0, engines };
}
