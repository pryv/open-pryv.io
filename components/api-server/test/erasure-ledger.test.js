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
 * The erasure ledger: a durable record of each erased account, in the
 * platform database, naming the account by keyed hashes only.
 * [ERLG] the record written by an erasure (each trigger, nothing personal,
 * resumed when its write failed, replaced by a later erasure);
 * [ERLA] the admin routes; [ERLR] restores and platform backups;
 * [ERLT] bin/erasures.js and the retention pass.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const sinon = require('sinon');
const { getConfig } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');
const { childStorageEngineEnv, withInjectedConfig } = require('test-helpers');
const { Deletion } = require('business/src/auth/deletion.ts');
const { getErasuresLocal } = require('business/src/auth/erasures.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getPlatform } = require('platform');
const ledger = require('business/src/erasureLedger/index.ts');
const { describeErasureLedgerConfig } = require('business/src/erasureLedger/config.ts');
const { createAccountAutoDeletionSweep, purgeErasureLedger } = require('api-server/src/methods/helpers/autoDeletionSweep.ts');
const RestoreOrchestrator = require('business/src/backup/RestoreOrchestrator.ts').default;
const BackupOrchestrator = require('business/src/backup/BackupOrchestrator.ts').default;
const { createFilesystemBackupReader } = require('storages/interfaces/backup/index.ts');

const BACKUP_CLI = path.resolve(__dirname, '../../../bin/backup.js');
const ERASURES_CLI = path.resolve(__dirname, '../../../bin/erasures.js');
const REPO_ROOT = path.resolve(__dirname, '../../../');
const STALE_MS = 16 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Synthetic rows of the route and tool tests: erased "in 2096", after any
// row a real erasure of the test run writes.
const FUTURE = 4e12;
const STEPS_BEFORE_LEDGER = ['runTeardownSteps', 'deleteUserFiles', 'deleteHFData', 'deleteAttachments', 'deleteAuditDataStorage', 'deleteUser', 'deleteAuditDataStorageAgain', 'deleteAuditData', 'dropHFDataAgain'];

function runCli (cli, args) {
  const env = { ...process.env, ...childStorageEngineEnv() };
  delete env.PRYV_BACKUP_PASSPHRASE;
  const res = spawnSync('node', [cli, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 90000 });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function assertOk (res, what) {
  assert.strictEqual(res.status, 0, what + '\n' + res.stdout + res.stderr);
}

/** Tamper every event of a plaintext backup, listing the files again in their run's table: a backup whose content fails --verify-integrity. */
function tamperBackupEvents (backupDir) {
  const zlib = require('node:zlib');
  const crypto = require('node:crypto');
  const files = fs.readdirSync(backupDir, { recursive: true }).map(String).filter((f) => /(^|\/)events-[0-9]+\.jsonl(\.gz)?$/.test(f));
  assert.ok(files.length > 0, 'events file of the backup');
  for (const f of files) {
    const file = path.join(backupDir, f);
    const gz = f.endsWith('.gz');
    const text = gz ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8');
    const changed = text.split('\n').map((line) => line.trim() === '' ? line : JSON.stringify({ ...JSON.parse(line), content: 'tampered' })).join('\n');
    const out = Buffer.from(changed, 'utf8');
    fs.writeFileSync(file, gz ? zlib.gzipSync(out) : out);
    const manifestPath = path.join(backupDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bytes = fs.readFileSync(file);
    const entry = manifest.integrity.files.find((e) => e.path === f.split(path.sep).join('/'));
    entry.size = bytes.length;
    entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
}

describe('[ERLG] erasure ledger', function () {
  this.timeout(300000);

  let config, storageLayer, usersRepository, platform, key, adminKey, tmpDir;
  const fixtures = [];
  const syntheticKeys = [];

  before(async function () {
    await initTests();
    await initCore();
    const app = globalThis.app;
    if (!app.systemAPI.has('system.erasures.list')) {
      await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    }
    config = await getConfig();
    storageLayer = await getStorageLayer();
    usersRepository = await getUsersRepository();
    platform = await getPlatform();
    key = ledger.ledgerKey(config);
    adminKey = config.get('auth:adminAccessKey');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erasure-ledger-'));
  });

  after(async function () {
    for (const k of syntheticKeys) await platform.deletePlatformKv(k);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const f of fixtures) await f.clean();
  });

  function freshName (prefix) {
    return (prefix + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 22);
  }

  /** An account with one stream holding one event. */
  async function account (prefix = 'erlg', username = freshName(prefix)) {
    const fx = getNewFixture();
    fixtures.push(fx);
    const fu = await fx.user(username);
    const streamId = 'erl-' + cuid().slice(-10);
    const stream = await fu.stream({ id: streamId, name: 'ERL ' + streamId });
    await stream.event({ type: 'note/txt', content: 'some data' });
    return { id: fu.attrs.id, username, streamId };
  }

  /** The erasure steps auth.delete runs, in this process: `deletionByAdmin` as its admin-key check sets it. */
  async function eraseAsAuthDelete (u, { byAdmin }) {
    const deletion = new Deletion(null, storageLayer, config);
    const context = { user: { id: u.id, username: u.username }, deletionByAdmin: byAdmin };
    for (const step of deletion.erasureSteps()) {
      await new Promise((resolve, reject) => step(context, {}, {}, (err) => err != null ? reject(err) : resolve()));
    }
  }

  async function exists (u) {
    return (await usersRepository.getUserIdForUsername(u.username)) === u.id;
  }

  async function rowOf (u) {
    return await ledger.readErasureRecord(platform, key, u.id);
  }

  async function rawRowOf (u) {
    return await platform.getPlatformKv(ledger.LEDGER_PREFIX + ledger.userIdHash(key, u.id));
  }

  async function dropRow (u) {
    await platform.deletePlatformKv(ledger.LEDGER_PREFIX + ledger.userIdHash(key, u.id));
  }

  /** Erase `u` for good (no ledger row left), whatever state the test left it in. */
  async function cleanUp (u) {
    const store = await getErasuresLocal();
    await store.delete(u.id);
    if (await exists(u)) await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { teardown: false });
    await store.delete(u.id);
    await dropRow(u);
  }

  /** A synthetic ledger row (route and tool tests), removed after the suite. */
  async function syntheticRow (deletedAt, overrides = {}) {
    const userId = 'erlsyn' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(-14);
    const username = overrides.username ?? freshName('erlsynname');
    const entry = await ledger.writeErasureRecord(platform, key, {
      userId, username, startedAt: deletedAt - 1000, deletedAt, trigger: overrides.trigger ?? 'date', coreId: 'erl-core', stepsCompleted: STEPS_BEFORE_LEDGER, auditMode: 'erase', attempts: 1, serverVersion: 'test'
    });
    syntheticKeys.push(ledger.LEDGER_PREFIX + entry.userIdHash);
    return { userId, username, entry };
  }

  /** A sweep pass that only completes the unfinished erasures of `users`. */
  async function completionPass (users) {
    const ids = new Set(users.map((u) => u.id));
    const lines = [];
    const logger = {};
    for (const level of ['info', 'warn', 'error']) logger[level] = (msg) => lines.push({ level, msg });
    const sweep = await createAccountAutoDeletionSweep(config, {
      listAccounts: async () => [],
      listPendingErasures: async () => (await (await getErasuresLocal()).listAll()).filter((r) => ids.has(r.userId)),
      logger
    });
    return { result: await sweep.runPass(), lines };
  }

  // ------------------------------------------------------------ [ERLG] the record

  for (const [code, byAdmin, trigger] of [['ERLG1', false, 'holder'], ['ERLG2', true, 'admin']]) {
    it(`[${code}] an erasure by ${byAdmin ? 'the admin key' : 'the holder'} writes a record with trigger ${trigger}`, async function () {
      const u = await account();
      const before = Date.now();
      try {
        await eraseAsAuthDelete(u, { byAdmin });
        assert.equal(await exists(u), false);
        const row = await rowOf(u);
        assert.ok(row != null, 'a ledger record');
        assert.equal(row.trigger, trigger);
        assert.equal(row.v, 1);
        assert.equal(row.keyId, key.keyId);
        assert.equal(row.usernameHash, ledger.usernameHash(key, u.username));
        assert.equal(row.coreId, platform.coreId);
        assert.equal(row.auditMode, 'erase');
        assert.equal(row.attempts, 1);
        assert.equal(typeof row.serverVersion, 'string');
        assert.ok(row.deletedAt >= before && row.deletedAt <= Date.now(), 'deletedAt is the erasure time');
        assert.ok(row.startedAt <= row.deletedAt);
        assert.deepEqual(row.stepsCompleted, STEPS_BEFORE_LEDGER);
        assert.equal(row.restoredAt, undefined);
        assert.equal(await (await getErasuresLocal()).get(u.id), null, 'the record of the erasure in progress is gone');
      } finally {
        await cleanUp(u);
      }
    });
  }

  it('[ERLG3] an erasure decided by the auto-deletion (date, inactivity) or the registration reconcile keeps its trigger', async function () {
    for (const trigger of ['date', 'inactivity', 'transfer-fallback', 'unfinished-registration']) {
      const u = await account();
      try {
        assert.equal(await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger }), true);
        const row = await rowOf(u);
        assert.ok(row != null, 'a ledger record for ' + trigger);
        assert.equal(row.trigger, trigger);
      } finally {
        await cleanUp(u);
      }
    }
  });

  it('[ERLG4] the record holds no username, user id, email or account data in clear', async function () {
    const u = await account();
    const email = await (await require('storage').getUserAccountStorage()).getAccountField(u.id, 'email');
    try {
      await eraseAsAuthDelete(u, { byAdmin: true });
      const raw = await rawRowOf(u);
      assert.ok(raw != null);
      for (const clear of [u.id, u.username, u.streamId, email].filter((s) => typeof s === 'string' && s.length > 0)) {
        assert.ok(!raw.toLowerCase().includes(clear.toLowerCase()), `"${clear}" is not in the stored record: ${raw}`);
      }
      assert.deepEqual(Object.keys(JSON.parse(raw)).sort(),
        ['attempts', 'auditMode', 'coreId', 'deletedAt', 'keyId', 'serverVersion', 'startedAt', 'stepsCompleted', 'trigger', 'usernameHash', 'v']);
    } finally {
      await cleanUp(u);
    }
  });

  it('[ERLG5] the rollback of a failed account creation (trigger system) writes no record', async function () {
    const u = await account();
    try {
      await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { teardown: false });
      assert.equal(await exists(u), false);
      assert.equal(await rowOf(u), null);
    } finally {
      await cleanUp(u);
    }
  });

  it('[ERLG6] a record write that fails fails the erasure; the sweep completes it and writes the record once', async function () {
    const u = await account();
    const original = platform.setPlatformKv;
    let refused = 0;
    const stub = sinon.stub(platform, 'setPlatformKv').callsFake(async function (k, v) {
      if (k.startsWith(ledger.LEDGER_PREFIX)) { refused++; throw new Error('injected platform write failure'); }
      return original.call(platform, k, v);
    });
    let stubbed = true;
    const unstub = () => { if (stubbed) { stubbed = false; stub.restore(); } };
    try {
      let err = null;
      try {
        await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'date' });
      } catch (e) {
        err = e;
      } finally {
        unstub();
      }
      assert.ok(err != null, 'the erasure fails');
      assert.equal(refused, 1);
      assert.equal(await exists(u), false, 'the data is gone all the same');
      assert.equal(await rowOf(u), null, 'no record yet');
      const store = await getErasuresLocal();
      const record = await store.get(u.id);
      assert.ok(record != null, 'the record of the erasure in progress stays');
      assert.deepEqual(record.doneSteps, STEPS_BEFORE_LEDGER);
      assert.match(String(record.lastError), /^writeErasureLedger: /);
      await store.put({ ...record, updatedAt: record.updatedAt - STALE_MS });

      const { result, lines } = await completionPass([u]);
      assert.equal(result.completed, 1, JSON.stringify(lines));
      const row = await rowOf(u);
      assert.ok(row != null, 'the resumed erasure writes the record');
      assert.equal(row.trigger, 'date');
      assert.equal(row.attempts, 2);
      assert.equal(await store.get(u.id), null);
    } finally {
      unstub();
      await cleanUp(u);
    }
  });

  it('[ERLG7] a later erasure of the same id (restored, erased again) replaces the record, without restoredAt', async function () {
    const username = freshName('erlg');
    const u = await account('erlg', username);
    try {
      await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username }, { trigger: 'date' });
      const first = await rowOf(u);
      assert.ok(await ledger.markRestored(platform, key, u.id, Date.now()));
      assert.ok((await rowOf(u)).restoredAt != null);
      // the account exists again under the same id
      assert.equal((await account('erlg', username)).id, u.id, 'fixtures give the account the id of its name');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username }, { trigger: 'inactivity' });
      const second = await rowOf(u);
      assert.equal(second.trigger, 'inactivity');
      assert.ok(second.deletedAt > first.deletedAt);
      assert.equal(second.restoredAt, undefined);
    } finally {
      await cleanUp(u);
    }
  });

  it('[ERLG8] with accountErasure.ledger.enabled false, an erasure writes no record; the audit keep mode is recorded', async function () {
    const off = await account();
    const kept = await account();
    try {
      await withInjectedConfig({ accountErasure: { ledger: { enabled: false } } }, async () => {
        await eraseAsAuthDelete(off, { byAdmin: true });
      });
      assert.equal(await exists(off), false);
      assert.equal(await rowOf(off), null);
      await withInjectedConfig({ audit: { onUserDelete: 'keep' } }, async () => {
        await eraseAsAuthDelete(kept, { byAdmin: true });
      });
      assert.equal((await rowOf(kept)).auditMode, 'keep');
    } finally {
      const auditStorage = require('storages').auditStorage;
      if (auditStorage != null) await auditStorage.deleteUser(kept.id).catch(() => {});
      await require('storage').userLocalDirectory.deleteUserDirectory(kept.id).catch(() => {});
      await cleanUp(off);
      await cleanUp(kept);
    }
  });

  it('[ERLG9] an unfinished erasure recorded without a trigger (an earlier version) gets a record with trigger unknown when the sweep completes it', async function () {
    const u = await account();
    const fault = sinon.stub(Deletion.prototype, 'deleteAuditDataStorage').callsFake(function (context, params, result, next) { next(new Error('injected fault')); });
    try {
      try {
        await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'date' });
      } catch (e) { /* stops at the injected fault */ } finally {
        fault.restore();
      }
      const store = await getErasuresLocal();
      const record = await store.get(u.id);
      assert.ok(record != null);
      await store.put({ ...record, trigger: null, updatedAt: record.updatedAt - STALE_MS });
      const { result, lines } = await completionPass([u]);
      assert.equal(result.completed, 1, JSON.stringify(lines));
      const row = await rowOf(u);
      assert.ok(row != null, 'a record, not taken for a creation rollback');
      assert.equal(row.trigger, 'unknown');
    } finally {
      await cleanUp(u);
    }
  });

  // ------------------------------------------------------------ [ERLA] admin routes

  describe('[ERLA] admin routes', function () {
    let rows;
    before(async function () {
      rows = [];
      for (let i = 0; i < 3; i++) rows.push(await syntheticRow(FUTURE + i * 1000));
    });

    it('[ERLA1] both routes answer unknown resource without the admin key', async function () {
      const list = await coreRequest.get('/system/admin/erasures').query({ since: FUTURE });
      assert.equal(list.status, 404, JSON.stringify(list.body));
      const lookup = await coreRequest.post('/system/admin/erasures/lookup').set('Authorization', 'not-the-key').send({ userId: rows[0].userId });
      assert.equal(lookup.status, 404, JSON.stringify(lookup.body));
      assert.equal(lookup.body.erasures, undefined);
    });

    it('[ERLA2] the listing returns the records erased since a time, oldest first, hashes only', async function () {
      const res = await coreRequest.get('/system/admin/erasures').set('Authorization', adminKey).query({ since: FUTURE + 1000 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.erasures.map((e) => e.userIdHash), rows.slice(1).map((r) => r.entry.userIdHash));
      assert.equal(res.body.next, null);
      const [first] = res.body.erasures;
      assert.equal(first.deletedAt, FUTURE + 1000);
      assert.equal(first.trigger, 'date');
      assert.equal(first.coreId, 'erl-core');
      const text = JSON.stringify(res.body);
      for (const r of rows) assert.ok(!text.includes(r.userId) && !text.includes(r.username), 'no id or name in clear');
    });

    it('[ERLA3] the listing pages with limit and the next cursor; malformed parameters are refused', async function () {
      const seen = [];
      let after;
      for (let i = 0; i < 5; i++) {
        const res = await coreRequest.get('/system/admin/erasures').set('Authorization', adminKey).query({ since: FUTURE, limit: 1, ...(after != null ? { after } : {}) });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        seen.push(...res.body.erasures.map((e) => e.userIdHash));
        after = res.body.next;
        if (after == null) break;
      }
      assert.deepEqual(seen, rows.map((r) => r.entry.userIdHash));
      for (const query of [{ limit: 0 }, { limit: 1001 }, { limit: 'x' }, { since: -1 }, { since: '' }, { after: 'nope' }]) {
        const res = await coreRequest.get('/system/admin/erasures').set('Authorization', adminKey).query(query);
        assert.equal(res.status, 400, JSON.stringify(query) + ' ' + JSON.stringify(res.body));
      }
    });

    it('[ERLA4] the lookup finds an erasure by user id, or by username in any case; an unknown one is not erased', async function () {
      const target = rows[1];
      const byId = await coreRequest.post('/system/admin/erasures/lookup').set('Authorization', adminKey).send({ userId: target.userId });
      assert.equal(byId.status, 200, JSON.stringify(byId.body));
      assert.equal(byId.body.erased, true);
      assert.deepEqual(byId.body.erasures.map((e) => e.userIdHash), [target.entry.userIdHash]);
      const byName = await coreRequest.post('/system/admin/erasures/lookup').set('Authorization', adminKey).send({ username: target.username.toUpperCase() });
      assert.equal(byName.status, 200, JSON.stringify(byName.body));
      assert.deepEqual(byName.body.erasures.map((e) => e.userIdHash), [target.entry.userIdHash]);
      const unknown = await coreRequest.post('/system/admin/erasures/lookup').set('Authorization', adminKey).send({ username: freshName('erlnobody') });
      assert.equal(unknown.status, 200);
      assert.equal(unknown.body.erased, false);
      assert.deepEqual(unknown.body.erasures, []);
      assert.equal(unknown.body.keyId, key.keyId, 'the key the lookup matched with');
      assert.equal(typeof unknown.body.otherKeyRecords, 'number');
    });

    it('[ERLA6] a record written under another key is counted in the lookup answer, never matched', async function () {
      const otherKey = ledger.ledgerKey({ get: (k) => k === 'accountErasure:ledger:hmacKey' ? require('node:crypto').randomBytes(32).toString('base64') : undefined });
      const userId = 'erlother' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(-12);
      const before = (await coreRequest.post('/system/admin/erasures/lookup').set('Authorization', adminKey).send({ userId })).body.otherKeyRecords;
      const entry = await ledger.writeErasureRecord(platform, otherKey, {
        userId, username: userId, startedAt: FUTURE + 500, deletedAt: FUTURE + 600, trigger: 'date', coreId: 'erl-core', stepsCompleted: [], auditMode: 'erase', attempts: 1, serverVersion: 'test'
      });
      syntheticKeys.push(ledger.LEDGER_PREFIX + entry.userIdHash);
      ledger.ledgerKey(config); // the cached key back to this platform's
      const res = await coreRequest.post('/system/admin/erasures/lookup').set('Authorization', adminKey).send({ userId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.erased, false);
      assert.equal(res.body.otherKeyRecords, before + 1);
    });

    it('[ERLA5] the lookup needs exactly one of userId or username', async function () {
      for (const body of [{}, { userId: 'a', username: 'b' }, { userId: '' }, { username: 3 }, { userId: 'a', other: 1 }]) {
        const res = await coreRequest.post('/system/admin/erasures/lookup').set('Authorization', adminKey).send(body);
        assert.equal(res.status, 400, JSON.stringify(body) + ' ' + JSON.stringify(res.body));
      }
    });
  });

  // ------------------------------------------------------------ [ERLR] restore and backup

  describe('[ERLR] restore and backup', function () {
    async function backedUpAccount () {
      const u = await account('erlr');
      u.dir = path.join(tmpDir, u.username);
      assertOk(runCli(BACKUP_CLI, ['--output', u.dir, '--user', u.username]), 'backup');
      return u;
    }

    it('[ERLR1] an account erased after its backup is not restored: --user fails, a whole restore of it alone exits 3', async function () {
      const u = await backedUpAccount();
      try {
        await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'inactivity' });
        const single = runCli(BACKUP_CLI, ['--restore', u.dir, '--user', u.username, '--overwrite']);
        assert.equal(single.status, 1, single.stdout + single.stderr);
        assert.match(single.stderr, /was erased on .*after this backup.*--restore-erased/);
        assert.equal(await exists(u), false);
        const whole = runCli(BACKUP_CLI, ['--restore', u.dir]);
        assert.equal(whole.status, 3, whole.stdout + whole.stderr);
        assert.match(whole.stdout, /Erased after this backup \(not restored; --restore-erased restores them\): 1 users/);
        assert.match(whole.stdout, /Restored: 0 users/);
        assert.equal(await exists(u), false);
        assert.equal((await rowOf(u)).restoredAt, undefined, 'the record is unchanged');
      } finally {
        await cleanUp(u);
      }
    });

    it('[ERLR2] --restore-erased restores it and stamps restoredAt; the same backup then restores without it', async function () {
      const u = await backedUpAccount();
      try {
        await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'date' });
        const erasedAt = (await rowOf(u)).deletedAt;
        const res = runCli(BACKUP_CLI, ['--restore', u.dir, '--user', u.username, '--restore-erased']);
        assertOk(res, 'restore with --restore-erased');
        assert.ok(await exists(u), 'the account is back');
        const row = await rowOf(u);
        assert.equal(row.deletedAt, erasedAt, 'the record is kept');
        assert.ok(row.restoredAt >= erasedAt, 'marked restored');
        assertOk(runCli(BACKUP_CLI, ['--restore', u.dir, '--user', u.username, '--overwrite']), 'a later restore of the same backup');
      } finally {
        await cleanUp(u);
      }
    });

    it('[ERLR6] --restore-erased with --verify-integrity: an account rolled back stays recorded as erased (no restoredAt)', async function () {
      const u = await backedUpAccount();
      try {
        await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'date' });
        tamperBackupEvents(u.dir);
        const res = runCli(BACKUP_CLI, ['--restore', u.dir, '--user', u.username, '--restore-erased', '--verify-integrity']);
        assert.equal(res.status, 1, res.stdout + res.stderr);
        assert.match(res.stdout, /Rolled back: /);
        require('cache').default.unsetUserById(u.id);
        assert.ok(await (await require('storage').getUsersLocalIndex()).getUsername(u.id) == null, 'rolled back');
        const row = await rowOf(u);
        assert.equal(row.restoredAt, undefined, 'not marked restored');
        const again = runCli(BACKUP_CLI, ['--restore', u.dir, '--user', u.username, '--overwrite']);
        assert.equal(again.status, 1, 'a later plain restore is still refused\n' + again.stdout + again.stderr);
        assert.match(again.stderr, /--restore-erased/);
      } finally {
        await cleanUp(u);
      }
    });

    it('[ERLR7] a restore that cannot build the ledger key fails closed, unless --restore-erased', async function () {
      const u = await backedUpAccount();
      try {
        const o = await new RestoreOrchestrator().init();
        o.ledgerConfig = { get: (k) => k === 'accountErasure:ledger:hmacKey' ? 'not-a-key' : config.get(k) };
        const reader = createFilesystemBackupReader(u.dir);
        await assert.rejects(o.restoreUser(u.id, reader, { overwrite: true }), /the erasure ledger cannot be consulted .*--restore-erased/);
        const report = await o.restoreUser(u.id, reader, { overwrite: true, restoreErased: true });
        await reader.close();
        assert.deepEqual(report.restored.map((r) => r.userId), [u.id]);
        assert.ok(await exists(u));
      } finally {
        await cleanUp(u);
      }
    });

    it('[ERLR8] an erasure started after the backup and stopped unfinished refuses a plain restore; --restore-erased writes its record, marked restored', async function () {
      const u = await backedUpAccount();
      const fault = sinon.stub(Deletion.prototype, 'deleteAuditDataStorage').callsFake(function (context, params, result, next) { next(new Error('injected fault')); });
      try {
        try {
          await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'inactivity' });
        } catch (e) { /* stops at the injected fault */ } finally {
          fault.restore();
        }
        const store = await getErasuresLocal();
        const record = await store.get(u.id);
        assert.ok(record != null && !record.doneSteps.includes('writeErasureLedger'));
        await store.put({ ...record, updatedAt: record.updatedAt - STALE_MS });
        assert.equal(await rowOf(u), null, 'no ledger record yet');

        const plain = runCli(BACKUP_CLI, ['--restore', u.dir, '--user', u.username, '--overwrite']);
        assert.equal(plain.status, 1, plain.stdout + plain.stderr);
        assert.match(plain.stderr, /stopped unfinished on this core, after this backup.*--restore-erased/);
        assert.ok(await store.get(u.id) != null, 'the erasure is not withdrawn');

        const override = runCli(BACKUP_CLI, ['--restore', u.dir, '--user', u.username, '--overwrite', '--restore-erased']);
        assertOk(override, 'restore with --restore-erased');
        assert.equal(await store.get(u.id), null, 'withdrawn by the restore');
        const row = await rowOf(u);
        assert.ok(row != null, 'its record is written');
        assert.equal(row.trigger, 'inactivity');
        assert.ok(row.restoredAt >= row.deletedAt, 'already marked restored');
      } finally {
        await cleanUp(u);
      }
    });

    it('[ERLR9] a record that cannot be marked restored is returned by stampRestored (the CLI lists it and exits 4)', async function () {
      const o = await new RestoreOrchestrator().init();
      const userId = 'erlnorow' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '').slice(-12);
      const ref = { userId, username: userId, deletedAt: 1, trigger: 'date', snapshotBefore: 0 };
      assert.deepEqual(await o.stampRestored([ref]), [ref], 'no record to mark: failed');
      o.ledgerConfig = { get: (k) => k === 'accountErasure:ledger:hmacKey' ? 'not-a-key' : config.get(k) };
      assert.deepEqual(await o.stampRestored([ref]), [ref], 'no key: failed');
    });

    it('[ERLR3] a whole-backup restore skips the erased account, lists it and restores the others', async function () {
      const erased = await backedUpAccount();
      const kept = await backedUpAccount();
      try {
        await new Deletion(null, storageLayer, config).eraseAccount({ id: erased.id, username: erased.username }, { trigger: 'holder' });
        await new Deletion(null, storageLayer, config).eraseAccount({ id: kept.id, username: kept.username }, { teardown: false });
        const readers = [erased, kept].map((u) => createFilesystemBackupReader(u.dir));
        const manifests = [];
        for (const r of readers) manifests.push(await r.readManifest());
        const combined = {
          async readManifest () { return { ...manifests[0], users: manifests.flatMap((m) => m.users) }; },
          async openUser (userId) { return readers[[erased, kept].findIndex((u) => u.id === userId)].openUser(userId); },
          async * readPlatformData () {},
          async * readServerMappings () {}
        };
        const o = await new RestoreOrchestrator().init();
        const report = await o.restoreAllUsers(combined, {});
        for (const r of readers) await r.close();
        assert.deepEqual(report.erasedSince.map((r) => r.userId), [erased.id]);
        assert.equal(report.erasedSince[0].trigger, 'holder');
        assert.deepEqual(report.restored.map((r) => r.userId), [kept.id], 'the rollback of a creation left no record: restored');
        assert.equal(await exists(erased), false);
        assert.ok(await exists(kept));
      } finally {
        await cleanUp(erased);
        await cleanUp(kept);
      }
    });

    it('[ERLR4] a platform backup carries the ledger; a restore merges it: absent rows written, newer kept, none removed', async function () {
      const a = await syntheticRow(FUTURE + 10000);
      const b = await syntheticRow(FUTURE + 20000);
      const backup = await new BackupOrchestrator().init();
      const exported = [];
      await backup._backupPlatform({ async writePlatformData (data) { for await (const d of data) exported.push(d); } });
      const exportedKeys = exported.filter((e) => typeof e.key === 'string').map((e) => e.key);
      for (const r of [a, b]) assert.ok(exportedKeys.includes(ledger.LEDGER_PREFIX + r.entry.userIdHash), 'the ledger rows are in the platform backup');

      // a platform rebuilt without row a; row b replaced by a newer erasure
      const keyA = ledger.LEDGER_PREFIX + a.entry.userIdHash;
      const keyB = ledger.LEDGER_PREFIX + b.entry.userIdHash;
      await platform.deletePlatformKv(keyA);
      const newerB = { ...JSON.parse(await platform.getPlatformKv(keyB)), deletedAt: FUTURE + 30000 };
      await platform.setPlatformKv(keyB, JSON.stringify(newerB));
      const live = await syntheticRow(FUTURE + 40000);

      const rowsOfBackup = exported.filter((e) => e.key === keyA || e.key === keyB);
      const o = await new RestoreOrchestrator().init();
      await o.restorePlatform({
        async readManifest () { return { formatVersion: 1, backupType: 'full', users: [] }; },
        async * readPlatformData () { yield * rowsOfBackup; },
        async * readServerMappings () {}
      });
      assert.equal(ledger.parseRow(await platform.getPlatformKv(keyA)).deletedAt, FUTURE + 10000, 'absent row written');
      assert.equal(ledger.parseRow(await platform.getPlatformKv(keyB)).deletedAt, FUTURE + 30000, 'the newer erasure is kept');
      assert.ok(await platform.getPlatformKv(ledger.LEDGER_PREFIX + live.entry.userIdHash) != null, 'a row absent from the backup stays');
    });

    it('[ERLR5] a chain restore dates each account by the newest run that holds it', async function () {
      const u = await backedUpAccount();
      try {
        const first = await createFilesystemBackupReader(u.dir).readManifest();
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assertOk(runCli(BACKUP_CLI, ['--output', u.dir, '--user', u.username, '--incremental']), 'incremental');
        const reader = createFilesystemBackupReader(u.dir);
        const merged = await reader.readManifest();
        await reader.close();
        assert.ok(merged.runs.length === 2, JSON.stringify(merged.runs));
        const second = merged.runs[1].snapshotBefore;
        assert.ok(second > first.snapshotBefore);
        assert.equal(merged.snapshotBeforeByUser[u.id], second);
        // erased between the two runs: the chain holds it as of the second, nothing to refuse
        await ledger.writeErasureRecord(platform, key, {
          userId: u.id, username: u.username, startedAt: first.snapshotBefore * 1000 + 1, deletedAt: first.snapshotBefore * 1000 + 2, trigger: 'date', coreId: 'erl-core', stepsCompleted: [], auditMode: 'erase', attempts: 1, serverVersion: 'test'
        });
        const o = await new RestoreOrchestrator().init();
        const verdict = await o._erasedSinceBackup(merged, [{ userId: u.id, username: u.username }], false);
        assert.deepEqual(verdict.refused, []);
        const asOfFirst = await o._erasedSinceBackup(first, [{ userId: u.id, username: u.username }], false);
        assert.deepEqual(asOfFirst.refused.map((r) => r.userId), [u.id], 'as of the first run alone, it was erased after');
      } finally {
        await cleanUp(u);
      }
    });
  });

  // ------------------------------------------------------------ [ERLT] tool and retention

  describe('[ERLT] bin/erasures.js and retention', function () {
    it('[ERLT1] --list prints the records since a time, no id or name in clear', async function () {
      const r = await syntheticRow(FUTURE + 100000);
      const res = runCli(ERASURES_CLI, ['--list', '--since', String(FUTURE + 100000)]);
      assertOk(res, 'list');
      assert.match(res.stdout, new RegExp(r.entry.userIdHash.slice(0, 16)));
      assert.match(res.stdout, /1 erasure record\(s\) since /);
      assert.ok(!res.stdout.includes(r.userId) && !res.stdout.includes(r.username));
    });

    it('[ERLT2] --check answers by user id and by username', async function () {
      const r = await syntheticRow(FUTURE + 200000, { trigger: 'admin' });
      const byId = runCli(ERASURES_CLI, ['--check', r.userId]);
      assertOk(byId, 'check id');
      assert.match(byId.stdout, /user id: erased .*trigger admin/);
      const byName = runCli(ERASURES_CLI, ['--check', r.username]);
      assertOk(byName, 'check name');
      assert.match(byName.stdout, /username: erased .*trigger admin/);
      const none = runCli(ERASURES_CLI, ['--check', freshName('erlnobody')]);
      assertOk(none, 'check unknown');
      assert.match(none.stdout, /Not in the erasure ledger/);
    });

    it('[ERLT3] --replay counts the accounts a storage restore brought back; --apply erases them again', async function () {
      const u = await account('erlt');
      try {
        // as if the storage were restored from before the erasure: the
        // account is here, the ledger says it was erased
        const firstDeletedAt = Date.now() - 1000;
        await ledger.writeErasureRecord(platform, key, {
          userId: u.id, username: u.username, startedAt: Date.now() - 2000, deletedAt: firstDeletedAt, trigger: 'holder', coreId: platform.coreId, stepsCompleted: STEPS_BEFORE_LEDGER, auditMode: 'erase', attempts: 1, serverVersion: 'test'
        });
        const dry = runCli(ERASURES_CLI, ['--replay']);
        assertOk(dry, 'dry run');
        assert.match(dry.stdout, /[1-9][0-9]* recorded as erased in the ledger and not restored since/);
        // Listed by id (the tool prints no name; fixtures give an account the
        // id of its name, so the two cannot be told apart in this output).
        assert.match(dry.stdout, new RegExp(`would erase ${u.id}: erased on \\S+, trigger holder`), 'the dry run lists the ids');
        assert.match(dry.stdout, /Dry run: nothing erased/);
        assert.ok(await exists(u), 'the dry run erases nothing');
        const applied = runCli(ERASURES_CLI, ['--replay', '--apply']);
        assertOk(applied, 'apply');
        assert.match(applied.stdout, /account\(s\) erased again, 0 failed/);
        // erased by another process: read the users index, not this process's cache
        assert.ok(await (await require('storage').getUsersLocalIndex()).getUsername(u.id) == null, 'erased again');
        require('cache').default.unsetUserById(u.id);
        const row = await rowOf(u);
        assert.equal(row.trigger, 'ledger-replay');
        assert.equal(row.firstTrigger, 'holder', 'the first erasure is kept');
        assert.equal(row.firstDeletedAt, firstDeletedAt);
      } finally {
        await cleanUp(u);
      }
    });

    it('[ERLT4] the retention pass removes the records older than retentionDays; 0 keeps them', async function () {
      const now = Date.now();
      const old = await syntheticRow(now - 11 * DAY_MS);
      const recent = await syntheticRow(now - 9 * DAY_MS);
      const keyOf = (r) => ledger.LEDGER_PREFIX + r.entry.userIdHash;
      await withInjectedConfig({ accountErasure: { ledger: { retentionDays: 0 } } }, async () => {
        assert.equal(await purgeErasureLedger(config, now), 0);
      });
      assert.ok(await platform.getPlatformKv(keyOf(old)) != null, 'kept with retention 0');
      await withInjectedConfig({ accountErasure: { ledger: { retentionDays: 10 } } }, async () => {
        assert.ok(await purgeErasureLedger(config, now) >= 1);
      });
      assert.equal(await platform.getPlatformKv(keyOf(old)), null, 'older than 10 days: removed');
      assert.ok(await platform.getPlatformKv(keyOf(recent)) != null, 'younger: kept');
    });

    it('[ERLT5] the configuration check refuses malformed values and warns on a short retention', function () {
      assert.deepEqual(describeErasureLedgerConfig({ enabled: true, retentionDays: 1825, hmacKey: '' }), { problems: [], warnings: [] });
      const bad = describeErasureLedgerConfig({ enabled: 'yes', retentionDays: -1, hmacKey: 'c2hvcnQ=' });
      assert.deepEqual(bad.problems.map((p) => p.path.join('.')), ['accountErasure.ledger.enabled', 'accountErasure.ledger.retentionDays', 'accountErasure.ledger.hmacKey']);
      assert.equal(describeErasureLedgerConfig({ retentionDays: 30 }).warnings.length, 1);
      assert.equal(describeErasureLedgerConfig({ hmacKey: require('node:crypto').randomBytes(32).toString('base64') }).problems.length, 0);
    });
  });
});
