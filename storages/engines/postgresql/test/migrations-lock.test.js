/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [PGML] Two migration runners on one database (a booting core and
 * `bin/migrate.js up`, two cores) apply each migration once: the runner holds
 * an advisory lock for the whole run and reads the version once it holds it.
 * Each runner has its own DatabasePG (its own pool), as two processes would.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as helpers from '../../../test/helpers/index.js';
import { DatabasePG } from '../src/DatabasePG.ts';
import { buildMigrationsCapability, SchemaMigrationsPG, MIGRATIONS_LOCK_KEY } from '../src/SchemaMigrations.ts';
import { MigrationRunner } from '../../../interfaces/migrations/MigrationRunner.ts';
const require = createRequire(import.meta.url);
const timeIdMigrationPath = require.resolve('../migrations/20261127_130000_time_id_indexes.js');
const timeIdMigration = require(timeIdMigrationPath);

describe('[PGML] PostgreSQL migration runner lock', function () {
  this.timeout(120_000);
  let db, db2, savedVersions, dir;

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await helpers.dependencies.init();
    db = new DatabasePG(helpers.state.config);
    db2 = new DatabasePG(helpers.state.config);
    await db.waitForConnection();
    await db2.waitForConnection();
    await db.initSchema();
    await new SchemaMigrationsPG(db).getVersion(); // creates the table if missing
    savedVersions = (await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version);
    await db.query('CREATE TABLE IF NOT EXISTS pgml_hits (name TEXT NOT NULL)');
  });

  beforeEach(async function () {
    await db.query('DELETE FROM schema_migrations');
    await db.query('DELETE FROM pgml_hits');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgml-'));
  });

  afterEach(function () {
    if (dir != null) fs.rmSync(dir, { recursive: true, force: true });
  });

  after(async function () {
    if (db == null) return;
    await db.query('DELETE FROM schema_migrations');
    for (const v of savedVersions) await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]);
    await db.query('DROP TABLE IF EXISTS pgml_hits');
    await db.close();
    await db2.close();
  });

  /** A migration recording its run, then taking `sleepS` seconds. */
  function writeMigration (filename, name, sleepS = 0.3) {
    fs.writeFileSync(path.join(dir, filename),
      'module.exports = { async up (ctx) {\n' +
      `  await ctx.db.query('INSERT INTO pgml_hits (name) VALUES ($1)', [${JSON.stringify(name)}]);\n` +
      `  await ctx.db.query('SELECT pg_sleep(${sleepS})');\n` +
      '} };\n');
  }

  function runnerOn (database) {
    return new MigrationRunner([{ ...buildMigrationsCapability(database), migrationsDir: dir }]);
  }

  async function hits () {
    const res = await db.query('SELECT name, count(*)::int AS n FROM pgml_hits GROUP BY name ORDER BY name');
    return Object.fromEntries(res.rows.map(r => [r.name, r.n]));
  }

  async function version () {
    return await new SchemaMigrationsPG(db).getVersion();
  }

  it('[PGML1] two runners at once apply each migration exactly once', async function () {
    writeMigration('20260101_100000_a.js', 'a');
    writeMigration('20260101_110000_b.js', 'b');
    writeMigration('20260101_120000_c.js', 'c');

    const [appliedA, appliedB] = await Promise.all([runnerOn(db).runAll(), runnerOn(db2).runAll()]);

    assert.deepStrictEqual(await hits(), { a: 1, b: 1, c: 1 });
    assert.deepStrictEqual([appliedA.length, appliedB.length].sort(), [0, 3],
      'one runner applies all three, the other finds them applied');
    assert.strictEqual(await version(), 3);
  });

  it('[PGML2] a runner waits while another session holds the lock, then applies what is left', async function () {
    writeMigration('20260101_100000_a.js', 'a', 0);
    writeMigration('20260101_110000_b.js', 'b', 0);

    const holder = await db2.getClient();
    let released = false;
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_LOCK_KEY]);
      const run = runnerOn(db).runAll();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.deepStrictEqual(await hits(), {}, 'nothing applied while the lock is held');
      assert.strictEqual(await version(), 0);
      // The holder applied the first one meanwhile.
      await db.query('INSERT INTO pgml_hits (name) VALUES ($1)', ['a']);
      await new SchemaMigrationsPG(db).setVersion(1);
      await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK_KEY]);
      holder.release();
      released = true;
      const applied = await run;
      assert.deepStrictEqual(applied.map(a => a.filename), ['20260101_110000_b.js'],
        'the version is read once the lock is held');
    } finally {
      if (!released) holder.release();
    }
    assert.deepStrictEqual(await hits(), { a: 1, b: 1 });
    assert.strictEqual(await version(), 2);
  });

  it('[PGML3] a migration taking its own advisory lock and building indexes CONCURRENTLY runs once under it, no deadlock', async function () {
    const userId = 'pgml-' + Date.now();
    await db.query('INSERT INTO users_index (username, user_id) VALUES ($1, $1)', [userId]);
    try {
      // Enough rows for each build to last while the other runner polls.
      await db.query(
        'INSERT INTO events (user_id, id, stream_ids, type, time, created, modified) ' +
        "SELECT $1, 'pgml-e' || g, '[\"s\"]', 'note/txt', g, g, g FROM generate_series(1, 100000) g", [userId]);
      await db.query(
        'INSERT INTO audit_events (user_id, eventid, stream_ids, type, time, created, modified) ' +
        "SELECT $1, 'pgml-a' || g, ':_audit:x', 'audit-log/pryv-api', g, g, g FROM generate_series(1, 100000) g", [userId]);
      await db.query('DROP INDEX IF EXISTS idx_event_time_id');
      await db.query('DROP INDEX IF EXISTS idx_audit_time_id');
      await db.query('CREATE INDEX IF NOT EXISTS idx_event_time ON events(user_id, time)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(user_id, time)');
      fs.writeFileSync(path.join(dir, '20260101_100000_time_id.js'),
        `const real = require(${JSON.stringify(timeIdMigrationPath)});\n` +
        'module.exports = { async up (ctx) {\n' +
        "  await ctx.db.query('INSERT INTO pgml_hits (name) VALUES ($1)', ['time-id']);\n" +
        '  await real.up(ctx);\n' +
        '} };\n');

      const [appliedA, appliedB] = await Promise.all([runnerOn(db).runAll(), runnerOn(db2).runAll()]);

      assert.deepStrictEqual(await hits(), { 'time-id': 1 });
      assert.deepStrictEqual([appliedA.length, appliedB.length].sort(), [0, 1]);
      for (const name of ['idx_event_time_id', 'idx_audit_time_id']) {
        const res = await db.query('SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)', [name]);
        assert.strictEqual(res.rows[0]?.valid, true, `${name} valid`);
      }
      for (const name of ['idx_event_time', 'idx_audit_time']) {
        const res = await db.query('SELECT to_regclass($1) IS NULL AS gone', [name]);
        assert.strictEqual(res.rows[0].gone, true, `${name} dropped`);
      }
    } finally {
      await db.query('DELETE FROM events WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM audit_events WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM users_index WHERE user_id = $1', [userId]);
      await timeIdMigration.up({ db });
    }
  });
});
