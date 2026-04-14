/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, assert */

/**
 * [MIGRUN] — MigrationRunner contract + engine-switch behaviour.
 *
 * Verifies the primitive works against whichever engines register a
 * `getMigrationsCapability()` via their plugin `index.js`. Under MongoDB
 * mode only rqlite participates; under PostgreSQL mode both rqlite and PG
 * participate. Either way the same runner iterates them independently.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('[MIGRUN] MigrationRunner', () => {
  let createMigrationRunner;
  let MigrationRunner;
  let tmpDirs;
  let capabilities;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ createMigrationRunner, MigrationRunner } = require('storages/interfaces/migrations'));

    // Build the baseline capability set from the live storages barrel so we
    // can later swap migrationsDir paths into disposable temp dirs and
    // reset tracking rows between tests.
    const storages = require('storages');
    capabilities = [];
    for (const engineName of storages.pluginLoader.listEngines()) {
      const mod = storages.pluginLoader.getEngineModule(engineName);
      if (typeof mod.getMigrationsCapability !== 'function') continue;
      const cap = mod.getMigrationsCapability();
      if (cap) capabilities.push(cap);
    }
    assert.ok(capabilities.length > 0, 'expected at least one migration-capable engine (rqlite)');
  });

  beforeEach(() => {
    tmpDirs = new Map();
    for (const cap of capabilities) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `migrun-${cap.id}-`));
      tmpDirs.set(cap.id, dir);
    }
  });

  afterEach(async () => {
    // Reset each engine's schema_migrations tracking and clean temp dirs
    for (const cap of capabilities) {
      await resetCapability(cap);
      const dir = tmpDirs.get(cap.id);
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function resetCapability (cap) {
    const storages = require('storages');
    if (cap.id === 'postgresql') {
      const { SchemaMigrationsPG } = require('storages/engines/postgresql/src/SchemaMigrations');
      const store = new SchemaMigrationsPG(storages.databasePG);
      await store._resetForTests();
    } else if (cap.id === 'rqlite') {
      const { SchemaMigrationsRqlite } = require('storages/engines/rqlite/src/SchemaMigrations');
      const store = new SchemaMigrationsRqlite(storages.platformDB);
      await store._resetForTests();
    }
  }

  /** Build a capability that points at a disposable migrationsDir. */
  function capabilityWithDir (cap) {
    return { ...cap, migrationsDir: tmpDirs.get(cap.id) };
  }

  function writeMigration (capId, filename, body) {
    const dir = tmpDirs.get(capId);
    fs.writeFileSync(path.join(dir, filename), body, 'utf8');
  }

  it('[MR01] fresh engines report version 0 with no pending', async () => {
    const runner = new MigrationRunner(capabilities.map(capabilityWithDir));
    const st = await runner.status();
    assert.strictEqual(st.length, capabilities.length);
    for (const s of st) {
      assert.strictEqual(s.currentVersion, 0, `${s.engineId} should start at v0`);
      assert.strictEqual(s.pending.length, 0);
    }
  });

  it('[MR02] applies a single migration and bumps version to 1', async () => {
    const cap = capabilities[0];
    writeMigration(cap.id, '20260414_120000_noop.js',
      'module.exports = { async up () { /* no-op */ } };'
    );

    const runner = new MigrationRunner([capabilityWithDir(cap)]);
    const applied = await runner.runAll();
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(applied[0].engineId, cap.id);
    assert.strictEqual(applied[0].fromVersion, 0);
    assert.strictEqual(applied[0].toVersion, 1);

    const st = await runner.status();
    assert.strictEqual(st[0].currentVersion, 1);
    assert.strictEqual(st[0].pending.length, 0);
  });

  it('[MR03] multiple migrations apply in filename order, +1 each', async () => {
    const cap = capabilities[0];
    writeMigration(cap.id, '20260414_120000_a.js',
      'module.exports = { async up (ctx) { ctx._hits = (ctx._hits || 0) + 1; } };'
    );
    writeMigration(cap.id, '20260414_130000_b.js',
      'module.exports = { async up () {} };'
    );
    writeMigration(cap.id, '20260414_140000_c.js',
      'module.exports = { async up () {} };'
    );

    const runner = new MigrationRunner([capabilityWithDir(cap)]);
    const applied = await runner.runAll();
    assert.strictEqual(applied.length, 3);
    assert.deepStrictEqual(
      applied.map(a => [a.filename, a.fromVersion, a.toVersion]),
      [
        ['20260414_120000_a.js', 0, 1],
        ['20260414_130000_b.js', 1, 2],
        ['20260414_140000_c.js', 2, 3]
      ]
    );
    assert.strictEqual((await runner.status())[0].currentVersion, 3);
  });

  it('[MR04] dry-run computes plan without persisting', async () => {
    const cap = capabilities[0];
    writeMigration(cap.id, '20260414_120000_a.js',
      'module.exports = { async up () { throw new Error("should not execute in dry-run"); } };'
    );

    const runner = new MigrationRunner([capabilityWithDir(cap)]);
    const applied = await runner.runAll({ dryRun: true });
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(applied[0].dryRun, true);
    assert.strictEqual((await runner.status())[0].currentVersion, 0);
  });

  it('[MR05] targetVersion stops early', async () => {
    const cap = capabilities[0];
    for (const name of ['20260414_120000_a.js', '20260414_130000_b.js', '20260414_140000_c.js']) {
      writeMigration(cap.id, name, 'module.exports = { async up () {} };');
    }

    const runner = new MigrationRunner([capabilityWithDir(cap)]);
    const applied = await runner.runAll({ targetVersion: 2 });
    assert.strictEqual(applied.length, 2);
    assert.strictEqual((await runner.status())[0].currentVersion, 2);
    assert.strictEqual((await runner.status())[0].pending.length, 1);
  });

  it('[MR06] rerunning is idempotent — already-applied migrations are skipped', async () => {
    const cap = capabilities[0];
    const spyDir = tmpDirs.get(cap.id);
    const spyPath = path.join(spyDir, '20260414_120000_spy.js');
    fs.writeFileSync(spyPath,
      'module.exports = { async up () { global.__MR06_HITS = (global.__MR06_HITS || 0) + 1; } };');
    global.__MR06_HITS = 0;

    const runner = new MigrationRunner([capabilityWithDir(cap)]);
    await runner.runAll();
    await runner.runAll();
    assert.strictEqual(global.__MR06_HITS, 1, 'migration should run exactly once across two runs');
    delete global.__MR06_HITS;
  });

  it('[MR07] ENGINE SWITCH — each engine tracks its own version independently', async () => {
    // Two synthetic in-memory engines. Each has its own version counter and
    // migration dir; the runner must advance them independently. Using live
    // PG + rqlite here would be ideal but PG's capability only activates when
    // postgresql is the base storage engine — which isn't guaranteed by the
    // api-server test harness. In-memory engines exercise the same contract.
    function makeMemEngine (id, dir) {
      let v = 0;
      return {
        id,
        migrationsDir: dir,
        getVersion: async () => v,
        setVersion: async (n) => { v = n; },
        buildContext: () => ({ db: null, logger: { debug () {}, info () {}, warn () {}, error () {} } }),
        _reset: async () => { v = 0; }
      };
    }
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'migrun-memA-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'migrun-memB-'));
    try {
      const engA = makeMemEngine('mem-a', dirA);
      const engB = makeMemEngine('mem-b', dirB);

      // engA gets two migrations, engB gets one
      fs.writeFileSync(path.join(dirA, '20260414_100000_a.js'), 'module.exports = { async up () {} };');
      fs.writeFileSync(path.join(dirA, '20260414_110000_b.js'), 'module.exports = { async up () {} };');
      fs.writeFileSync(path.join(dirB, '20260414_100000_x.js'), 'module.exports = { async up () {} };');

      const runner = new MigrationRunner([engA, engB]);
      await runner.runAll();

      const byId = Object.fromEntries((await runner.status()).map(s => [s.engineId, s]));
      assert.strictEqual(byId['mem-a'].currentVersion, 2);
      assert.strictEqual(byId['mem-b'].currentVersion, 1);

      // Wipe engB's tracking, re-run: only engB re-applies, engA untouched.
      await engB._reset();
      const applied = await runner.runAll();
      assert.strictEqual(applied.length, 1);
      assert.strictEqual(applied[0].engineId, 'mem-b');
      const after = Object.fromEntries((await runner.status()).map(s => [s.engineId, s]));
      assert.strictEqual(after['mem-a'].currentVersion, 2);
      assert.strictEqual(after['mem-b'].currentVersion, 1);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('[MR08] migration throwing stops the run at that engine', async () => {
    const cap = capabilities[0];
    writeMigration(cap.id, '20260414_100000_ok.js', 'module.exports = { async up () {} };');
    writeMigration(cap.id, '20260414_110000_bad.js',
      'module.exports = { async up () { throw new Error("boom"); } };');
    writeMigration(cap.id, '20260414_120000_never.js', 'module.exports = { async up () {} };');

    const runner = new MigrationRunner([capabilityWithDir(cap)]);
    let err = null;
    try { await runner.runAll(); } catch (e) { err = e; }
    assert.ok(err && /boom/.test(err.message), 'runner should surface the failing migration error');
    assert.strictEqual((await runner.status())[0].currentVersion, 1,
      'only the first (successful) migration should have been applied');
  });

  it('[MR09] createMigrationRunner() wires from the live storages barrel', async () => {
    const runner = await createMigrationRunner();
    const st = await runner.status();
    // Under MongoDB mode: rqlite only. Under PG mode: rqlite + postgresql.
    const engineIds = st.map(s => s.engineId).sort();
    assert.ok(engineIds.includes('rqlite'),
      'rqlite should always be migration-capable (it is the platform engine)');
  });
});
