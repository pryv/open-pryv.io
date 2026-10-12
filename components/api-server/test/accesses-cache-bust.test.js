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

  it('[ACBU3] a CMC / delegation access delete whose pre-read fails busts the user\'s access cache', async function () {
    const { buildMallForCmc } = require('api-server/src/methods/helpers/cmcMall.ts');
    const mall = await buildMallForCmc();
    const busts = recordCacheBusts();
    failBeforeWrite('removeOne', (cb) => cb(new Error('pre-read failed')));
    await mall.accesses.delete(userId, { id: sharedId });
    assert.ok(busts.some((b) => b.kind === 'user' && b.userId === userId),
      'without a token the bust is keyed by user id: ' + JSON.stringify(busts));
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
