/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [SYPC] platform-wide configuration held in the platform store, over HTTP:
 * list, get, set and delete; a store row wins over the local value and the
 * list flags it; delete gives the local value back; schema refusals; the
 * step-up for a sensitive key; the effective configuration reports the
 * source `platform-db`.
 *
 * The release's schema has no key yet: these tests replace it with two keys.
 */

const { withInjectedConfig } = require('test-helpers');
const roles = require('business/src/admin/roles.ts');
const sessions = require('business/src/admin/sessions.ts');
const platformConfig = require('business/src/platformConfig/index.ts');

/* global initTests, initCore, coreRequest, assert, cuid */

const MIN = 60 * 1000;
const TEST_SCHEMA = Object.freeze({
  'service.name': { schema: { type: 'string', minLength: 1, maxLength: 80 }, appliesAt: 'live', sensitive: false, capability: 'config' },
  'auth.passwordComplexityMinLength': { schema: { type: 'integer', minimum: 4, maximum: 64 }, appliesAt: 'live', sensitive: true, capability: 'config' }
});
const BASE = '/system/admin/platform-config';

describe('[SYPC] platform configuration in the platform store over /system', function () {
  this.timeout(60000);
  let db, adminKey, coreId, config;
  const roleUsers = [];

  before(async function () {
    await initTests();
    await initCore();
    const app = globalThis.app;
    if (!app.systemAPI.has('system.listUsers')) await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    if (!app.systemAPI.has('system.platformConfig.list')) await require('api-server/src/methods/systemPlatformConfig.ts').default(app.systemAPI);
    config = await require('@pryv/boiler').getConfig();
    adminKey = config.get('auth:adminAccessKey');
    db = require('storages').platformDB;
    coreId = require('platform').platform.coreId;
    platformConfig.setSchemaForTests(TEST_SCHEMA);
    await reset();
  });

  async function reset () {
    for (const { key } of await db.listPlatformKvEntries(platformConfig.ROW_PREFIX)) await db.deletePlatformKv(key);
    await platformConfig.loadScope(config, db, coreId);
  }

  afterEach(reset);

  after(async () => {
    await reset();
    platformConfig.setSchemaForTests(null);
    config.replaceScopeConfig('platform-store', {});
    for (const id of roleUsers) await db.deletePlatformKv('admin-role/' + id);
  });

  async function ownerSession (mfaAt) {
    const userId = 'sypc' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
    roleUsers.push(userId);
    await roles.grantRole(db, userId, { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() - 1000 });
    return (await sessions.createAdminSession(db, { userId, homeCore: coreId, mfaAt, now: Date.now(), ttlMs: 60 * MIN })).token;
  }

  const put = (key, body, authorization = adminKey) => coreRequest.put(BASE + '/' + key).set('authorization', authorization).send(body);

  it('[SYPC1] the list shows every schema key; a key without a row reads the local value', async () => {
    const res = await coreRequest.get(BASE).set('authorization', adminKey);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(typeof res.body.rev, 'number');
    assert.ok(Array.isArray(res.body.coresBehind));
    assert.deepEqual(res.body.entries.map((e) => e.key), ['auth.passwordComplexityMinLength', 'service.name']);
    const name = res.body.entries.find((e) => e.key === 'service.name');
    assert.equal(name.source, 'local');
    assert.equal('value' in name, false);
    assert.deepEqual(name.effective, config.get('service:name'));
    assert.deepEqual({ appliesAt: name.appliesAt, sensitive: name.sensitive, capability: name.capability, locked: name.locked },
      { appliesAt: 'live', sensitive: false, capability: 'config', locked: false });
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('[SYPC2] PUT moves the key to the store (read at once), the list flags the local value it hides; DELETE gives it back', async () => {
    await withInjectedConfig({ service: { name: 'Local name' } }, async () => {
      const set = await put('service.name', { value: 'Stored name' });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      assert.equal(set.body.appliesAt, 'live');
      assert.deepEqual({ source: set.body.entry.source, value: set.body.entry.value, effective: set.body.entry.effective },
        { source: 'platform-db', value: 'Stored name', effective: 'Stored name' });
      assert.equal(set.body.entry.updatedBy.kind, 'admin-key');
      assert.equal(set.body.entry.updatedBy.coreId, coreId);
      assert.equal(config.get('service:name'), 'Stored name', 'the store row wins over the test scope');
      const got = await coreRequest.get(BASE + '/service.name').set('authorization', adminKey);
      assert.equal(got.status, 200);
      assert.deepEqual(got.body.entry.localOverride, { value: 'Local name' });

      const effective = await coreRequest.get('/system/admin/config/effective').set('authorization', adminKey);
      assert.equal(effective.status, 200, JSON.stringify(effective.body).slice(0, 300));
      assert.deepEqual({ value: effective.body.keys['service.name'].value, source: effective.body.keys['service.name'].source },
        { value: 'Stored name', source: 'platform-db' });

      const del = await coreRequest.delete(BASE + '/service.name').set('authorization', adminKey);
      assert.equal(del.status, 200, JSON.stringify(del.body));
      assert.equal(del.body.deleted, true);
      assert.equal(del.body.entry.source, 'local');
      assert.equal(config.get('service:name'), 'Local name', 'back to the local value');
      const again = await coreRequest.delete(BASE + '/service.name').set('authorization', adminKey);
      assert.equal(again.status, 200);
      assert.equal(again.body.deleted, false);
      assert.equal(again.body.rev, del.body.rev, 'nothing deleted: same revision');
    });
  });

  it('[SYPC3] a key outside the schema, a refused value or a malformed body is not written', async () => {
    assert.equal((await put('service.terms', { value: 'https://x.example' })).status, 404);
    assert.equal((await coreRequest.get(BASE + '/service.terms').set('authorization', adminKey)).status, 404);
    assert.equal((await coreRequest.delete(BASE + '/service.terms').set('authorization', adminKey)).status, 404);
    assert.equal((await put('not_a.key', { value: 'x' })).status, 404);
    const refused = await put('service.name', { value: '' });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error.data.key, 'service.name');
    assert.ok(refused.body.error.data.errors.length > 0, 'the schema errors are given');
    assert.equal((await put('service.name', { value: 3 })).status, 400);
    assert.equal((await put('service.name', {})).status, 400, 'no value');
    assert.equal((await put('service.name', { value: 'x', other: 1 })).status, 400, 'unknown parameter');
    assert.deepEqual(await platformConfig.listEntries(db), []);
  });

  it('[SYPC4] a sensitive key needs a recent second factor from an administrator session; the admin key does not', async () => {
    const stale = await ownerSession(Date.now() - 60 * MIN);
    const refused = await put('auth.passwordComplexityMinLength', { value: 12 }, 'AdminSession ' + stale);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.error.data.stepUp, true);
    assert.equal((await coreRequest.delete(BASE + '/auth.passwordComplexityMinLength').set('authorization', 'AdminSession ' + stale)).status, 403);
    assert.equal(await platformConfig.getEntry(db, 'auth.passwordComplexityMinLength'), null);
    // A non-sensitive key with the same session: no step-up needed.
    assert.equal((await put('service.name', { value: 'By session' }, 'AdminSession ' + stale)).status, 200);
    const fresh = await ownerSession(Date.now());
    const ok = await put('auth.passwordComplexityMinLength', { value: 12 }, 'AdminSession ' + fresh);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.entry.updatedBy.kind, 'session');
    assert.equal(ok.body.entry.sensitive, true);
    assert.equal((await put('auth.passwordComplexityMinLength', { value: 14 })).status, 200, 'admin key');
    assert.equal(config.get('auth:passwordComplexityMinLength'), 14);
  });

  it('[SYPC5] every route answers 404 without a credential', async () => {
    assert.equal((await coreRequest.get(BASE)).status, 404);
    assert.equal((await coreRequest.put(BASE + '/service.name').send({ value: 'x' })).status, 404);
    assert.equal((await coreRequest.delete(BASE + '/service.name')).status, 404);
    assert.deepEqual(await platformConfig.listEntries(db), []);
  });

  // The command-line tool runs in its own process, with the release's schema
  // (no key yet): what it can show here is the refusals, the stale-row
  // cleanup and the export.
  describe('bin/platform-config.js', function () {
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const { childStorageEngineEnv } = require('test-helpers');
    const root = path.resolve(require.resolve('api-server/package.json'), '../../../');
    const run = (args) => {
      const res = spawnSync('node', [path.join(root, 'bin/platform-config.js'), ...args], {
        cwd: root, env: { ...process.env, ...childStorageEngineEnv() }, encoding: 'utf8', timeout: 60000
      });
      return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
    };

    it('[SYPC6] usage, refusals, export and the removal of a row of a key this release does not know', async () => {
      assert.equal(run(['--help']).status, 0);
      assert.equal(run(['nope']).status, 2);
      assert.equal(run(['set', 'service.name']).status, 2, 'set needs a value');
      const refused = run(['set', 'not.a.release.key', '"x"']);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /not a platform configuration key/);
      assert.deepEqual(await platformConfig.listEntries(db), []);
      await db.setPlatformKv(platformConfig.ROW_PREFIX + 'old.key', JSON.stringify({ value: 'kept', updatedAt: 1, updatedBy: { kind: 'cli', coreId } }));
      const exported = run(['export']);
      assert.equal(exported.status, 0, exported.stderr);
      assert.deepEqual(JSON.parse(exported.stdout.slice(exported.stdout.indexOf('{'))).entries, { 'old.key': 'kept' });
      const listed = run(['list']);
      assert.equal(listed.status, 0, listed.stderr);
      assert.match(listed.stdout, /old\.key = "kept" {2}\[ignored: not a key of this release/);
      const unset = run(['unset', 'old.key']);
      assert.equal(unset.status, 0, unset.stderr);
      assert.equal(await db.getPlatformKv(platformConfig.ROW_PREFIX + 'old.key'), null);
    });
  });
});
