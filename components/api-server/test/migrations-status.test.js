/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `GET /system/migrations-status`: lets a deploy script see, in one call,
 * that the storage schema is behind the code. A core with
 * `migrations.autoRunOnStart: false` boots and serves with migrations pending
 * (an external implementer's sign-in answered 500 for minutes on 2026-11-02
 * while its health check passed), so the state has to be readable.
 *
 * Pattern C: initCore + coreRequest.
 */

/* global initTests, initCore, coreRequest, assert */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('node:fs');
const path = require('node:path');
const { getConfig } = require('@pryv/boiler');

describe('[MGHS] storage migrations status', function () {
  let adminKey;

  before(async function () {
    await initTests();
    await initCore();
    adminKey = (await getConfig()).get('auth:adminAccessKey');
    // initCore wires only the user-facing API; register the system API on the
    // app coreRequest is bound to (see event-types-degraded.test.js).
    await require('api-server/src/methods/system.ts').default(global.app.systemAPI, global.app.api);
    // The in-process test core does not run the boot-time migrations (the
    // master process does), so a freshly created test database records no
    // version. Apply them as the master would (idempotent).
    const { createMigrationRunner } = require('storages/interfaces/migrations/index.ts');
    await (await createMigrationRunner()).runAll();
  });

  const get = (key) => {
    const req = coreRequest.get('/system/migrations-status');
    return key == null ? req : req.set('Authorization', key);
  };

  it('[MGHS1] no admin key or a wrong one: 404, nothing read', async function () {
    for (const res of [await get(null), await get('not-the-admin-key')]) {
      assert.strictEqual(res.status, 404, JSON.stringify(res.body));
      assert.strictEqual(res.body?.migrations, undefined);
    }
  });

  it('[MGHS2] a migrated core: 200, upToDate, each engine at its target version', async function () {
    const res = await get(adminKey);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const m = res.body.migrations;
    assert.strictEqual(typeof m.autoRunOnStart, 'boolean');
    assert.strictEqual(m.pending, 0);
    assert.strictEqual(m.upToDate, true);
    assert.ok(Array.isArray(m.engines));
    for (const e of m.engines) {
      assert.strictEqual(e.currentVersion, e.targetVersion, JSON.stringify(e));
      assert.deepStrictEqual(e.pending, []);
    }
    if (require('storages').databasePG != null) {
      const pg = m.engines.find((e) => e.id === 'postgresql');
      assert.ok(pg, 'a PostgreSQL core reports its engine');
      const dir = path.resolve(import.meta.dirname, '../../../storages/engines/postgresql/migrations');
      const shipped = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('.') && !f.startsWith('_'));
      assert.strictEqual(pg.targetVersion, shipped.length);
    } else {
      // SQLite has no migrations of its own.
      assert.strictEqual(m.engines.find((e) => e.id === 'postgresql'), undefined);
    }
  });

  it('[MGHS3] PostgreSQL schema one version behind: upToDate false, the missing migration named; read live, not cached', async function () {
    const db = require('storages').databasePG;
    if (db == null) return this.skip();
    const top = Number((await db.query('SELECT MAX(version) AS v FROM schema_migrations')).rows[0].v);
    assert.ok(top >= 1);
    await db.query('DELETE FROM schema_migrations WHERE version = $1', [top]);
    try {
      const res = await get(adminKey);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const m = res.body.migrations;
      assert.strictEqual(m.upToDate, false);
      assert.strictEqual(m.pending, 1);
      const pg = m.engines.find((e) => e.id === 'postgresql');
      assert.strictEqual(pg.currentVersion, pg.targetVersion - 1);
      assert.strictEqual(pg.pending.length, 1);
      assert.match(pg.pending[0], /\.js$/);
    } finally {
      await db.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [top]);
    }
    const after = await get(adminKey);
    assert.strictEqual(after.body.migrations.upToDate, true);
  });

  describe('summarizeStatus', function () {
    let summarizeStatus, applyOrAnnounce;
    before(function () {
      ({ summarizeStatus, applyOrAnnounce } = require('storages/interfaces/migrations/index.ts'));
    });
    const mig = (filename, targetVersion) => ({ filename, targetVersion, path: '/dev/null', module: {} });
    const statuses = () => [
      { engineId: 'postgresql', currentVersion: 2, discovered: [mig('a.js', 1), mig('b.js', 2), mig('c.js', 3), mig('d.js', 4)], pending: [mig('c.js', 3), mig('d.js', 4)] },
      { engineId: 'rqlite', currentVersion: 0, discovered: [], pending: [] },
      { engineId: 'other', currentVersion: 0, discovered: [mig('x.js', 1)], pending: [mig('x.js', 1)] }
    ];

    it('[MGHS4] counts pending across engines, target = shipped files, order kept', function () {
      assert.deepStrictEqual(summarizeStatus(statuses()), {
        pending: 3,
        upToDate: false,
        engines: [
          { id: 'postgresql', currentVersion: 2, targetVersion: 4, pending: ['c.js', 'd.js'] },
          { id: 'rqlite', currentVersion: 0, targetVersion: 0, pending: [] },
          { id: 'other', currentVersion: 0, targetVersion: 1, pending: ['x.js'] }
        ]
      });
      assert.deepStrictEqual(summarizeStatus([]), { pending: 0, upToDate: true, engines: [] });
    });

    it('[MGHS5] the boot warning reports the same engines and count as the summary', async function () {
      const warn = [];
      const res = await applyOrAnnounce({
        runner: { runAll: async () => [], status: async () => statuses() },
        logger: { info: () => {}, warn: (m) => warn.push(m) },
        autoRun: false
      });
      const summary = summarizeStatus(statuses());
      assert.deepStrictEqual(res.pending.map((s) => s.engineId),
        summary.engines.filter((e) => e.pending.length > 0).map((e) => e.id));
      assert.match(warn[0], new RegExp(`${summary.pending} pending migration`));
    });
  });
});
