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
 * The versions are kept in a table of the test (the real `schema_migrations`
 * is left alone); the lock is the real one.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as helpers from '../../../test/helpers/index.js';
import { DatabasePG } from '../src/DatabasePG.ts';
import { buildMigrationsCapability, withMigrationsLock, MIGRATIONS_LOCK_KEY, LOCK_APPLICATION_NAME } from '../src/SchemaMigrations.ts';
import { MigrationRunner } from '../../../interfaces/migrations/MigrationRunner.ts';
const require = createRequire(import.meta.url);
const timeIdMigrationPath = require.resolve('../migrations/20261127_130000_time_id_indexes.js');
const timeIdMigration = require(timeIdMigrationPath);

describe('[PGML] PostgreSQL migration runner lock', function () {
  this.timeout(120_000);
  let db, db2, dir;

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await helpers.dependencies.init();
    db = new DatabasePG(helpers.state.config);
    db2 = new DatabasePG(helpers.state.config);
    await db.waitForConnection();
    await db2.waitForConnection();
    await db.initSchema();
    await db.query('CREATE TABLE IF NOT EXISTS pgml_hits (name TEXT NOT NULL)');
    await db.query('CREATE TABLE IF NOT EXISTS pgml_versions (version INTEGER PRIMARY KEY)');
  });

  beforeEach(async function () {
    await db.query('DELETE FROM pgml_versions');
    await db.query('DELETE FROM pgml_hits');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgml-'));
  });

  afterEach(function () {
    if (dir != null) fs.rmSync(dir, { recursive: true, force: true });
  });

  after(async function () {
    if (db == null) return;
    await db.query('DROP TABLE IF EXISTS pgml_hits');
    await db.query('DROP TABLE IF EXISTS pgml_versions');
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

  function storeOn (database) {
    return {
      getVersion: async () => (await database.query('SELECT COALESCE(MAX(version), 0)::int AS v FROM pgml_versions')).rows[0].v,
      setVersion: async (v) => { await database.query('INSERT INTO pgml_versions (version) VALUES ($1) ON CONFLICT DO NOTHING', [v]); }
    };
  }

  /** A runner on `database`; with `log`, the lock logs there. */
  function runnerOn (database, log) {
    const cap = { ...buildMigrationsCapability(database), migrationsDir: dir, ...storeOn(database) };
    if (log != null) cap.withLock = (fn) => withMigrationsLock(database, fn, log);
    return new MigrationRunner([cap]);
  }

  function captureLog () {
    const lines = { info: [], warn: [] };
    return { lines, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) };
  }

  async function hits () {
    const res = await db.query('SELECT name, count(*)::int AS n FROM pgml_hits GROUP BY name ORDER BY name');
    return Object.fromEntries(res.rows.map(r => [r.name, r.n]));
  }

  async function version () {
    return await storeOn(db).getVersion();
  }

  /** Granted advisory locks of the runner's key in this database. */
  async function lockHolders () {
    const res = await db.query(
      "SELECT l.pid FROM pg_locks l WHERE l.locktype = 'advisory' AND l.granted " +
      'AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) ' +
      'AND ((l.classid::bigint << 32) | l.objid::bigint) = $1::bigint AND l.objsubid = 1', [MIGRATIONS_LOCK_KEY]);
    return res.rows.map(r => r.pid);
  }

  /** A pooled client of `db2` holding the runner's lock, and its backend pid. */
  async function holdLock () {
    const client = await db2.getClient();
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_LOCK_KEY]);
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return { client, pid };
  }

  it('[PGML1] two runners at once apply each migration exactly once, and leave no lock behind', async function () {
    writeMigration('20260101_100000_a.js', 'a');
    writeMigration('20260101_110000_b.js', 'b');
    writeMigration('20260101_120000_c.js', 'c');

    const [appliedA, appliedB] = await Promise.all([runnerOn(db).runAll(), runnerOn(db2).runAll()]);

    assert.deepStrictEqual(await hits(), { a: 1, b: 1, c: 1 });
    assert.deepStrictEqual([appliedA.length, appliedB.length].sort(), [0, 3],
      'one runner applies all three, the other finds them applied');
    assert.strictEqual(await version(), 3);
    assert.deepStrictEqual(await lockHolders(), [], 'no advisory lock left once the runs are over');
  });

  it('[PGML2] a runner waits while another session holds the lock, then applies what is left', async function () {
    writeMigration('20260101_100000_a.js', 'a', 0);
    writeMigration('20260101_110000_b.js', 'b', 0);

    const holder = await holdLock();
    let released = false;
    try {
      const run = runnerOn(db).runAll();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.deepStrictEqual(await hits(), {}, 'nothing applied while the lock is held');
      assert.strictEqual(await version(), 0);
      // The holder applied the first one meanwhile.
      await db.query('INSERT INTO pgml_hits (name) VALUES ($1)', ['a']);
      await storeOn(db).setVersion(1);
      await holder.client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK_KEY]);
      holder.client.release();
      released = true;
      const applied = await run;
      assert.deepStrictEqual(applied.map(a => a.filename), ['20260101_110000_b.js'],
        'the version is read once the lock is held');
    } finally {
      if (!released) holder.client.release();
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

  it('[PGML4] a migration that throws releases the lock; the next run retries it and goes on', async function () {
    writeMigration('20260101_100000_a.js', 'a', 0);
    fs.writeFileSync(path.join(dir, '20260101_110000_b.js'),
      'module.exports = { async up (ctx) {\n' +
      "  if (!global.__PGML4_OK) throw new Error('pgml4 boom');\n" +
      "  await ctx.db.query('INSERT INTO pgml_hits (name) VALUES ($1)', ['b']);\n" +
      '} };\n');
    try {
      await assert.rejects(runnerOn(db).runAll(), /pgml4 boom/);
      assert.deepStrictEqual(await lockHolders(), [], 'the lock is released after the failure');
      assert.strictEqual(await version(), 1, 'the migration before the failing one stays applied');

      global.__PGML4_OK = true;
      const applied = await runnerOn(db2).runAll();
      assert.deepStrictEqual(applied.map(a => a.filename), ['20260101_110000_b.js']);
    } finally {
      delete global.__PGML4_OK;
    }
    assert.deepStrictEqual(await hits(), { a: 1, b: 1 });
    assert.strictEqual(await version(), 2);
    assert.deepStrictEqual(await lockHolders(), []);
  });

  it('[PGML5] the dry run does not wait while another session holds the lock', async function () {
    writeMigration('20260101_100000_a.js', 'a', 0);
    const holder = await holdLock();
    try {
      const t0 = Date.now();
      const planned = await runnerOn(db).runAll({ dryRun: true });
      assert.ok(Date.now() - t0 < 2000, 'the dry run returns without waiting for the lock');
      assert.deepStrictEqual(planned.map(a => [a.filename, a.dryRun]), [['20260101_100000_a.js', true]]);
    } finally {
      holder.client.release();
    }
    assert.deepStrictEqual(await hits(), {});
  });

  it('[PGML6] the holder\'s backend ended: the waiting runner goes on', async function () {
    writeMigration('20260101_100000_a.js', 'a', 0);
    const holder = await holdLock();
    try {
      const run = runnerOn(db).runAll();
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.deepStrictEqual(await hits(), {}, 'waiting while the lock is held');
      await db.query('SELECT pg_terminate_backend($1)', [holder.pid]);
      const applied = await run;
      assert.deepStrictEqual(applied.map(a => a.filename), ['20260101_100000_a.js']);
    } finally {
      holder.client.release();
    }
    assert.deepStrictEqual(await hits(), { a: 1 });
  });

  it('[PGML7] the waiting runner says who holds the lock, again while it waits, and when it gets it', async function () {
    const holder = await holdLock();
    const log = captureLog();
    let released = false;
    try {
      const run = withMigrationsLock(db, async () => 'done', log, { pollMs: 50, waitLogEveryMs: 200 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      await holder.client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK_KEY]);
      holder.client.release();
      released = true;
      assert.strictEqual(await run, 'done');
    } finally {
      if (!released) holder.client.release();
    }
    const info = log.lines.info;
    assert.match(info[0], /another process is applying migrations; waiting for it \(lock held by pid (\d+) /);
    assert.ok(info[0].includes(`pid ${holder.pid} `), `the holder's pid in: ${info[0]}`);
    assert.ok(info.some(l => /still waiting for the lock \(\d+ s\), held by pid \d+/.test(l)), info.join('\n'));
    assert.match(info[info.length - 1], /lock obtained after \d+ s/);
    assert.deepStrictEqual(log.lines.warn, []);
  });

  it('[PGML8] the lock connection lost during the run: the runner warns', async function () {
    // The migration ends its own runner's lock connection.
    fs.writeFileSync(path.join(dir, '20260101_100000_kill.js'),
      'module.exports = { async up (ctx) {\n' +
      "  await ctx.db.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', " +
      `[${JSON.stringify(LOCK_APPLICATION_NAME)}]);\n` +
      "  await ctx.db.query('SELECT pg_sleep(0.3)');\n" +
      '} };\n');
    const log = captureLog();
    const applied = await runnerOn(db, log).runAll();
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(log.lines.warn.length, 1, log.lines.warn.join('\n'));
    assert.match(log.lines.warn[0], /lock connection was lost .*another process may/);
    assert.deepStrictEqual(await lockHolders(), []);
  });

  it('[PGML9] an unlock that finds the lock no longer held warns', async function () {
    // As behind a transaction-mode pooler: the unlock reaches another session.
    let ended = false;
    const client = {
      query: async (sql) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: false }] };
        return { rows: [] };
      },
      end: async () => { ended = true; }
    };
    const log = captureLog();
    const res = await withMigrationsLock({ connectDedicated: async () => client }, async () => 'ok', log);
    assert.strictEqual(res, 'ok');
    assert.strictEqual(log.lines.warn.length, 1);
    assert.match(log.lines.warn[0], /lock was not held any more at the end of the run; another process may/);
    assert.ok(ended, 'the lock connection is ended');
  });

  it('[PGML10] a pool of one connection runs the migrations (the lock connection is outside it)', async function () {
    const small = new DatabasePG({ ...helpers.state.config, max: 1 });
    try {
      await small.waitForConnection();
      fs.writeFileSync(path.join(dir, '20260101_100000_pooled.js'),
        'module.exports = { async up (ctx) {\n' +
        '  const client = await ctx.db.getClient();\n' +
        "  try { await client.query('SELECT 1'); } finally { client.release(); }\n" +
        "  await ctx.db.query('INSERT INTO pgml_hits (name) VALUES ($1)', ['pooled']);\n" +
        '} };\n');
      const applied = await runnerOn(small).runAll();
      assert.strictEqual(applied.length, 1);
    } finally {
      await small.close();
    }
    assert.deepStrictEqual(await hits(), { pooled: 1 });
  });
});
