/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * [RCRG] what a registration that died midway leaves, and its sweep
 * (usersRepository.reconcileUnfinishedRegistrations, bin/reconcile-user-cores.js
 * --registrations; the routing-row pass for a death before the user is
 * indexed). Single core; the multi-core cases are in reg-multicore.test.js.
 */

const timestamp = require('unix-timestamp');
const { ErrorIds } = require('errors');
// Account-store rows a dead registration left: written while the id is
// indexed (the database refuses rows of an unindexed id), the entry removed after.
const { writeAsOrphans } = require('test-helpers/src/indexedUserIds.ts');

const PASSWORD = 'test-password-1';
const APP_ID = 'pryv-test-no-cors';
const DAY = 86400;

describe('[RCRG] unfinished registrations sweep', function () {
  let platform, usersRepository, accountStorage, erasures;

  before(async function () {
    await initTests();
    await initCore();
    const { getUsersRepository } = require('business/src/users/index.ts');
    usersRepository = await getUsersRepository();
    platform = usersRepository.platform;
    accountStorage = usersRepository.userAccountStorage;
    erasures = await require('business/src/auth/erasures.ts').getErasuresLocal();
  });

  function isPG () {
    return require('storages').databasePG != null;
  }

  function freshName (prefix) {
    return (prefix + cuid()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  }

  async function freshUser (prefix) {
    const uname = freshName(prefix);
    const fu = await getNewFixture().user(uname, { password: PASSWORD });
    await platform.setUserCore(uname, platform.coreId);
    return { uname, userId: fu.attrs.id };
  }

  /**
   * A registration whose process died right before the password write: the
   * routing claim and platform rows written, the user indexed, its account
   * fields (and, with a session, its personal access) stored, no password,
   * nothing undone.
   */
  async function crashedRegistration (prefix, { withSession = true } = {}) {
    const { User } = require('business/src/users/index.ts');
    const uname = freshName(prefix);
    const email = uname + '@example.com';
    await platform.setUserCore(uname, platform.coreId);
    const user = new User({ username: uname, email, password: PASSWORD, appId: APP_ID });
    const originalAdd = accountStorage.addPasswordHash;
    accountStorage.addPasswordHash = async () => { throw new Error('simulated process death'); };
    usersRepository.compensateFailedInsert = async () => {}; // a dead process undoes nothing
    try {
      await assert.rejects(usersRepository.insertOne(user, withSession), /simulated process death/);
    } finally {
      accountStorage.addPasswordHash = originalAdd;
      delete usersRepository.compensateFailedInsert;
    }
    return { uname, email, userId: user.id };
  }

  async function removeAccount ({ userId, uname }) {
    try {
      if (await usersRepository.usersIndex.getUsername(userId) != null) await usersRepository.deleteOne(userId, uname);
      await platform.deleteUserCore(uname);
    } catch (e) { /* best effort */ }
  }

  function erasureRow (userId, username) {
    const now = Date.now();
    return { userId, username, trigger: 'test', startedAt: now, updatedAt: now, doneSteps: [], seriesNamespaces: null, attempts: 1, lastError: null };
  }

  function sweep (options = {}) {
    return usersRepository.reconcileUnfinishedRegistrations({ settleMs: 0, ...options });
  }

  it('[RCRG1] PostgreSQL: account fields under an id the index lacks are listed by the dry run and cleared by --apply, nothing else', async function () {
    if (!isPG()) return this.skip();
    const kept = await freshUser('rcka');
    const keptFields = await accountStorage.getAccountFields(kept.userId);
    const orphanId = cuid();
    const old = timestamp.now() - 2 * DAY;
    await writeAsOrphans([orphanId], async () => {
      await accountStorage.setAccountField(orphanId, 'email', orphanId + '@example.com', 'system', old);
      await accountStorage.setAccountField(orphanId, 'language', 'en', 'system', old);
    });
    try {
      const dry = await sweep();
      const listed = dry.accountStoreOrphans.find((o) => o.userId === orphanId);
      assert.ok(listed != null && listed.repairable === true && listed.accountFields === 2 && listed.cleared !== true,
        JSON.stringify(dry.accountStoreOrphans));
      assert.strictEqual(Object.keys(await accountStorage.getAccountFields(orphanId)).length, 2, 'the dry run deletes nothing');

      const applied = await sweep({ apply: true });
      assert.strictEqual(applied.accountStoreOrphans.find((o) => o.userId === orphanId)?.cleared, true);
      assert.deepStrictEqual(await accountStorage.getAccountFields(orphanId), {}, 'cleared');
      assert.deepStrictEqual(await accountStorage.getAccountFields(kept.userId), keptFields, 'another account keeps its fields');
      assert.ok(await accountStorage.getPasswordHash(kept.userId) != null, 'and its password');

      const again = await sweep({ apply: true });
      assert.ok(!again.accountStoreOrphans.some((o) => o.userId === orphanId), 'nothing left on a second run');
    } finally {
      await accountStorage._clearAll(orphanId);
      await removeAccount(kept);
    }
  });

  it('[RCRG2] PostgreSQL: --apply leaves an orphan with a recent field, a password, an erasure record or an access', async function () {
    if (!isPG()) return this.skip();
    // An indexed account, so the pass does not take the empty-index refusal.
    const kept = await freshUser('rckc');
    const old = timestamp.now() - 2 * DAY;
    const ids = { recent: cuid(), password: cuid(), erasure: cuid(), access: cuid() };
    await writeAsOrphans(Object.values(ids), async () => {
      await accountStorage.setAccountField(ids.recent, 'language', 'en', 'system', timestamp.now());
      for (const key of ['password', 'erasure', 'access']) {
        await accountStorage.setAccountField(ids[key], 'language', 'en', 'system', old);
      }
      await accountStorage.addPasswordHash(ids.password, 'not-a-real-hash', 'system', old);
      await usersRepository.createPersonalAccessForUser(ids.access, cuid(), APP_ID);
    });
    await erasures.insertIfAbsent(erasureRow(ids.erasure, 'rcrgerasure'));
    try {
      const applied = await sweep({ apply: true });
      const reasons = Object.fromEntries(Object.entries(ids).map(([key, id]) =>
        [key, applied.accountStoreOrphans.find((o) => o.userId === id)]));
      assert.strictEqual(reasons.recent?.reason, 'recent', JSON.stringify(reasons));
      assert.strictEqual(reasons.password?.reason, 'has-password');
      assert.strictEqual(reasons.erasure?.reason, 'erasure-record');
      assert.strictEqual(reasons.access?.reason, 'holds-data');
      for (const [key, id] of Object.entries(ids)) {
        assert.ok(Object.keys(await accountStorage.getAccountFields(id)).length > 0, key + ': left untouched');
      }
      assert.ok(await accountStorage.getPasswordHash(ids.password) != null);
    } finally {
      for (const id of Object.values(ids)) await accountStorage._clearAll(id);
      await erasures.delete(ids.erasure);
      await new Promise((resolve, reject) => usersRepository.accessStorage.removeAll({ id: ids.access }, (err) => err ? reject(err) : resolve()));
      await removeAccount(kept);
    }
  });

  it('[RCRG3] an indexed account with no password is erased only when named, and its name and email register again', async function () {
    const crashed = await crashedRegistration('rccr');
    try {
      const status = (s) => s.noPassword.find((c) => c.userId === crashed.userId)?.status;
      const dry = await sweep({ userIds: [crashed.userId], graceSeconds: 0 });
      assert.strictEqual(status(dry), 'repairable', JSON.stringify(dry.noPassword));
      assert.strictEqual(dry.noPassword.find((c) => c.userId === crashed.userId).username, crashed.uname);
      assert.strictEqual(await usersRepository.usersIndex.getUsername(crashed.userId), crashed.uname, 'the dry run erases nothing');

      const unnamed = await sweep({ apply: true, graceSeconds: 0 });
      assert.strictEqual(status(unnamed), 'not-named');
      assert.strictEqual(await usersRepository.usersIndex.getUsername(crashed.userId), crashed.uname, 'not named: kept');

      const applied = await sweep({ apply: true, userIds: [crashed.userId], graceSeconds: 0 });
      assert.strictEqual(status(applied), 'repaired', JSON.stringify(applied.noPassword));
      assert.ok(await usersRepository.usersIndex.getUsername(crashed.userId) == null, 'no index row');
      assert.ok(await usersRepository.usersIndex.getUserId(crashed.uname) == null, 'the name is free on this core');
      assert.strictEqual(await platform.getUserCore(crashed.uname), null, 'routing row released');
      assert.strictEqual(await platform.getUniqueValueOwner('email', crashed.email), null, 'email released');
      assert.strictEqual(await erasures.get(crashed.userId), null, 'no erasure record left');
      if (isPG()) assert.deepStrictEqual(await accountStorage.getAccountFields(crashed.userId), {}, 'no account field left');
    } finally {
      await removeAccount(crashed);
    }
    // The same name and email register again.
    const { User } = require('business/src/users/index.ts');
    const retry = new User({ username: crashed.uname, email: crashed.email, password: PASSWORD, appId: APP_ID });
    await platform.setUserCore(crashed.uname, platform.coreId);
    try {
      await usersRepository.insertOne(retry, true);
      assert.strictEqual(await usersRepository.usersIndex.getUserId(crashed.uname), retry.id);
    } finally {
      await removeAccount({ userId: retry.id, uname: crashed.uname });
    }
  });

  it('[RCRG4] registered, system-created and delegated accounts are never listed as without a password', async function () {
    const { User } = require('business/src/users/index.ts');
    const { encryption } = require('utils');
    const registered = new User({ username: freshName('rcrg'), email: freshName('m') + '@example.com', password: PASSWORD });
    await usersRepository.insertOne(registered);
    const systemCreated = new User({ username: freshName('rcsc'), email: freshName('m') + '@example.com' });
    systemCreated.passwordHash = await encryption.hash(PASSWORD);
    await usersRepository.insertOne(systemCreated);
    const { buildSystemCreateAccountDeps } = require('api-server/src/methods/helpers/delegationAccounts.ts');
    const delegatedName = freshName('rcdl');
    const { userId: delegatedId } = await (await buildSystemCreateAccountDeps()).provisionAccount({ username: delegatedName });
    try {
      const s = await sweep({ apply: true, userIds: [registered.id, systemCreated.id, delegatedId], graceSeconds: 0 });
      for (const id of [registered.id, systemCreated.id, delegatedId]) {
        assert.ok(!s.noPassword.some((c) => c.userId === id), id + ' not listed');
        assert.ok(s.namedNotCandidates.includes(id), id + ' named but not a candidate');
        assert.ok(await usersRepository.usersIndex.getUsername(id) != null, id + ' kept');
      }
    } finally {
      await removeAccount({ userId: registered.id, uname: registered.username });
      await removeAccount({ userId: systemCreated.id, uname: systemCreated.username });
      await removeAccount({ userId: delegatedId, uname: delegatedName });
    }
  });

  it('[RCRG5] a named account with no password is kept when it holds a stream, has an erasure record, or gets a password while the run settles', async function () {
    const withStream = await crashedRegistration('rcst');
    const withRecord = await crashedRegistration('rcer');
    const inFlight = await crashedRegistration('rcfl');
    const mall = await require('mall').getMall();
    await mall.streams.create(withStream.userId, { id: 'rcrgrestored', name: 'Restored', parentId: null });
    await erasures.insertIfAbsent(erasureRow(withRecord.userId, withRecord.uname));
    // The password of `inFlight` is written right after the run first reads
    // its account fields, i.e. while the run is under way (no timer: the
    // listing walks every indexed user, which takes long in a full suite).
    const passwordHash = await require('utils').encryption.hash(PASSWORD);
    const originalMeta = accountStorage.getAccountFieldsWithMeta;
    let written = false;
    accountStorage.getAccountFieldsWithMeta = async function (userId, ...rest) {
      const fields = await originalMeta.call(this, userId, ...rest);
      if (userId === inFlight.userId && !written) {
        written = true;
        await accountStorage.addPasswordHash(inFlight.userId, passwordHash, 'system');
      }
      return fields;
    };
    try {
      const s = await sweep({ apply: true, userIds: [withStream.userId, withRecord.userId, inFlight.userId], graceSeconds: 0, settleMs: 400 });
      assert.ok(written, 'the password was written during the run');
      const status = (c) => s.noPassword.find((r) => r.userId === c.userId)?.status;
      assert.strictEqual(status(withStream), 'holds-data', JSON.stringify(s.noPassword));
      assert.strictEqual(status(withRecord), 'erasure-record');
      assert.strictEqual(status(inFlight), 'in-flight');
      for (const c of [withStream, withRecord, inFlight]) {
        assert.strictEqual(await usersRepository.usersIndex.getUsername(c.userId), c.uname, c.uname + ' kept');
      }
    } finally {
      accountStorage.getAccountFieldsWithMeta = originalMeta;
      await erasures.delete(withRecord.userId);
      for (const c of [withStream, withRecord, inFlight]) await removeAccount(c);
    }
  });

  it('[RCRG11] an account with no password whose only stream is a deletion record holds data', async function () {
    const crashed = await crashedRegistration('rcds');
    const { promisify } = require('node:util');
    const streams = usersRepository.storageLayer.streams;
    const mall = await require('mall').getMall();
    await mall.streams.create(crashed.userId, { id: 'rcrgdeleted', name: 'Deleted', parentId: null });
    await promisify(streams.delete).call(streams, { id: crashed.userId }, { id: 'rcrgdeleted' });
    try {
      assert.strictEqual(await promisify(streams.countAll).call(streams, { id: crashed.userId }), 0, 'no live stream');
      const s = await sweep({ graceSeconds: 0 });
      assert.strictEqual(s.noPassword.find((c) => c.userId === crashed.userId)?.status, 'holds-data', JSON.stringify(s.noPassword));
    } finally {
      await removeAccount(crashed);
    }
  });

  it('[RCRG12] the summary flags the storage as suspect when most of the index has no password', async function () {
    this.timeout(120000); // every indexed account becomes a candidate
    const users = [await freshUser('rcsa'), await freshUser('rcsb'), await freshUser('rcsc')];
    try {
      const normal = await sweep();
      assert.strictEqual(normal.mostIndexWithoutPassword, false, JSON.stringify({ n: normal.noPassword.length, of: normal.indexedAccounts }));
      // Account storage this run cannot read: every password reads as absent.
      const original = accountStorage.getPasswordHash;
      accountStorage.getPasswordHash = async () => null;
      let suspect;
      try {
        suspect = await sweep();
      } finally {
        accountStorage.getPasswordHash = original;
      }
      assert.strictEqual(suspect.mostIndexWithoutPassword, true);
      assert.strictEqual(suspect.noPassword.length, suspect.indexedAccounts);
      for (const u of users) assert.strictEqual(await usersRepository.usersIndex.getUsername(u.userId), u.uname, 'a report erases nothing');
    } finally {
      for (const u of users) await removeAccount(u);
    }
  });

  it('[RCRG10] a named account deleted while the run settles is left alone, and the account now holding its name keeps its rows', async function () {
    const crashed = await crashedRegistration('rcgn');
    const { User } = require('business/src/users/index.ts');
    const successor = new User({ username: crashed.uname, email: freshName('m') + '@example.com', password: PASSWORD, appId: APP_ID });
    // Once the run has listed it: the crashed account is deleted and its
    // name registered again by another account.
    const originalMeta = accountStorage.getAccountFieldsWithMeta;
    let replaced = false;
    accountStorage.getAccountFieldsWithMeta = async function (userId, ...rest) {
      const fields = await originalMeta.call(this, userId, ...rest);
      if (userId === crashed.userId && !replaced) {
        replaced = true;
        await usersRepository.deleteOne(crashed.userId, crashed.uname);
        await platform.setUserCore(crashed.uname, platform.coreId);
        await usersRepository.insertOne(successor, true);
      }
      return fields;
    };
    try {
      const s = await sweep({ apply: true, userIds: [crashed.userId], graceSeconds: 0, settleMs: 100 });
      assert.ok(replaced, 'replaced during the run');
      assert.strictEqual(s.noPassword.find((c) => c.userId === crashed.userId)?.status, 'gone', JSON.stringify(s.noPassword));
      assert.strictEqual(await usersRepository.usersIndex.getUserId(crashed.uname), successor.id, 'the successor keeps the name');
      assert.strictEqual(await platform.getUserCore(crashed.uname), platform.coreId, 'and its routing row');
      assert.ok(await platform.getUniqueValueOwner('email', successor.email) != null, 'and its email');
      assert.ok(await accountStorage.getPasswordHash(successor.id) != null, 'and its password');
    } finally {
      accountStorage.getAccountFieldsWithMeta = originalMeta;
      await removeAccount({ userId: successor.id, uname: crashed.uname });
      await removeAccount(crashed);
    }
  });

  it('[RCRG6] the routing-row pass releases the platform rows of a stale name before its routing row (single core), dry run writing nothing', async function () {
    const stale = freshName('rcsl');
    const email = stale + '@example.com';
    await platform.setUserCore(stale, platform.coreId);
    assert.ok(await platform.setUserUniqueFieldIfNotExists(stale, 'email', email));
    // Another name, registered, with its own email row.
    const { User } = require('business/src/users/index.ts');
    const liveUser = new User({ username: freshName('rclv'), email: freshName('m') + '@example.com', password: PASSWORD });
    await usersRepository.insertOne(liveUser);
    await platform.setUserCore(liveUser.username, platform.coreId);
    const live = { userId: liveUser.id, uname: liveUser.username };
    const liveEmailOwner = await platform.getUniqueValueOwner('email', liveUser.email);
    assert.strictEqual(liveEmailOwner, platform.hashFor('username', liveUser.username));
    try {
      const dry = await usersRepository.reconcileUserCoreMap(true, { settleMs: 0 });
      assert.ok(dry.platformRowsReleased >= 1, JSON.stringify(dry));
      assert.notStrictEqual(await platform.getUniqueValueOwner('email', email), null, 'the dry run writes nothing');
      assert.strictEqual(await platform.getUserCore(stale), platform.coreId);

      const token = platform.hashFor('username', stale);
      const order = [];
      const originalRows = platform.deleteUserRowsByPreHashedUsername;
      const originalCore = platform.deleteUserCoreByPreHashedUsername;
      platform.deleteUserRowsByPreHashedUsername = async function (t, ...rest) { if (t === token) order.push('rows'); return await originalRows.call(this, t, ...rest); };
      platform.deleteUserCoreByPreHashedUsername = async function (t, ...rest) { if (t === token) order.push('routing'); return await originalCore.call(this, t, ...rest); };
      try {
        await usersRepository.reconcileUserCoreMap(false, { settleMs: 0 });
      } finally {
        delete platform.deleteUserRowsByPreHashedUsername;
        delete platform.deleteUserCoreByPreHashedUsername;
      }
      assert.deepStrictEqual(order, ['rows', 'routing']);
      assert.strictEqual(await platform.getUniqueValueOwner('email', email), null, 'the email of the stale name is free');
      assert.strictEqual(await platform.getUserCore(stale), null);
      assert.strictEqual(await platform.getUniqueValueOwner('email', liveUser.email), liveEmailOwner, 'another name keeps its rows');
      assert.strictEqual(await platform.getUserCore(liveUser.username), platform.coreId);
    } finally {
      await removeAccount(live);
    }
  });

  it('[RCRG7] PostgreSQL: an empty users index facing account-store rows is refused, dry run too, unless forced', async function () {
    if (!isPG()) return this.skip();
    const orphanId = cuid();
    await writeAsOrphans([orphanId], () => accountStorage.setAccountField(orphanId, 'language', 'en', 'system', timestamp.now() - 2 * DAY));
    const usersIndex = usersRepository.usersIndex;
    const original = usersIndex.getAllByUsername;
    usersIndex.getAllByUsername = async () => ({}); // a lost index, or a wrong --config
    try {
      for (const apply of [false, true]) {
        const s = await sweep({ apply });
        assert.strictEqual(s.refusedEmptyLocal, true, 'refused, apply ' + apply);
        assert.ok(Object.keys(await accountStorage.getAccountFields(orphanId)).length > 0, 'nothing deleted, apply ' + apply);
      }
      const forced = await sweep({ forceEmptyLocal: true });
      assert.strictEqual(forced.refusedEmptyLocal, undefined);
      assert.ok(forced.accountStoreOrphans.some((o) => o.userId === orphanId && o.repairable), 'forced: listed');
    } finally {
      usersIndex.getAllByUsername = original;
      await accountStorage._clearAll(orphanId);
    }
  });

  it('[RCRG8] a login on an indexed account with no password answers invalid credentials', async function () {
    const crashed = await crashedRegistration('rclg');
    try {
      const res = await coreRequest.post('/' + crashed.uname + '/auth/login')
        .send({ username: crashed.uname, password: PASSWORD, appId: APP_ID });
      assert.strictEqual(res.status, 401, JSON.stringify(res.body));
      assert.strictEqual(res.body.error?.id, ErrorIds.InvalidCredentials);
    } finally {
      await removeAccount(crashed);
    }
  });

  it('[RCRG9] bin/reconcile-user-cores.js --registrations: a separate pass, --user-id only with --apply, reports by default, erases a named account from its own process', async function () {
    // Several CLI processes, each starting the storages (and a dry run that
    // walks every indexed user).
    this.timeout(180000);
    const { spawnSync } = require('node:child_process');
    const path = require('node:path');
    const { childStorageEngineEnv } = require('test-helpers');
    const repoRoot = path.resolve(path.dirname(require('node:url').fileURLToPath(import.meta.url)), '../../../');
    const cli = (args) => spawnSync('node', [path.join(repoRoot, 'bin/reconcile-user-cores.js'), ...args],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...childStorageEngineEnv() }, timeout: 90000 });
    for (const [args, message] of [
      [['--registrations', '--emails'], /separate pass/],
      [['--registrations', '--user-id', 'someid'], /--user-id/],
      [['--apply'], /--apply belongs to the --registrations and --cmc-retries passes/],
      [['--registrations', '--apply', '--dry-run'], /contradict/],
      [['--registrations', '--grace', 'soon'], /--grace/],
      [['--registrations', '--apply', '--user-id', 'someid', '--settle', '9'], /--settle: erasing a named account/]
    ]) {
      const run = cli(args);
      assert.strictEqual(run.status, 1, args.join(' ') + ': ' + run.stdout + run.stderr);
      assert.match(run.stderr, message, args.join(' '));
    }
    const crashed = await crashedRegistration('rcbn');
    try {
      const run = cli(['--registrations', '--settle', '0']);
      assert.strictEqual(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /--registrations: DRY-RUN \(no writes\)/);
      assert.match(run.stdout, /indexed accounts with no password: \d+ of \d+/);
      assert.ok(run.stdout.includes(crashed.userId), run.stdout);
      assert.strictEqual(await usersRepository.usersIndex.getUsername(crashed.userId), crashed.uname, 'a report writes nothing');

      // The erasure, run by the tool's own process (not this API test process).
      const erase = cli(['--registrations', '--apply', '--user-id', crashed.userId, '--grace', '0', '--settle', '10']);
      assert.strictEqual(erase.status, 0, erase.stdout + erase.stderr);
      assert.match(erase.stdout, /--registrations: applied/);
      assert.ok(await usersRepository.usersIndex.getUsername(crashed.userId) == null, 'no index row: ' + erase.stdout);
      assert.strictEqual(await platform.getUserCore(crashed.uname), null, 'routing row released');
      assert.strictEqual(await platform.getUniqueValueOwner('email', crashed.email), null, 'email released');
      assert.strictEqual(await erasures.get(crashed.userId), null, 'no erasure record left');
    } finally {
      await removeAccount(crashed);
    }
  });
});
