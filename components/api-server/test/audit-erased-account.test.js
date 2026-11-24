/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

// A call in flight while its account is erased writes its audit record after
// the erasure. Under `audit.onUserDelete: erase` nothing of it stays.
describe('[AGPE] audit records of an account erased meanwhile', function () {
  this.timeout(60_000);

  let fixtures, config, audit, auditStorage, lossCounter, adminKey, originalDeleteUser, isPg;
  const ids = [];

  before(async function () {
    await initTests();
    await initCore();
    config = await require('@pryv/boiler').getConfig();
    if (config.get('audit:active') !== true) this.skip();
    if (!global.app.api.has('auth.delete')) await require('api-server/src/methods/auth/delete.ts').default(global.app.api);
    fixtures = getNewFixture();
    audit = require('audit').default;
    auditStorage = require('storages').auditStorage;
    originalDeleteUser = auditStorage.deleteUser;
    isPg = typeof auditStorage.existingPathForUser !== 'function';
    lossCounter = require('audit/src/lossCounter.ts');
    adminKey = config.get('auth:adminAccessKey');
  });

  afterEach(function () { if (auditStorage != null) auditStorage.deleteUser = originalDeleteUser; });

  after(async function () {
    for (const id of ids) {
      try { await auditStorage.deleteUser(id); } catch (_e) { /* best-effort */ }
    }
    if (fixtures != null) {
      try { await fixtures.clean(); } catch (_e) { /* best-effort */ }
    }
  });

  async function newUser () {
    const username = 'agpe-' + cuid().slice(-8);
    const token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    ids.push(username);
    await audit.eventForUser(username, row());
    return { username, token };
  }

  function row () {
    return { streamIds: [':_audit:action-mfa.recovered'], type: 'audit-log/mfa', time: 1, created: 1, createdBy: 'system', modified: 1, modifiedBy: 'system', content: { action: 'mfa.recovered', source: { name: 'test' } } };
  }

  async function count (userId) {
    return (await (await auditStorage.forUser(userId)).getEvents({ query: [] })).length;
  }

  function erase (username) {
    return coreRequest.delete('/users/' + username).set('Authorization', adminKey);
  }

  /** The audit component's log calls while `body` runs. */
  async function logged (body) {
    const proto = Object.getPrototypeOf(require('@pryv/boiler').getLogger('audit'));
    const originals = { warn: proto.warn, error: proto.error };
    const lines = { warn: [], error: [] };
    for (const level of ['warn', 'error']) {
      proto[level] = function (msg, ...rest) { lines[level].push(String(msg)); return originals[level].call(this, msg, ...rest); };
    }
    try { await body(); } finally { Object.assign(proto, originals); }
    return lines;
  }

  it('[AGPE1] a record written after the erasure is refused without being lost, and nothing is stored', async function () {
    const { username } = await newUser();
    assert.strictEqual(await count(username), 1);
    const res = await erase(username);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const before = lossCounter.snapshot().lost.total;
    const lines = await logged(() => audit.eventForUser(username, row()));
    assert.strictEqual(lossCounter.snapshot().lost.total, before, 'not a lost record');
    assert.strictEqual(lines.warn.filter((m) => m.includes(username) && /erased/.test(m)).length, 1, JSON.stringify(lines));
    assert.deepStrictEqual(lines.error, []);
    if (isPg) assert.strictEqual(await count(username), 0);
    else await assert.rejects(auditStorage.forUser(username), /erased/);
  });

  it('[AGPE2] a record written between the two audit deletions is removed', async function () {
    if (!isPg) this.skip(); // a file in the user directory, wiped after the account is gone
    const { username } = await newUser();
    let late = 0;
    auditStorage.deleteUser = async function (userId) {
      await originalDeleteUser.call(auditStorage, userId);
      if (userId === username && late++ === 0) await audit.eventForUser(username, row());
    };
    const stored = [];
    const original = auditStorage.deleteUser;
    auditStorage.deleteUser = async function (userId) {
      if (userId === username) stored.push(await count(username));
      await original.call(auditStorage, userId);
    };
    const res = await erase(username);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(stored, [1, 1], 'the late record was there at the second deletion');
    assert.strictEqual(await count(username), 0);
  });

  it('[AGPE3] under `keep` the trail stays open: the earlier record and a late one are there', async function () {
    const { username } = await newUser();
    const restore = require('test-helpers').injectTestConfigSnapshot({ audit: { onUserDelete: 'keep' } });
    try {
      await audit.reloadConfig();
      const res = await erase(username);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      await audit.eventForUser(username, row());
      assert.strictEqual(await count(username), 2);
    } finally {
      restore();
      await audit.reloadConfig();
    }
  });

  it('[AGPE4] an account that erases itself in a batch leaves no record and counts no loss', async function () {
    const { username, token } = await newUser();
    const before = lossCounter.snapshot().lost.total;
    // The record of the batch itself, written after the answer.
    const original = audit.eventForUser;
    let written;
    const envelope = new Promise((resolve) => { written = resolve; });
    audit.eventForUser = async function (...args) {
      try { return await original.apply(audit, args); } finally { if (args[0] === username && args[2] === 'callBatch') written(); }
    };
    const restore = require('test-helpers').injectTestConfigSnapshot({ 'user-account': { delete: ['adminToken', 'personalToken'] } });
    try {
      const res = await coreRequest.post('/' + username).set('Authorization', token)
        .send([{ method: 'auth.delete', params: { username } }]);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.results[0].error, undefined, JSON.stringify(res.body));
      await envelope;
      await new Promise((resolve) => setImmediate(resolve)); // its outcome, in the caller
    } finally {
      restore();
      audit.eventForUser = original;
    }
    if (isPg) assert.strictEqual(await count(username), 0);
    else await assert.rejects(auditStorage.forUser(username), /erased/);
    assert.strictEqual(lossCounter.snapshot().lost.total, before);
  });

  it('[AGPE5] an erasure recorded before the second deletion existed runs it when resumed', async function () {
    if (!isPg) this.skip();
    const { Deletion } = require('business/src/auth/deletion.ts');
    const { username } = await newUser();
    const deletion = new Deletion(null, global.app.storageLayer, config);
    let calls = 0;
    auditStorage.deleteUser = async function (userId) {
      if (userId === username) calls++;
      return await originalDeleteUser.call(auditStorage, userId);
    };
    const erasures = await require('business/src/auth/erasures.ts').getErasuresLocal();
    const anHourAgo = Date.now() - 3600_000;
    await erasures.put({
      userId: username,
      username,
      startedAt: anHourAgo,
      updatedAt: anHourAgo,
      doneSteps: ['runTeardownSteps', 'deleteUserFiles', 'deleteHFData', 'deleteAttachments', 'deleteAuditDataStorage'],
      seriesNamespaces: null,
      attempts: 1,
      lastError: null,
      trigger: 'admin'
    });
    await deletion.eraseAccount({ id: username, username }, { trigger: 'admin' });
    assert.strictEqual(calls, 1, 'the first deletion is done already, the second one runs');
    assert.strictEqual(await count(username), 0);
  });

  it('[AGPE6] a restore imports the trail of an id that is not in the index', async function () {
    const { username } = await newUser();
    const exported = await (await auditStorage.forUser(username)).exportAllEvents();
    assert.strictEqual(exported.length, 1);
    const userId = 'agpe-import-' + cuid().slice(-6);
    ids.push(userId);
    await (await auditStorage.forUser(userId)).importAllEvents(exported.map((e) => ({ ...e, user_id: userId })));
    assert.strictEqual(await count(userId), 1);
  });

  it('[AGPE9] the refusals are recognised by what the storages really throw', async function () {
    const refusal = require('audit/src/erasedAccountRefusal.ts');
    const { UNINDEXED_USER_ERRCODE } = require('storages/engines/postgresql/src/unindexedWritesGuard.ts');
    const { ErasedUserError } = require('storage/src/userLocalDirectory.ts');
    assert.strictEqual(refusal.UNINDEXED_USER_CODE, UNINDEXED_USER_ERRCODE);
    const erased = new ErasedUserError('x');
    assert.deepStrictEqual([erased.name, erased.code], [refusal.ERASED_USER_ERROR_NAME, refusal.ERASED_USER_CODE]);
    assert.strictEqual(refusal.isErasedAccountRefusal(new Error('wrapped', { cause: erased })), true);
    assert.strictEqual(refusal.isErasedAccountRefusal(Object.assign(new Error('other'), { code: '23505' })), false);
  });
});
