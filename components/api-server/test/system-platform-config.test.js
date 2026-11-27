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
 * The release's keys (the service information), plus one sensitive key for
 * the step-up cases (the release has none yet).
 */

const { withInjectedConfig } = require('test-helpers');
const roles = require('business/src/admin/roles.ts');
const sessions = require('business/src/admin/sessions.ts');
const platformConfig = require('business/src/platformConfig/index.ts');

/* global initTests, initCore, coreRequest, assert, cuid */

const MIN = 60 * 1000;
const TEST_SCHEMA = Object.freeze({
  ...platformConfig.SCHEMA,
  // A key of another capability than `config` (none in the release yet).
  'test-only.dnsLabel': { schema: { type: 'string', maxLength: 20 }, appliesAt: 'live', sensitive: false, capability: 'dns' },
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
    assert.deepEqual(res.body.entries.map((e) => e.key), Object.keys(TEST_SCHEMA).sort());
    assert.deepEqual(Object.keys(platformConfig.SCHEMA).sort(),
      ['service.assets.definitions', 'service.eventTypes', 'service.home', 'service.name', 'service.support', 'service.terms']);
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
      const home = await put('service.home', { value: 'https://stored-home.example.com' });
      assert.equal(home.status, 200, JSON.stringify(home.body));
      assert.equal((await put('service.home', { value: 'ftp://not-http.example.com' })).status, 400);
      // The service information reads it at once on the writing core.
      const info = await coreRequest.get('/reg/service/info');
      assert.equal(info.status, 200, JSON.stringify(info.body));
      assert.deepEqual({ name: info.body.name, home: info.body.home }, { name: 'Stored name', home: 'https://stored-home.example.com' });
      assert.ok(info.body.api != null && info.body.register != null, 'the derived URLs are still there');
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
      assert.equal((await coreRequest.get('/reg/service/info')).body.name, 'Local name');
      const again = await coreRequest.delete(BASE + '/service.name').set('authorization', adminKey);
      assert.equal(again.status, 200);
      assert.equal(again.body.deleted, false);
      assert.equal(again.body.rev, del.body.rev, 'nothing deleted: same revision');
    });
  });

  it('[SYPC3] a key outside the schema, a refused value or a malformed body is not written', async () => {
    assert.equal((await put('service.serial', { value: 'x' })).status, 404);
    assert.equal((await put('service.assets', { value: { definitions: 'https://x.example' } })).status, 404, 'an object key: its leaf only');
    assert.equal((await coreRequest.get(BASE + '/service.serial').set('authorization', adminKey)).status, 404);
    assert.equal((await coreRequest.delete(BASE + '/service.serial').set('authorization', adminKey)).status, 404);
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

  it('[SYPC7] deleting a row of a key this release does not know needs a recent second factor', async () => {
    await db.setPlatformKv(platformConfig.ROW_PREFIX + 'newer.key', JSON.stringify({ value: 3, updatedAt: 1, updatedBy: { kind: 'cli', coreId } }));
    const stale = await ownerSession(Date.now() - 60 * MIN);
    const refused = await coreRequest.delete(BASE + '/newer.key').set('authorization', 'AdminSession ' + stale);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.error.data.stepUp, true);
    assert.notEqual(await db.getPlatformKv(platformConfig.ROW_PREFIX + 'newer.key'), null, 'kept');
    const fresh = await ownerSession(Date.now());
    const ok = await coreRequest.delete(BASE + '/newer.key').set('authorization', 'AdminSession ' + fresh);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.deleted, true);
    assert.equal(await db.getPlatformKv(platformConfig.ROW_PREFIX + 'newer.key'), null);
  });

  it('[SYPC8] the audit record of a write: key and values, never the value of a sensitive key', async function () {
    if (config.get('audit:active') !== true) return this.skip();
    const audit = require('audit').default;
    const original = audit.validApiCall;
    const records = [];
    audit.validApiCall = async function (context, result) {
      // What the audit records: the calls its filter keeps (reads are declared not audited).
      if (String(context.methodId).startsWith('system.platformConfig.') && audit.filter.isAudited(context.methodId)) records.push({ methodId: context.methodId, record: context.auditIntegrityPayload });
      return await original.call(this, context, result);
    };
    try {
      assert.equal((await put('service.name', { value: 'Audited name' })).status, 200);
      assert.equal((await put('auth.passwordComplexityMinLength', { value: 23 })).status, 200);
      assert.equal((await put('auth.passwordComplexityMinLength', { value: 31 })).status, 200);
      assert.equal((await coreRequest.delete(BASE + '/auth.passwordComplexityMinLength').set('authorization', adminKey)).status, 200);
      assert.equal((await coreRequest.get(BASE).set('authorization', adminKey)).status, 200);
      for (let i = 0; i < 20 && records.length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      audit.validApiCall = original;
    }
    assert.deepEqual(records.map((r) => r.methodId), ['system.platformConfig.set', 'system.platformConfig.set', 'system.platformConfig.set', 'system.platformConfig.delete'], 'reads are not recorded');
    const [name, first, second, removed] = records.map((r) => r.record);
    assert.deepEqual({ key: name.key, before: name.before, after: name.after, changed: name.changed }, { key: 'service.name', before: null, after: 'Audited name', changed: true });
    assert.equal(name.subject.via, 'admin-key');
    assert.deepEqual({ key: first.key, before: first.before, changed: first.changed }, { key: 'auth.passwordComplexityMinLength', before: null, changed: true });
    assert.equal(first.after.set, true);
    assert.equal(second.before.set, true);
    assert.equal(removed.after, null);
    for (const r of [first, second, removed]) {
      const text = JSON.stringify(r);
      assert.ok(!/\b(23|31)\b/.test(text.replace(/"fingerprint":"[0-9a-f]+"/g, '')), 'no sensitive value in ' + text);
    }
    // The test secret is too weak for a keyed fingerprint: none at all, not an unkeyed hash.
    if (first.after.fingerprint == null) assert.deepEqual(first.after, { set: true });
  });

  it('[SYPC9] a session whose role gives no configuration permission gets 404 on every route', async () => {
    // Roles other than owner arrive with role management; an unknown role grants nothing.
    const userId = 'sypcnone' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    roleUsers.push(userId);
    await db.setPlatformKv('admin-role/' + userId, JSON.stringify({ grants: [{ role: 'support', scope: 'platform', grantedAt: Date.now() - 1000, grantedBy: 'test', via: 'grant' }], updatedAt: Date.now() - 1000 }));
    const { token } = await sessions.createAdminSession(db, { userId, homeCore: coreId, mfaAt: Date.now(), now: Date.now(), ttlMs: 60 * MIN });
    const auth = 'AdminSession ' + token;
    assert.equal((await coreRequest.get(BASE).set('authorization', auth)).status, 404);
    assert.equal((await coreRequest.get(BASE + '/service.name').set('authorization', auth)).status, 404);
    assert.equal((await put('service.name', { value: 'x' }, auth)).status, 404);
    assert.equal((await coreRequest.delete(BASE + '/service.name').set('authorization', auth)).status, 404);
    assert.deepEqual(await platformConfig.listEntries(db), []);
  });

  it('[SYPC10] lockdown: a read-only key, or a key whose own capability is locked, cannot be written; reads still work', async () => {
    await withInjectedConfig({ admin: { lockdown: { capabilities: { dns: 'readonly' }, platformConfig: { readonly: ['service.name'] } } } }, async () => {
      const key = await put('service.name', { value: 'Locked' });
      assert.equal(key.status, 403, JSON.stringify(key.body));
      assert.equal(key.body.error.id, 'admin-lockdown-key');
      assert.equal((await coreRequest.delete(BASE + '/service.name').set('authorization', adminKey)).status, 403);
      const cap = await put('test-only.dnsLabel', { value: 'x' });
      assert.equal(cap.status, 403, JSON.stringify(cap.body));
      assert.equal(cap.body.error.id, 'admin-lockdown-capability');
      assert.equal(cap.body.error.data.capability, 'dns');
      assert.equal((await put('service.home', { value: 'https://open.example.com' })).status, 200, 'another key stays editable');
      const list = await coreRequest.get(BASE).set('authorization', adminKey);
      assert.equal(list.status, 200);
      const locked = Object.fromEntries(list.body.entries.map((e) => [e.key, e.locked]));
      assert.deepEqual({ name: locked['service.name'], dns: locked['test-only.dnsLabel'], home: locked['service.home'] }, { name: true, dns: true, home: false });
    });
    assert.equal(await platformConfig.getEntry(db, 'service.name'), null);
    assert.equal(await platformConfig.getEntry(db, 'test-only.dnsLabel'), null);
  });

  it('[SYPC11] the key is taken as Express decodes it, once, with its case: other forms are unknown keys', async () => {
    for (const variant of ['service%252Ename', 'Service.Name', 'SERVICE.NAME', 'service.name%20', 'service%2Fname']) {
      assert.equal((await put(variant, { value: 'x' })).status, 404, variant);
      assert.equal((await coreRequest.delete(BASE + '/' + variant).set('authorization', adminKey)).status, 404, variant);
    }
    assert.equal((await put('service%2Ename', { value: 'Encoded dot' })).status, 200, 'one encoding is the key itself');
    assert.equal((await platformConfig.getEntry(db, 'service.name')).value, 'Encoded dot');
  });

  it('[SYPC12] the keys with platform-wide reach (assets, event types): https only, and a recent second factor; the value stays shown', async () => {
    const stale = await ownerSession(Date.now() - 60 * MIN);
    for (const key of ['service.assets.definitions', 'service.eventTypes']) {
      const refused = await put(key, { value: 'https://assets.example.com/index.json' }, 'AdminSession ' + stale);
      assert.equal(refused.status, 403, key + ': ' + JSON.stringify(refused.body));
      assert.equal(refused.body.error.data.stepUp, true, key);
      assert.equal((await put(key, { value: 'http://assets.example.com/index.json' })).status, 400, key + ': http refused');
    }
    assert.deepEqual(await platformConfig.listEntries(db), []);
    const fresh = await ownerSession(Date.now());
    const ok = await put('service.assets.definitions', { value: 'https://assets.example.com/index.json' }, 'AdminSession ' + fresh);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual({ value: ok.body.entry.value, sensitive: ok.body.entry.sensitive, stepUp: ok.body.entry.stepUp },
      { value: 'https://assets.example.com/index.json', sensitive: false, stepUp: true });
    assert.equal((await put('service.home', { value: 'https://home.example.com' }, 'AdminSession ' + stale)).status, 200, 'other keys: no step-up');
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
      const doc = JSON.parse(exported.stdout.slice(exported.stdout.indexOf('{')));
      assert.deepEqual({ entries: doc.entries, otherKeys: doc.otherKeys }, { entries: {}, otherKeys: { 'old.key': 'kept' } });
      const listed = run(['list']);
      assert.equal(listed.status, 0, listed.stderr);
      assert.match(listed.stdout, /old\.key = "kept" {2}\[not a key of this release: ignored here, a newer core may use it\]/);
      // An export imports back (its rows of other keys are left out); a row of another release is refused.
      const fs = require('node:fs');
      const os = require('node:os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sypc-'));
      try {
        fs.writeFileSync(path.join(dir, 'export.json'), JSON.stringify(doc));
        const back = run(['import', path.join(dir, 'export.json')]);
        assert.equal(back.status, 0, back.stderr);
        assert.match(back.stdout, /Not imported \(keys this release does not know\): old\.key/);
        assert.match(back.stdout, /0 key\(s\) imported/);
        fs.writeFileSync(path.join(dir, 'stale.json'), JSON.stringify({ entries: { 'old.key': 'x' } }));
        const stale = run(['import', path.join(dir, 'stale.json')]);
        assert.equal(stale.status, 1);
        assert.match(stale.stderr, /nothing imported:\n {2}old\.key: not a key of this release/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const unset = run(['unset', 'old.key']);
      assert.equal(unset.status, 0, unset.stderr);
      assert.equal(await db.getPlatformKv(platformConfig.ROW_PREFIX + 'old.key'), null);
    });
  });
});
