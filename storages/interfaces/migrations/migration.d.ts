/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Per-engine migration module shape.
 *
 * A migration file lives at `storages/engines/<engine>/migrations/<YYYYMMDD_HHMMSS>_<slug>.js`
 * and exports (at minimum) an `up` function. `down` is allowed but the
 * runner ignores it (forward-only policy — to undo a migration, write a
 * new forward migration that fixes it).
 *
 * Invariants:
 * - `up` MUST be idempotent. Runner will call it at most once per version
 *   bump, but a crashed run that left `schema_migrations.version` un-bumped
 *   will cause the next run to call `up` again.
 * - `up` SHOULD use DDL-in-transaction semantics where the engine supports
 *   it (PostgreSQL: yes; rqlite: single-statement atomicity only; MongoDB:
 *   no DDL transactions — design idempotent queries instead).
 */

export interface MigrationContext {
  /** Engine-provided database handle. Shape differs per engine. */
  db: any;
  /** Engine-provided logger. */
  logger: { debug: (m: string) => void; info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

export interface Migration {
  up: (context: MigrationContext) => Promise<void>;
  down?: (context: MigrationContext) => Promise<void>;
}
