/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, assert */

/**
 * [MIGSKIP] — boot-time migration policy helper.
 *
 * Pure unit tests for `applyOrAnnounce`. The previous inline block in
 * `bin/master.js` silently skipped migrations when
 * `migrations.autoRunOnStart=false`, which took down a demo deploy on
 * 2026-05-13. The helper now logs a WARNING for every pending
 * migration in the skipped state; these tests pin that contract.
 *
 * `-seq` because the api-server mocha hooks run a Platform DB integrity
 * check around every test that needs `initCore()`. The helper itself does
 * not touch the DB — it operates entirely on the injected fake runner.
 */

describe('[MIGSKIP] applyOrAnnounce', () => {
  let applyOrAnnounce;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ applyOrAnnounce } = require('storages/interfaces/migrations/index.ts'));
  });

  function makeLogger () {
    const info = [];
    const warn = [];
    return {
      info: (m) => info.push(m),
      warn: (m) => warn.push(m),
      _info: info,
      _warn: warn
    };
  }

  function fakeRunner ({ applied = [], statuses = [] } = {}) {
    const calls = { runAll: 0, status: 0 };
    return {
      runAll: async () => { calls.runAll++; return applied; },
      status: async () => { calls.status++; return statuses; },
      _calls: calls
    };
  }

  it('[MS01] autoRun=true with no pending: emits "No pending migrations."', async () => {
    const logger = makeLogger();
    const runner = fakeRunner({ applied: [] });
    const res = await applyOrAnnounce({ runner, logger, autoRun: true });

    assert.strictEqual(res.mode, 'applied');
    assert.deepStrictEqual(res.applied, []);
    assert.deepStrictEqual(res.pending, []);
    assert.strictEqual(runner._calls.runAll, 1);
    assert.strictEqual(runner._calls.status, 0);
    assert.deepStrictEqual(logger._info, [
      'Running pending schema migrations...',
      'No pending migrations.'
    ]);
    assert.deepStrictEqual(logger._warn, []);
  });

  it('[MS02] autoRun=true with applied migrations: per-migration info + summary', async () => {
    const logger = makeLogger();
    const applied = [
      { engineId: 'postgresql', filename: '20260601_120000_a.js', fromVersion: 0, toVersion: 1, durationMs: 12, dryRun: false },
      { engineId: 'postgresql', filename: '20260601_120100_b.js', fromVersion: 1, toVersion: 2, durationMs: 7, dryRun: false }
    ];
    const runner = fakeRunner({ applied });
    const res = await applyOrAnnounce({ runner, logger, autoRun: true });

    assert.strictEqual(res.mode, 'applied');
    assert.strictEqual(res.applied.length, 2);
    assert.deepStrictEqual(res.pending, []);
    assert.deepStrictEqual(logger._info, [
      'Running pending schema migrations...',
      '  postgresql: 20260601_120000_a.js (→ v1, 12ms)',
      '  postgresql: 20260601_120100_b.js (→ v2, 7ms)',
      'Applied 2 migration(s).'
    ]);
    assert.deepStrictEqual(logger._warn, []);
  });

  it('[MS03] autoRun=false with no pending: single info line, runAll NOT called', async () => {
    const logger = makeLogger();
    const statuses = [
      { engineId: 'postgresql', currentVersion: 5, discovered: [], pending: [] },
      { engineId: 'rqlite', currentVersion: 2, discovered: [], pending: [] }
    ];
    const runner = fakeRunner({ statuses });
    const res = await applyOrAnnounce({ runner, logger, autoRun: false });

    assert.strictEqual(res.mode, 'skipped');
    assert.deepStrictEqual(res.applied, []);
    assert.deepStrictEqual(res.pending, []);
    assert.strictEqual(runner._calls.runAll, 0);
    assert.strictEqual(runner._calls.status, 1);
    assert.deepStrictEqual(logger._info, [
      'Migrations skipped (autoRunOnStart=false); no pending migrations.'
    ]);
    assert.deepStrictEqual(logger._warn, []);
  });

  it('[MS04] autoRun=false with one pending: WARNING summary + per-engine WARNING line', async () => {
    const logger = makeLogger();
    const statuses = [
      {
        engineId: 'postgresql',
        currentVersion: 4,
        discovered: [],
        pending: [{ filename: '20260513_010101_add_head_id.js', targetVersion: 5, path: '/dev/null', module: {} }]
      }
    ];
    const runner = fakeRunner({ statuses });
    const res = await applyOrAnnounce({ runner, logger, autoRun: false });

    assert.strictEqual(res.mode, 'skipped');
    assert.strictEqual(res.pending.length, 1);
    assert.strictEqual(res.pending[0].engineId, 'postgresql');
    assert.strictEqual(runner._calls.runAll, 0);
    assert.strictEqual(runner._calls.status, 1);

    assert.deepStrictEqual(logger._info, []);
    assert.strictEqual(logger._warn.length, 2);
    assert.match(logger._warn[0], /Migrations skipped \(autoRunOnStart=false\)/);
    assert.match(logger._warn[0], /1 pending migration\(s\) across 1 engine\(s\)/);
    assert.match(logger._warn[0], /node bin\/migrate\.js up/);
    assert.strictEqual(
      logger._warn[1],
      '  postgresql: at v4, pending: 20260513_010101_add_head_id.js'
    );
  });

  it('[MS05] autoRun=false with multiple pending across multiple engines: count + per-engine math', async () => {
    const logger = makeLogger();
    const statuses = [
      {
        engineId: 'postgresql',
        currentVersion: 4,
        discovered: [],
        pending: [
          { filename: 'pg-1.js', targetVersion: 5, path: '/dev/null', module: {} },
          { filename: 'pg-2.js', targetVersion: 6, path: '/dev/null', module: {} }
        ]
      },
      {
        engineId: 'mongodb',
        currentVersion: 9,
        discovered: [],
        pending: []
      },
      {
        engineId: 'rqlite',
        currentVersion: 1,
        discovered: [],
        pending: [{ filename: 'rq-1.js', targetVersion: 2, path: '/dev/null', module: {} }]
      }
    ];
    const runner = fakeRunner({ statuses });
    const res = await applyOrAnnounce({ runner, logger, autoRun: false });

    assert.strictEqual(res.mode, 'skipped');
    // mongodb engine has nothing pending — must be filtered out
    assert.deepStrictEqual(res.pending.map(s => s.engineId), ['postgresql', 'rqlite']);

    assert.match(logger._warn[0], /3 pending migration\(s\) across 2 engine\(s\)/);
    assert.strictEqual(logger._warn[1], '  postgresql: at v4, pending: pg-1.js, pg-2.js');
    assert.strictEqual(logger._warn[2], '  rqlite: at v1, pending: rq-1.js');
    assert.strictEqual(logger._warn.length, 3);
    assert.deepStrictEqual(logger._info, []);
  });
});
