/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * An access write that may have committed busts the access cache even when a
 * later step of the same call fails: otherwise this worker and its siblings
 * keep serving the previous permissions until the cache entry ages out.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const storage = require('storage');
const cache = require('cache').default;

describe('[ACBU] access writes bust the cache when a later step fails', function () {
  let username, userId, basePath, personalToken, sharedToken, sharedId, user;
  let accessStorage, fixtures, fixtureUser;
  let restore;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    username = cuid();
    personalToken = cuid();
    basePath = '/' + username + '/accesses';
    user = { id: username };
    const storageLayer = await storage.getStorageLayer();
    accessStorage = storageLayer.accesses;
    fixtureUser = await fixtures.user(username);
    userId = fixtureUser.attrs.id;
    await fixtureUser.access({ type: 'personal', token: personalToken });
    await fixtureUser.session(personalToken);
  });

  beforeEach(async function () {
    restore = [];
    const shared = await fixtureUser.access({
      id: 'shared_' + cuid(),
      type: 'shared',
      name: 'read all ' + cuid(),
      token: cuid(),
      permissions: [{ streamId: '*', level: 'read' }]
    });
    sharedId = shared.attrs.id;
    sharedToken = shared.attrs.token;
  });

  afterEach(function () {
    for (const undo of restore.reverse()) undo();
  });

  after(async function () {
    await new Promise((resolve) => accessStorage.removeAll(user, () => resolve()));
  });

  function replace (object, name, replacement) {
    const original = object[name];
    object[name] = replacement(original);
    restore.push(() => { object[name] = original; });
  }

  function recordCacheBusts () {
    const busts = [];
    replace(cache, 'unsetAccessLogic', (original) => function (uid, logic, ...rest) {
      busts.push({ kind: 'access', userId: uid, id: logic?.id, token: logic?.token });
      return original.call(cache, uid, logic, ...rest);
    });
    replace(cache, 'unsetUserData', (original) => function (uid, ...rest) {
      busts.push({ kind: 'user', userId: uid });
      return original.call(cache, uid, ...rest);
    });
    return busts;
  }

  /** `findOne` answers with `answer` once `updateOne` (or `removeOne`) has run. */
  function failReadsAfterWrite (writeMethod, answer) {
    let written = false;
    replace(accessStorage, writeMethod, (original) => function (...args) {
      written = true;
      return original.apply(this, args);
    });
    replace(accessStorage, 'findOne', (original) => function (u, query, options, cb) {
      if (written) return answer(cb);
      return original.call(this, u, query, options, cb);
    });
  }

  function failBeforeWrite (writeMethod, answer) {
    let written = false;
    replace(accessStorage, writeMethod, (original) => function (...args) {
      written = true;
      return original.apply(this, args);
    });
    replace(accessStorage, 'findOne', (original) => function (u, query, options, cb) {
      if (!written && query?.id === sharedId) return answer(cb);
      return original.call(this, u, query, options, cb);
    });
  }

  it('[ACBU1] accesses.update busts the updated access when the re-read after the write fails', async function () {
    const busts = recordCacheBusts();
    failReadsAfterWrite('updateOne', (cb) => cb(new Error('re-read failed')));
    const res = await coreRequest
      .put(basePath + '/' + sharedId)
      .set('Authorization', personalToken)
      .send({ name: 'renamed ' + cuid() });
    assert.strictEqual(res.status, 500, JSON.stringify(res.body));
    const bust = busts.find((b) => b.kind === 'access' && b.id === sharedId);
    assert.ok(bust != null, 'the updated access must be unset: ' + JSON.stringify(busts));
    assert.strictEqual(bust.token, sharedToken);
  });

  it('[ACBU2] a CMC / delegation access update whose token is unknown busts the user\'s access cache', async function () {
    const { buildMallForCmc } = require('api-server/src/methods/helpers/cmcMall.ts');
    const mall = await buildMallForCmc();
    const busts = recordCacheBusts();
    failReadsAfterWrite('updateOne', (cb) => cb(null, null));
    await mall.accesses.update(userId, { id: sharedId, update: { name: 'renamed ' + cuid() } });
    assert.ok(busts.some((b) => b.kind === 'user' && b.userId === userId),
      'without a token the bust is keyed by user id: ' + JSON.stringify(busts));
  });

  it('[ACBU3] a CMC / delegation access delete whose pre-read fails deletes nothing and reports the failure', async function () {
    // Without the row, the adapter cannot tell whether the accesses created
    // through this one go with it: deleting it alone would leave them
    // unmanaged, so nothing is deleted and the caller's retry applies.
    const { buildMallForCmc } = require('api-server/src/methods/helpers/cmcMall.ts');
    const mall = await buildMallForCmc();
    failBeforeWrite('removeOne', (cb) => cb(new Error('pre-read failed')));
    await assert.rejects(mall.accesses.delete(userId, { id: sharedId }), /pre-read failed/);
    const res = await coreRequest.get('/' + username + '/access-info').set('Authorization', sharedToken);
    assert.strictEqual(res.status, 200, 'the access is still there: ' + JSON.stringify(res.body));
  });

  it('[ACBU5] a credential scrub that fails after the delete is logged and the rest of the deletion still runs (the final pass deletes an access created meanwhile)', async function () {
    const { deleteAccessChain } = require('api-server/src/methods/helpers/accessDeletion.ts');
    const { captureWarnings } = require('test-helpers/src/captureWarnings.ts');
    const peerToken = 'peertok' + cuid();
    const app = await fixtureUser.access({
      id: 'app_' + cuid(),
      type: 'app',
      name: 'app ' + cuid(),
      token: cuid(),
      permissions: [{ streamId: '*', level: 'manage' }],
      clientData: { cmc: { peerApiEndpoint: 'https://' + peerToken + '@peer.example.com/peer/' } }
    });
    const appId = app.attrs.id;
    const lateId = 'late_' + cuid();
    const lateToken = cuid();
    // An access created through the app between the first read and the delete.
    let injected = false;
    replace(accessStorage, 'delete', (original) => function (...args) {
      if (injected) return original.apply(this, args);
      injected = true;
      const self = this;
      fixtureUser.access({ id: lateId, type: 'shared', name: 'late ' + cuid(), token: lateToken, createdBy: appId, permissions: [{ streamId: '*', level: 'read' }] })
        .then(() => original.apply(self, args), args[args.length - 1]);
    });
    // The scrub's write (the one carrying `clientData`) fails.
    const scrubWrites = [];
    replace(accessStorage, 'updateOne', (original) => function (u, query, update, cb) {
      if (update?.clientData != null) { scrubWrites.push(query?.id); return cb(new Error('scrub write failed')); }
      return original.call(this, u, query, update, cb);
    });
    const capture = captureWarnings();
    let outcome;
    try {
      outcome = await deleteAccessChain({ id: userId, username }, { id: appId });
    } finally {
      capture.restore();
    }
    assert.strictEqual(outcome.deleted, true);
    assert.deepStrictEqual(scrubWrites, [appId], 'the scrub was attempted and failed');
    assert.ok(outcome.relatedDeletions.some((d) => d.id === lateId), 'the final pass ran: ' + JSON.stringify(outcome.relatedDeletions));
    const lateRes = await coreRequest.get('/' + username + '/access-info').set('Authorization', lateToken);
    assert.notStrictEqual(lateRes.status, 200, 'the late access is deleted: ' + JSON.stringify(lateRes.body));
    const warning = capture.warnings.find((w) => /credential scrub/.test(String(w.args[0])));
    assert.ok(warning != null, 'a warning is logged: ' + JSON.stringify(capture.warnings.map((w) => w.args[0])));
    assert.strictEqual(warning.args[1].accessId, appId);
    assert.ok(!JSON.stringify(warning.args).includes(peerToken), 'never the peer token');
  });

  it('[ACBU6] the alias of an access the final pass deletes is released', async function () {
    const { deleteAccessChain } = require('api-server/src/methods/helpers/accessDeletion.ts');
    const { getUsersRepository } = require('business/src/users/index.ts');
    const usersRepository = await getUsersRepository();
    const app = await fixtureUser.access({
      id: 'app_' + cuid(),
      type: 'app',
      name: 'app ' + cuid(),
      token: cuid(),
      permissions: [{ streamId: '*', level: 'manage' }]
    });
    const appId = app.attrs.id;
    const alias = await usersRepository.mintAlias(username, userId);
    // An aliased access created through the app between the first read and the delete.
    let injected = false;
    replace(accessStorage, 'delete', (original) => function (...args) {
      if (injected) return original.apply(this, args);
      injected = true;
      const self = this;
      fixtureUser.access({ id: 'late_' + cuid(), type: 'shared', name: 'late ' + cuid(), token: cuid(), alias, createdBy: appId, permissions: [{ streamId: '*', level: 'read' }] })
        .then(() => original.apply(self, args), args[args.length - 1]);
    });
    const outcome = await deleteAccessChain({ id: userId, username }, { id: appId });
    assert.strictEqual(outcome.deleted, true);
    assert.strictEqual(await usersRepository.getUserIdForUsername(alias), undefined, 'the alias no longer routes');
    assert.strictEqual(await usersRepository.platform.getUsersUniqueField('alias', alias), null, 'its reservation is released');
  });

  it('[ACBU4] with the token known, the CMC bust stays on the one access', async function () {
    const { buildMallForCmc } = require('api-server/src/methods/helpers/cmcMall.ts');
    const mall = await buildMallForCmc();
    const busts = recordCacheBusts();
    await mall.accesses.update(userId, { id: sharedId, update: { name: 'renamed ' + cuid() } });
    assert.ok(busts.some((b) => b.kind === 'access' && b.id === sharedId && b.token === sharedToken), JSON.stringify(busts));
    assert.ok(!busts.some((b) => b.kind === 'user'), JSON.stringify(busts));
  });
});
