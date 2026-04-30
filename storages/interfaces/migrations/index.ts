/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Barrel for the migrations primitive.
 *
 * - Contracts (TS interfaces) live inline in `MigrationRunner.ts` and `migration.d.ts`.
 * - Conventions (filename format, version model, engine responsibilities)
 *   are documented in `README.md`.
 */

const { MigrationRunner, discoverMigrations, createMigrationRunner } = require('./MigrationRunner');

module.exports = {
  MigrationRunner,
  discoverMigrations,
  createMigrationRunner
};
