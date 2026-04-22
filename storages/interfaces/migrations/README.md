# Storage migrations — primitive

Engine-agnostic schema/data migration runner for v2. Replaces the legacy MongoDB-specific `Versions` scheme.

## Scope

- **What this handles:** runtime data and schema evolution inside a single engine (e.g. PostgreSQL `ALTER TABLE`, MongoDB `updateMany`, rqlite new key schemas).
- **What this doesn't handle:** boot-time engine-plugin compatibility with the host's interface contracts — that's `_plans/XXX-Backlog/INTERFACE-VERSIONING.md`.
- **v1 → v2 migration is not an in-place upgrade.** It goes: bring to v1.9.3 on the `release/1.9.3` branch → export via `dev-migrate-v1-v2` → `bin/backup.js --restore` into v2.

## Version model

- Each engine holds a single integer `version`, starting at 0.
- Each applied migration bumps it by exactly +1.
- Migrations are applied strictly in filename order — **no gaps, no branches, no merge numbers**.

## Filename format

`YYYYMMDD_HHMMSS_<slug>.js`

Examples:
- `20260414_143022_add_events_access_hash.js`
- `20260501_091200_rename_platform_key.js`

**Why timestamps:** branch-safe. Two parallel feature branches generate files that never lex-collide (unless two people commit in the same second — acceptable).

**Second resolution is enough.** Do not pad to milliseconds. Use UTC.

## Migration file shape

```js
// storages/engines/<engine>/migrations/YYYYMMDD_HHMMSS_slug.js
'use strict';

module.exports = {
  async up (context) {
    // context.db     — engine-specific database handle
    // context.logger — scoped logger
    await context.db.query('ALTER TABLE events ADD COLUMN IF NOT EXISTS access_hash TEXT');
  }
  // down() is allowed at the contract level but the runner ignores it.
};
```

## Invariants a migration author must respect

1. **Idempotent.** The runner bumps `schema_migrations.version` only after a successful `up()`. A crash mid-migration leaves the version un-bumped and the next run calls `up()` again — it must tolerate partial application.
2. **No cross-engine assumptions.** A migration file under `storages/engines/postgresql/` runs against PG only; the same change in rqlite needs its own file in `storages/engines/rqlite/migrations/`.
3. **Additive where possible.** Prefer `ADD COLUMN`, backfill with a separate later migration, then drop-old in yet another — three small migrations are better than one clever one.
4. **No data loss without explicit approval.** Migrations that drop columns, rename collections, or rewrite rows need a PR-level decision.
5. **No `down()`.** Forward-only. If a migration was wrong, write a new forward migration that corrects it. The field exists in the contract for future optionality but the runner does not execute it.

## Engine responsibilities

A migration-capable engine registers a capability object through its `_internals` wired by the storages barrel:

```js
_internals.migrationsCapability = {
  id: 'postgresql',
  migrationsDir: path.join(__dirname, '..', 'migrations'),
  async getVersion () { /* read from schema_migrations */ },
  async setVersion (v) { /* write schema_migrations */ },
  buildContext () { return { db: <handle>, logger: <scoped> }; }
};
```

### `schema_migrations` tracking

- **PostgreSQL**: single-row table
  ```sql
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ```
  Current version = `SELECT MAX(version) FROM schema_migrations`. One row per applied migration so we keep a history; `version = 0` means no rows.
- **rqlite**: one row in the existing `keyValue` table under key `migrations/version` holding JSON `{ version, updated_at }`.

MongoDB does not participate in the v2 primitive — if migrations are ever needed there, add a `schema_migrations` collection following the same shape.

## Runner behaviour

1. For each registered engine:
   - Discover all migration files in `migrationsDir`.
   - Lex-sort by filename.
   - Each file's target version equals its 1-based position (first file → version 1).
   - `pending = files[currentVersion..]`.
2. For each pending migration (in order):
   - Call `up(buildContext())`.
   - On success, `setVersion(targetVersion)`.
   - On failure, rethrow — runner stops, subsequent engines are not processed.

`runAll({ targetVersion })` stops per-engine at the named target. Engines already at or past the target are left alone.

`runAll({ dryRun: true })` computes and returns the list of migrations that would run without executing anything.

## Automatic execution

`bin/master.js` calls `runner.runAll()` before forking workers when `migrations.autoRunOnStart` is `true` (default). Set to `false` to operate migrations manually with `bin/migrate.js`.

## CLI

```bash
node bin/migrate.js status             # print per-engine version + pending
node bin/migrate.js up                 # apply all pending
node bin/migrate.js up --dry-run       # preview
node bin/migrate.js up --target 3      # stop per-engine at version 3
```

No `down` subcommand. Forward-only by design.

## Concurrent cores

Multi-core deployments with a shared PG: the first core to boot wins the migration race via a PG advisory lock the runner acquires during `runAll()`. Other cores block on the lock then observe `version` already at target and no-op.

Multi-core with rqlite: Raft serializes writes, so the first SET wins; re-reads by other cores see the bumped version.

## Not in scope

- Rollback (`down`) runtime
- DDL helpers (write raw SQL, it's clearer)
- Generating migration files from a CLI (just create the file with the right timestamp)
- SQLite user-DB migrations (per-user, separate mechanism)


# License

[BSD-3-Clause](LICENSE)
