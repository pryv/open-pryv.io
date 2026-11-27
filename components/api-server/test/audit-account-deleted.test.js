/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid, sinon */

const { pollUntil } = require('test-helpers');
const { Deletion } = require('business/src/auth/deletion.ts');
const { deletionWordsOf } = require('business/src/auth/accountAudit.ts');
const { getErasuresLocal } = require('business/src/auth/erasures.ts');
const ledger = require('business/src/erasureLedger/index.ts');

// Where the trail of an account outlives it (`audit.onUserDelete: keep`), the
// server writes `account.deleted` in it before the account's data goes,
// whatever path erases the account. Under `erase` nothing is written: the
// trail goes with the account.
describe('[AADL] audit record of an account deletion', function () {
  this.timeout(60_000);

  let fixtures, config, adminKey, audit, auditStorage, originalForUser, storageLayer, usersRepository, lossCounter, platform, key, userLocalDirectory;
  const cleanups = [];

  before(async function () {
    await initTests();
    await initCore();
    config = await require('@pryv/boiler').getConfig();
    if (config.get('audit:active') !== true) this.skip();
    if (!global.app.api.has('auth.delete')) await require('api-server/src/methods/auth/delete.ts').default(global.app.api);
    adminKey = config.get('auth:adminAccessKey');
    fixtures = getNewFixture();
    audit = require('audit').default;
    auditStorage = require('storages').auditStorage;
    originalForUser = auditStorage.forUser;
    storageLayer = await require('storage').getStorageLayer();
    userLocalDirectory = require('storage').userLocalDirectory;
    usersRepository = await require('business/src/users/index.ts').getUsersRepository();
    lossCounter = require('audit/src/lossCounter.ts');
    platform = await require('platform').getPlatform();
    key = ledger.ledgerKey(config);
  });

  afterEach(function () {
    if (auditStorage != null) auditStorage.forUser = originalForUser;
    sinon.restore();
  });

  after(async function () {
    for (const u of cleanups) {
      try { await cleanUp(u); } catch (_e) { /* best-effort */ }
    }
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  /** An account with a stream holding an event, and a personal access (its token). */
  async function account () {
    const username = ('aadl' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const token = cuid();
    const user = await fixtures.user(username);
    const access = await user.access({ token, type: 'personal' });
    await user.session(token);
    const streamId = 'aadl-' + cuid().slice(-10);
    const stream = await user.stream({ id: streamId, name: 'AADL ' + streamId });
    await stream.event({ type: 'note/txt', content: 'some data' });
    const email = await (await require('storage').getUserAccountStorage()).getAccountField(user.attrs.id, 'email');
    const u = { id: user.attrs.id, username, token, accessId: access.attrs.id, streamId, email };
    cleanups.push(u);
    return u;
  }

  async function cleanUp (u) {
    const store = await getErasuresLocal();
    await store.delete(u.id);
    if ((await usersRepository.getUserIdForUsername(u.username)) === u.id) {
      await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { teardown: false });
    }
    await store.delete(u.id);
    await platform.deletePlatformKv(ledger.LEDGER_PREFIX + ledger.userIdHash(key, u.id));
    await auditStorage.deleteUser(u.id);
    await userLocalDirectory.deleteUserDirectory(u.id);
  }

  /** `body` with the trails kept after an erasure, as an operator configures it (the audit reloaded). */
  async function withKeep (body, extra = {}) {
    const restore = require('test-helpers').injectTestConfigSnapshot({ ...extra, audit: { onUserDelete: 'keep', ...(extra.audit ?? {}) } });
    try {
      await audit.reloadConfig();
      return await body();
    } finally {
      restore();
      await audit.reloadConfig();
    }
  }

  /** The trail of `userId`; none when an erased account had no audit file to keep (per-user files refuse to reopen). */
  async function trail (userId) {
    try {
      return (await (await originalForUser.call(auditStorage, userId)).getEvents({ query: [] })) ?? [];
    } catch (err) {
      if (/erased/.test(String(err?.message))) return [];
      throw err;
    }
  }

  /** PostgreSQL audit engine: records are also indexed by access in audit_event_streams. */
  const pgAudit = () => typeof auditStorage?.ensureStreamIndex === 'function';
  async function streamIndexRows (userId) {
    return (await auditStorage.db.query('SELECT count(*)::int AS n FROM audit_event_streams WHERE user_id = $1', [userId])).rows[0].n;
  }

  async function deletionRecords (userId) {
    return (await trail(userId)).filter((e) => e.content?.action === 'account.deleted');
  }

  function assertNoneOf (record, values) {
    const serialized = JSON.stringify(record);
    for (const value of values) {
      if (value == null || value === '') continue;
      assert.ok(!serialized.includes(value), 'the record holds ' + JSON.stringify(value) + ': ' + serialized);
    }
  }

  async function exists (u) {
    return (await usersRepository.getUserIdForUsername(u.username)) === u.id;
  }

  /** The `source` of the next call row of `u`'s personal access. */
  async function callSourceOf (u) {
    const before = new Set((await trail(u.id)).map((e) => e.id));
    const res = await coreRequest.get('/' + u.username + '/access-info').set('Authorization', u.token);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const found = await pollUntil(async () => (await trail(u.id)).filter((e) => !before.has(e.id) && e.content?.action === 'getAccessInfo'),
      (list) => list.length > 0, { timeoutMs: 5000 });
    return found[0].content.source;
  }

  const HOLDER_DELETES = { 'user-account': { delete: ['adminToken', 'personalToken'] } };

  // Mutations caught: the step removed from the erasure; a username, an
  // address of the account or the token put in the record.
  it('[AADL1] a deletion by the holder under `keep` leaves one record: its personal access, the client address, ids only', async function () {
    const u = await account();
    await withKeep(async () => {
      const callSource = await callSourceOf(u);
      const res = await coreRequest.delete('/users/' + u.username).set('Authorization', u.token);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.equal(await exists(u), false);
      const found = await deletionRecords(u.id);
      assert.strictEqual(found.length, 1, JSON.stringify(found));
      const record = found[0];
      assert.strictEqual(record.type, 'audit-log/account');
      assert.strictEqual(record.createdBy, 'system');
      assert.deepStrictEqual([...record.streamIds].sort(), ['access-' + u.accessId, 'action-account.deleted'].sort());
      assert.deepStrictEqual(record.content.source, { name: 'holder', ip: callSource.ip });
      assert.ok(typeof callSource.ip === 'string' && callSource.ip.length > 0, JSON.stringify(callSource));
      assert.deepStrictEqual(record.content.record, { trigger: 'holder', accessId: u.accessId, accessType: 'personal' });
      assert.deepStrictEqual(Object.keys(record.content).sort(), ['action', 'record', 'source']);
      assertNoneOf(record, [u.username, u.email, u.token, u.streamId]);
      if (pgAudit()) {
        // The kept trail keeps its rows, and reads through them.
        const kept = await trail(u.id);
        const terms = kept.filter((e) => e.time != null)
          .reduce((n, e) => n + new Set(e.streamIds.filter((s) => s.startsWith('access-'))).size, 0);
        assert.ok(terms > 0);
        assert.strictEqual(await streamIndexRows(u.id), terms);
        assert.strictEqual(auditStorage.streamIndex.isComplete(), true);
        const accessQuery = { query: [{ type: 'streamsQuery', content: [[{ any: ['access-' + u.accessId] }]] }], options: { sort: { time: -1 } } };
        const { buildSelectQuery } = require('storages/engines/postgresql/src/UserAuditDatabasePG.ts');
        assert.ok(buildSelectQuery(u.id, structuredClone(accessQuery), true).sql.includes('audit_event_streams'));
        const read = await (await originalForUser.call(auditStorage, u.id)).getEvents(accessQuery);
        assert.deepStrictEqual(read.map((e) => e.id).sort(),
          kept.filter((e) => e.streamIds.includes('access-' + u.accessId)).map((e) => e.id).sort());
        assert.ok(read.length >= 2, 'the call and the deletion record: ' + read.length);
      }
    }, HOLDER_DELETES);
  });

  // Mutation caught: the address or the access kept for a deletion that is not the holder's.
  it('[AADL2] a deletion with the admin key under `keep`: the actor only, no address, no access', async function () {
    const u = await account();
    await withKeep(async () => {
      const res = await coreRequest.delete('/users/' + u.username).set('Authorization', adminKey);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const found = await deletionRecords(u.id);
      assert.strictEqual(found.length, 1, JSON.stringify(found));
      assert.deepStrictEqual(found[0].streamIds, ['action-account.deleted']);
      assert.deepStrictEqual(found[0].content.source, { name: 'admin' });
      assert.deepStrictEqual(found[0].content.record, { trigger: 'admin' });
      assertNoneOf(found[0], [u.username, u.email, adminKey]);
    });
  });

  // Mutation caught: the `keep` condition (or `audit.active`) not checked.
  it('[AADL3] under `erase`, or with the audit off, no record is written', async function () {
    const isPg = typeof auditStorage.existingPathForUser !== 'function';
    const actions = [];
    const original = audit.eventForUser;
    sinon.stub(audit, 'eventForUser').callsFake(async function (userId, event, methodId, ...rest) {
      actions.push(methodId);
      return await original.call(audit, userId, event, methodId, ...rest);
    });
    const u = await account();
    if (pgAudit()) {
      // A record naming the access, so the erasure has rows to remove.
      await coreRequest.get('/' + u.username + '/access-info').set('Authorization', u.token);
      await pollUntil(() => streamIndexRows(u.id), (n) => n > 0, { timeoutMs: 5000 });
    }
    const res = await coreRequest.delete('/users/' + u.username).set('Authorization', adminKey);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(!actions.includes('account.deleted'), JSON.stringify(actions));
    if (pgAudit()) assert.strictEqual(await streamIndexRows(u.id), 0, 'the erasure removed the rows of audit_event_streams');
    if (isPg) assert.strictEqual((await trail(u.id)).length, 0);
    else await assert.rejects(originalForUser.call(auditStorage, u.id), /erased/);

    const off = await account();
    await withKeep(async () => {
      const r = await coreRequest.delete('/users/' + off.username).set('Authorization', adminKey);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    }, { audit: { active: false } });
    assert.ok(!actions.includes('account.deleted'), JSON.stringify(actions));
    await withKeep(async () => {
      assert.deepStrictEqual(await deletionRecords(off.id), [], 'the trail is kept, without the record');
    });
  });

  // Mutation caught: the step moved after a step that removes data (or to the end).
  it('[AADL4] the record is written while the account and its data are still there, before the first step that removes data', async function () {
    const u = await account();
    const order = [];
    const deleteUserFiles = Deletion.prototype.deleteUserFiles;
    sinon.stub(Deletion.prototype, 'deleteUserFiles').callsFake(function (...args) {
      order.push('deleteUserFiles');
      return deleteUserFiles.apply(this, args);
    });
    const original = audit.eventForUser;
    sinon.stub(audit, 'eventForUser').callsFake(async function (userId, event, methodId, ...rest) {
      if (methodId === 'account.deleted' && userId === u.id) {
        order.push('account.deleted');
        order.push(await exists(u) ? 'indexed' : 'gone');
        const streams = await new Promise((resolve, reject) => storageLayer.streams.find({ id: u.id }, {}, null, (err, rows) => err ? reject(err) : resolve(rows ?? [])));
        order.push(streams.some((s) => s.id === u.streamId) ? 'data' : 'no data');
      }
      return await original.call(audit, userId, event, methodId, ...rest);
    });
    // In this process (auth.delete bound its steps when it was registered, before the spy).
    await withKeep(async () => {
      await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'admin' });
    });
    assert.deepStrictEqual(order, ['account.deleted', 'indexed', 'data', 'deleteUserFiles']);
    assert.equal(await exists(u), false);
  });

  // Mutations caught: the step passing its error on (the erasure would fail);
  // the step not recorded as done.
  it('[AADL5] a record that cannot be written changes nothing for the erasure, and is counted once', async function () {
    const u = await account();
    let failing = false;
    auditStorage.forUser = async function (userId) {
      if (failing && userId === u.id) throw new Error('staged: no audit storage');
      return await originalForUser.call(auditStorage, userId);
    };
    const original = audit.eventForUser;
    sinon.stub(audit, 'eventForUser').callsFake(async function (userId, event, methodId, ...rest) {
      failing = methodId === 'account.deleted' && userId === u.id;
      try {
        return await original.call(audit, userId, event, methodId, ...rest);
      } finally {
        failing = false;
      }
    });
    const before = lossCounter.snapshot().lost.total;
    await withKeep(async () => {
      const res = await coreRequest.delete('/users/' + u.username).set('Authorization', adminKey);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(lossCounter.snapshot().lost.total, before + 1);
      assert.equal(await exists(u), false, 'the account is gone');
      const row = await ledger.readErasureRecord(platform, key, u.id);
      assert.ok(row != null, 'the ledger row');
      assert.ok(row.stepsCompleted.includes('recordAccountDeleted'), JSON.stringify(row.stepsCompleted));
      assert.equal(await (await getErasuresLocal()).get(u.id), null, 'the erasure record is closed');
      assert.deepStrictEqual(await deletionRecords(u.id), []);
    });
  });

  // Mutations caught: the write waited for without a bound (the erasure never
  // ends); its late answer counted a second time.
  it('[AADLF] a record whose write never answers: past the bound it counts as lost, once, and the erasure goes on', async function () {
    const u = await account();
    const { erasureRecordWait } = require('business/src/auth/accountAudit.ts');
    const savedMs = erasureRecordWait.ms;
    let staging = false;
    let answerLate = null;
    auditStorage.forUser = async function (userId) {
      if (staging && userId === u.id) return { createEvent: () => new Promise((resolve, reject) => { answerLate = reject; }) };
      return await originalForUser.call(auditStorage, userId);
    };
    const original = audit.eventForUser;
    sinon.stub(audit, 'eventForUser').callsFake(async function (userId, event, methodId, ...rest) {
      staging = methodId === 'account.deleted' && userId === u.id;
      try {
        return await original.call(audit, userId, event, methodId, ...rest);
      } finally {
        staging = false;
      }
    });
    erasureRecordWait.ms = 300;
    const before = lossCounter.snapshot().lost.total;
    try {
      await withKeep(async () => {
        assert.strictEqual(await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'admin' }), true);
      });
      assert.ok(answerLate != null, 'the staged write was reached');
      assert.equal(await exists(u), false, 'the account is gone');
      assert.strictEqual(lossCounter.snapshot().lost.total, before + 1, 'counted lost at the bound');
      answerLate(new Error('staged: a late failure'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.strictEqual(lossCounter.snapshot().lost.total, before + 1, 'the late answer is not counted again');
    } finally {
      erasureRecordWait.ms = savedMs;
    }
  });

  // Mutation caught: the stored trigger written as is.
  it('[AADL7] every trigger word gives its actor; any other word is `unknown`', function () {
    const table = {
      holder: 'holder',
      admin: 'admin',
      date: 'auto-deletion',
      inactivity: 'auto-deletion',
      'transfer-fallback': 'auto-deletion',
      'ledger-replay': 'ledger-replay',
      'unfinished-registration': 'system',
      system: 'system'
    };
    for (const [trigger, source] of Object.entries(table)) {
      assert.deepStrictEqual(deletionWordsOf(trigger), { source, trigger }, trigger);
    }
    for (const other of [null, undefined, '', 'something else', 'toString', '__proto__', 42]) {
      assert.deepStrictEqual(deletionWordsOf(other), { source: 'unknown', trigger: 'unknown' }, String(other));
    }
  });

  // Mutation caught: the step not recorded as done, or run outside the
  // recorded steps (a resume would write a second record).
  it('[AADL8] a resumed erasure that lists the step writes no second record; one recorded before the step existed writes it', async function () {
    const store = await getErasuresLocal();
    const anHourAgo = Date.now() - 3600_000;
    const resume = async (u, doneSteps) => {
      await store.put({ userId: u.id, username: u.username, trigger: 'admin', startedAt: anHourAgo, updatedAt: anHourAgo, doneSteps, seriesNamespaces: null, attempts: 1, lastError: null });
      assert.strictEqual(await new Deletion(null, storageLayer, config).eraseAccount({ id: u.id, username: u.username }, { trigger: 'date' }), true);
      assert.equal(await exists(u), false);
      assert.equal(await store.get(u.id), null, 'completed');
    };
    const listed = await account();
    const older = await account();
    await withKeep(async () => {
      await resume(listed, ['runTeardownSteps', 'recordAccountDeleted', 'deleteUserFiles']);
      assert.deepStrictEqual(await deletionRecords(listed.id), [], 'listed as done: not written again');
      await resume(older, ['runTeardownSteps', 'deleteUserFiles', 'deleteHFData', 'deleteAttachments', 'deleteAuditDataStorage']);
      const found = await deletionRecords(older.id);
      assert.strictEqual(found.length, 1, JSON.stringify(found));
      assert.deepStrictEqual(found[0].content, { action: 'account.deleted', source: { name: 'admin' }, record: { trigger: 'admin' } }, 'the record\'s trigger, not this run\'s');
    });
  });

  // Mutations caught: a path that writes nothing, or `holder` by default.
  it('[AADL9] a ledger replay and the roll-back of a delegated account under `keep` record their own words', async function () {
    const replayed = await account();
    await withKeep(async () => {
      await new Deletion(null, storageLayer, config).eraseAccount({ id: replayed.id, username: replayed.username }, { teardown: true, trigger: 'ledger-replay' });
      const found = await deletionRecords(replayed.id);
      assert.strictEqual(found.length, 1, JSON.stringify(found));
      assert.deepStrictEqual(found[0].content.source, { name: 'ledger-replay' });
      assert.deepStrictEqual(found[0].content.record, { trigger: 'ledger-replay' });

      const { buildSystemCreateAccountDeps } = require('api-server/src/methods/helpers/delegationAccounts.ts');
      const deps = await buildSystemCreateAccountDeps();
      const username = ('aadlk' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
      const { userId } = await deps.provisionAccount({ username, email: username + '@aadl.example.com', language: 'en' });
      cleanups.push({ id: userId, username });
      await deps.rollbackAccount(username, userId);
      assert.equal(await usersRepository.getUserIdForUsername(username), null, 'rolled back');
      // The trail kept for an account that never was usable: its creation, then its deletion.
      const actions = (await trail(userId)).map((e) => e.content?.action).filter((a) => a?.startsWith('account.'));
      assert.deepStrictEqual(actions.sort(), ['account.created', 'account.deleted']);
      const rolledBack = (await deletionRecords(userId))[0];
      assert.deepStrictEqual(rolledBack.content.source, { name: 'system' });
      assert.deepStrictEqual(rolledBack.content.record, { trigger: 'system' });
    });
  });

  // Mutation caught: the step placed after a step that removes data.
  it('[AADLD] the erasure ledger lists the step, before the first step that removes data', async function () {
    const u = await account();
    const res = await coreRequest.delete('/users/' + u.username).set('Authorization', adminKey);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const row = await ledger.readErasureRecord(platform, key, u.id);
    assert.ok(row != null);
    const steps = row.stepsCompleted;
    assert.ok(steps.indexOf('recordAccountDeleted') >= 0, JSON.stringify(steps));
    assert.ok(steps.indexOf('recordAccountDeleted') < steps.indexOf('deleteUserFiles'), JSON.stringify(steps));
    assert.ok(steps.indexOf('runTeardownSteps') < steps.indexOf('recordAccountDeleted'), JSON.stringify(steps));
  });
});
