/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * [MPKV] bin/migrate-platform.js copies every platform row family between the
 * rqlite and PostgreSQL engines, values unchanged: OAuth clients and grants,
 * revocation lists, the erasure ledger, the access index, external-id
 * namespaces and holds, the setup state and administrator roles, the
 * platform-wide configuration rows and revisions, TTL state
 * (expired rows included) and windowed counters, plus any family it has no
 * typed copy for. Both engines are the
 * real ones, wiped before and after (as the PlatformDB conformance suites do).
 */

const path = require('node:path');
const assert = require('node:assert');
const cuid = require('cuid');
const { getConfigUnsafe } = require('@pryv/boiler');
const helpers = require('./helpers/index.js');
const { DBrqlite } = require('../engines/rqlite/src/DBrqlite.ts');
const { migrate } = require(path.resolve(__dirname, '../../bin/migrate-platform.js'));

const RQLITE_URL = process.env.RQLITE_URL ||
  getConfigUnsafe(true).get('storages:engines:rqlite:url') ||
  'http://localhost:4001';

describe('[MPKV] bin/migrate-platform.js: every platform row family', function () {
  this.timeout(30000);
  let rq, pg;
  const now = Date.now();
  const suffix = cuid.slug();

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await helpers.dependencies.init();
    const { DBpostgresql } = require('../engines/postgresql/src/DBpostgresql.ts');
    pg = new DBpostgresql();
    await pg.init();
    rq = new DBrqlite(RQLITE_URL);
    await rq.init();
    await rq.deleteAll();
    await pg.deleteAll();
  });

  // In afterEach (not beforeEach), so no seeded row outlives its test.
  afterEach(async () => {
    if (rq) await rq.deleteAll();
    if (pg) await pg.deleteAll();
  });

  // One row of each family, written through the engine API its owner uses.
  async function seed (db) {
    await db.setPlatformKv('oauth-client/cl-' + suffix, JSON.stringify({ clientId: 'cl-' + suffix, redirectUris: ['https://app.example/cb'] }));
    await db.setPlatformKv('oauth-client-revoked/old-' + suffix, JSON.stringify({ revokedAt: now - 1000 }));
    await db.setPlatformKv('dpop-jkt-revoked/jkt-' + suffix, JSON.stringify({ revokedAt: now }));
    await db.setPlatformKv('dpop-jkt-seen/url~jkt-' + suffix, JSON.stringify({ firstSeenAt: now - 5000, lastSeenAt: now }));
    await db.setPlatformKv('account-erasure/hash-' + suffix, JSON.stringify({ userIdHash: 'h', deletedAt: now }));
    await db.setPlatformKv('access-index/acc-' + suffix, JSON.stringify({ usernameToken: 't', coreId: 'core-a' }));
    assert.strictEqual(await db.claimCoreRow('ext-id-ns/', 'ns-' + suffix, JSON.stringify({ token: 'nt', coreId: 'core-a' })), true);
    assert.strictEqual(await db.claimCoreRow('ext-id/', 'nt/tok-' + suffix, 'core-a'), true);
    // A refresh token is a durable grant kept as TTL state.
    await db.setAccessState('oauth-rt/core-a/rt-' + suffix, { clientId: 'cl-' + suffix, username: 'u' }, now + 30 * 24 * 3600 * 1000);
    // An expired code is still read by the orphan sweep (revokes its access).
    await db.setAccessState('oauth-ac/code-' + suffix, { accessId: 'a1' }, now - 1000);
    assert.strictEqual(await db.bumpWindowedCounter('sms/' + suffix, 5, 3600 * 1000, now), null);
    // A family this tool has no typed copy for, values with quotes and non-ASCII.
    await db.setPlatformKv('some-future-family/k-' + suffix, 'a "quoted" value, é, ✓');
    await db.setPlatformKv('lone-key-' + suffix, '{"not":"re-encoded" }');
    // Setup state and administrator roles (platform KV, no TTL).
    await db.setPlatformKv('setup/state', JSON.stringify({ state: 'ready', createdAt: now, createdBy: 'core-a', via: 'fresh', readyAt: now, readyBy: 'u-' + suffix }));
    await db.setPlatformKv('admin-role/u-' + suffix, JSON.stringify({ grants: [{ role: 'owner', scope: 'platform', grantedAt: now, grantedBy: 'setup', via: 'setup' }], updatedAt: now }));
    // Platform-wide configuration: a row, the revision, a core's loaded revision.
    await db.setPlatformKv('platform-config/service.name', JSON.stringify({ value: 'Name ' + suffix, updatedAt: now, updatedBy: { kind: 'cli', coreId: 'core-a' } }));
    await db.setPlatformKv('platform-config-rev', '3');
    await db.setPlatformKv('core-config-rev/core-a', JSON.stringify({ rev: 3, at: now }));
    // A core's lockdown digest (drift warning).
    await db.setPlatformKv('admin-lockdown-hash/core-a', JSON.stringify({ digest: 'd'.repeat(64), at: now }));
    // Typed families keep working alongside.
    await db.setUserUniqueField('user-' + suffix, 'email', suffix + '@example.com');
    await db.setUserCore('user-' + suffix, 'core-a');
  }

  async function allRows (db) {
    return (await db.listAllPlatformKvEntries()).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }

  function quiet () {
    const lines = [];
    return { lines, log: (l) => lines.push(l) };
  }

  it('[MPK1] rqlite -> postgresql -> rqlite keeps every row, values unchanged', async () => {
    await seed(rq);
    const source = await allRows(rq);
    assert.strictEqual(source.length, 21);

    await migrate(rq, pg, { dryRun: false, force: false, log: quiet().log });
    assert.deepStrictEqual(await allRows(pg), source);
    // The setup state and role rows read back through the administration module.
    const { readSetupState } = require('business/src/admin/setupState.ts');
    const { readRoleRow } = require('business/src/admin/roles.ts');
    assert.strictEqual((await readSetupState(pg)).state, 'ready');
    assert.strictEqual((await readRoleRow(pg, 'u-' + suffix)).grants[0].role, 'owner');
    // The platform configuration reads back through its module.
    const platformConfig = require('business/src/platformConfig/index.ts');
    assert.strictEqual((await platformConfig.getEntry(pg, 'service.name')).value, 'Name ' + suffix);
    assert.strictEqual(await platformConfig.currentRev(pg), 3);
    assert.deepStrictEqual(await platformConfig.coresBehind(pg, ['core-a']), []);
    // Read back through the typed paths the features use.
    assert.strictEqual(await pg.getCoreRow('ext-id/', 'nt/tok-' + suffix), 'core-a');
    assert.notStrictEqual(await pg.getAccessState('oauth-rt/core-a/rt-' + suffix), null);
    assert.strictEqual((await pg.listExpiredAccessStates('oauth-ac/', now)).length, 1);

    await rq.deleteAll();
    await migrate(pg, rq, { dryRun: false, force: false, log: quiet().log });
    assert.deepStrictEqual(await allRows(rq), source);
  });

  it('[MPK2] postgresql -> rqlite keeps every row', async () => {
    await seed(pg);
    const source = await allRows(pg);
    await migrate(pg, rq, { dryRun: false, force: false, log: quiet().log });
    assert.deepStrictEqual(await allRows(rq), source);
  });

  it('[MPK3] the report counts each family; a dry run writes nothing', async () => {
    await seed(rq);
    const out = quiet();
    await migrate(rq, pg, { dryRun: true, force: false, log: out.log });
    assert.deepStrictEqual(await allRows(pg), []);
    const text = out.lines.join('\n');
    const expected = {
      'oauth-client/': 1,
      'oauth-client-revoked/': 1,
      'dpop-jkt-revoked/': 1,
      'dpop-jkt-seen/': 1,
      'account-erasure/': 1,
      'access-index/': 1,
      'ext-id-ns/': 1,
      'ext-id/': 1,
      'access-state/': 2,
      'counter/': 1,
      'some-future-family/': 1,
      'setup/': 1,
      'admin-role/': 1,
      'platform-config/': 1,
      'core-config-rev/': 1,
      'admin-lockdown-hash/': 1
    };
    for (const [family, count] of Object.entries(expected)) {
      assert.match(text, new RegExp('would migrate +' + count + ' {2}platform rows ' + family + '$', 'm'), family);
    }
    // lone-key-<suffix> and platform-config-rev
    assert.match(text, /would migrate +2 {2}platform rows \(other keys\)$/m);
    assert.match(text, /21 record\(s\) would be migrated/);
  });

  it('[MPK4] a fresh target is accepted; the engine\'s own schema marker is neither counted nor copied', async () => {
    const { SchemaMigrationsRqlite } = require('../engines/rqlite/src/SchemaMigrations.ts');
    await new SchemaMigrationsRqlite(rq).setVersion(7);
    const marker = await rq.getPlatformKv('migrations/version');
    await pg.setPlatformKv('oauth-client/cl-' + suffix, '{}');
    // rqlite target holding only its marker: accepted, marker kept.
    await migrate(pg, rq, { dryRun: false, force: false, log: quiet().log });
    assert.strictEqual(await rq.getPlatformKv('oauth-client/cl-' + suffix), '{}');
    assert.strictEqual(await rq.getPlatformKv('migrations/version'), marker);
    // rqlite source: its marker does not land in the other engine.
    await pg.deleteAll();
    await migrate(rq, pg, { dryRun: false, force: false, log: quiet().log });
    assert.strictEqual(await pg.getPlatformKv('migrations/version'), null);
    assert.strictEqual(await pg.getPlatformKv('oauth-client/cl-' + suffix), '{}');
  });

  it('[MPK5] a target holding any platform row is refused without --force, accepted with it', async () => {
    await rq.setPlatformKv('oauth-client/fresh-' + suffix, '"from source"');
    await pg.setPlatformKv('oauth-client/x-' + suffix, '"already there"');
    await pg.setPlatformKv('tls-acme-account', '{}');
    await assert.rejects(
      () => migrate(rq, pg, { dryRun: false, force: false, log: quiet().log }),
      (err) => {
        assert.match(err.message, /target already holds 2 platform row\(s\) \(oauth-client\/ 1, tls-acme-account 1\)/);
        assert.ok(!err.message.includes('x-' + suffix), 'no key in the message');
        assert.ok(!err.message.includes('already there'), 'no value in the message');
        return true;
      });
    assert.strictEqual(await pg.getPlatformKv('oauth-client/fresh-' + suffix), null, 'nothing written');
    // A dry run never refuses.
    await migrate(rq, pg, { dryRun: true, force: false, log: quiet().log });
    await migrate(rq, pg, { dryRun: false, force: true, log: quiet().log });
    assert.strictEqual(await pg.getPlatformKv('oauth-client/fresh-' + suffix), '"from source"');
    assert.strictEqual(await pg.getPlatformKv('oauth-client/x-' + suffix), '"already there"');
  });
});
