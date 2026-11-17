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
 * [PCLM] Password checks run in a bounded number of per-worker slots. While
 * they are busy, the password methods answer 429 too-many-requests with
 * Retry-After, and the refused check is not a failed attempt: it neither
 * delays the account nor counts on its tally. The password history check
 * takes one slot per comparison, never one for the whole history.
 */

const sinon = require('sinon');
const bcrypt = require('bcrypt');
const { encryption } = require('utils');
const { getUserAccountStorage, getStorageLayer } = require('storage');

const PASSWORD = 'pclm-password-1';
const APP_ID = 'pryv-test-no-cors'; // trusted for any origin in test-config

function freshName () {
  return ('pclm' + cuid()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

async function freshUser () {
  const uname = freshName();
  const fu = await getNewFixture().user(uname, { password: PASSWORD });
  return { uname, userId: fu.attrs.id };
}

function login (uname, password = PASSWORD) {
  return coreRequest.post('/' + uname + '/auth/login').send({ username: uname, password, appId: APP_ID });
}

/** Holds the only password-check slot until `release()`. */
function holdSlot () {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const held = encryption.withBcryptSlot(() => gate);
  return { release: () => { release(); return held; } };
}

async function waitFor (predicate, what) {
  const until = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function assertBusy (res) {
  assert.equal(res.status, 429, JSON.stringify(res.body));
  assert.equal(res.body.error.id, 'too-many-requests');
  assert.equal(res.headers['retry-after'], '5');
}

describe('[PCLM] password checks and the per-worker password-check slots', function () {
  this.timeout(30000);

  before(async function () {
    await initTests();
    await initCore();
  });

  afterEach(() => {
    encryption.configureBcryptLimit(null);
    sinon.restore();
  });

  it('[PCLM1] sign-in, password change and MFA recovery answer 429 too-many-requests with Retry-After while the slots are busy', async function () {
    const { uname } = await freshUser();
    const token = (await login(uname)).body.token;
    assert.ok(token);
    encryption.configureBcryptLimit({ concurrency: 1, queue: 0 });
    const slot = holdSlot();
    try {
      assertBusy(await login(uname));
      assertBusy(await coreRequest.post('/' + uname + '/account/change-password').set('Authorization', token)
        .send({ oldPassword: PASSWORD, newPassword: 'pclm-password-2' }));
      assertBusy(await coreRequest.post('/' + uname + '/mfa/recover')
        .send({ username: uname, password: PASSWORD, recoveryCode: 'pclm-code' }));
    } finally {
      await slot.release();
    }
  });

  it('[PCLM3] a registration refused for busy slots answers 429 and leaves the name and email free to retry', async function () {
    const username = freshName();
    const body = {
      appId: 'pclm-test',
      username,
      password: 'pclm-password-reg',
      email: username + '@pclm.example.com',
      insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
      language: 'en'
    };
    encryption.configureBcryptLimit({ concurrency: 1, queue: 0 });
    const slot = holdSlot();
    try {
      assertBusy(await coreRequest.post('/users').send(body));
    } finally {
      await slot.release();
    }
    const res = await coreRequest.post('/users').send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it('[PCLM2] refused checks are not attempts: no delay and no tally on the account afterwards', async function () {
    const { uname, userId } = await freshUser();
    encryption.configureBcryptLimit({ concurrency: 1, queue: 0 });
    const slot = holdSlot();
    try {
      // More refusals than the free failures a backoff allows.
      for (let i = 0; i < 8; i++) assertBusy(await login(uname));
    } finally {
      await slot.release();
    }
    // Read before the next sign-in: a success clears the tally anyway.
    const layer = await getStorageLayer();
    const item = await new Promise((resolve, reject) => layer.profile.findOne({ id: userId, username: uname }, { id: 'private' }, null,
      (err, r) => err ? reject(err) : resolve(r)));
    assert.equal(item?.data?.passwordThrottle ?? null, null, 'no tally left on the account');
    const res = await login(uname);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  describe('[PCLC] the two config keys', function () {
    const { describePasswordCheckLimit } = require('business/src/auth/passwordCheckLimit.ts');

    function bootProblems (auth) {
      const { checkPasswordCheckLimit } = require('../../../config/plugins/config-validation.js');
      const problems = [];
      checkPasswordCheckLimit({ get: (key) => key === 'auth' ? auth : key.split(':').reduce((o, k) => o?.[k], { auth }) }, problems);
      return problems;
    }

    it('[PCLC1] integers >= 0 are accepted (0 included); negative, fractional and non-numeric values are refused at boot', () => {
      for (const ok of [{}, { passwordCheckConcurrency: 0, passwordCheckQueue: 0 }, { passwordCheckConcurrency: 3, passwordCheckQueue: 100 }]) {
        assert.deepEqual(bootProblems(ok), [], JSON.stringify(ok));
      }
      assert.deepEqual(describePasswordCheckLimit({}).settings, { concurrency: 2, queue: 50 });
      assert.deepEqual(describePasswordCheckLimit({ passwordCheckConcurrency: 0, passwordCheckQueue: 0 }).settings, { concurrency: 0, queue: 0 });
      for (const bad of [-1, 1.5, '2', true]) {
        const c = bootProblems({ passwordCheckConcurrency: bad });
        assert.equal(c.length, 1, 'concurrency ' + JSON.stringify(bad));
        assert.deepEqual(c[0].path, ['auth', 'passwordCheckConcurrency']);
        const q = bootProblems({ passwordCheckQueue: bad });
        assert.equal(q.length, 1, 'queue ' + JSON.stringify(bad));
        assert.deepEqual(q[0].path, ['auth', 'passwordCheckQueue']);
      }
    });

    it('[PCLC2] warns when the concurrency is not below the thread pool size', () => {
      assert.deepEqual(describePasswordCheckLimit({}, '16').warnings, []);
      assert.deepEqual(describePasswordCheckLimit({ passwordCheckConcurrency: 3 }, undefined).warnings, []);
      assert.equal(describePasswordCheckLimit({ passwordCheckConcurrency: 4 }, undefined).warnings.length, 1, 'default pool of 4');
      assert.equal(describePasswordCheckLimit({ passwordCheckConcurrency: 16 }, '16').warnings.length, 1);
      assert.deepEqual(describePasswordCheckLimit({ passwordCheckConcurrency: 0 }, '1').warnings, [], 'disabled: no warning');
    });
  });

  describe('[PCLH] the password history check', function () {
    let userAccountStorage;
    before(async function () { userAccountStorage = await getUserAccountStorage(); });

    async function userWithHistory (n) {
      const { userId } = await freshUser();
      await userAccountStorage.clearHistory(userId);
      for (let i = 0; i < n; i++) {
        await userAccountStorage.addPasswordHash(userId, await encryption.hash('pclh-old-' + i), 'test', Date.now() / 1000 - 100 + i);
      }
      return userId;
    }

    it('[PCLH1] waits for a held slot, and completes once it is released', async function () {
      const userId = await userWithHistory(2);
      encryption.configureBcryptLimit({ concurrency: 1, queue: 10 });
      const slot = holdSlot();
      let found = null;
      const check = userAccountStorage.passwordExistsInHistory(userId, 'pclh-old-0', 2).then((r) => { found = r; });
      await waitFor(() => encryption.bcryptLimitStats().waiting === 1, 'the history check to queue');
      assert.equal(found, null);
      await slot.release();
      await check;
      assert.equal(found, true);
    });

    it('[PCLH2] takes one slot per comparison: another check is served between two of them', async function () {
      const userId = await userWithHistory(3);
      const spy = sinon.spy(bcrypt, 'compare');
      encryption.configureBcryptLimit({ concurrency: 1, queue: 10 });
      const slot = holdSlot();
      const check = userAccountStorage.passwordExistsInHistory(userId, 'pclh-absent', 3);
      await waitFor(() => encryption.bcryptLimitStats().waiting === 1, 'the first history comparison to queue');
      let comparesBeforeProbe = null;
      const probe = encryption.withBcryptSlot(async () => { comparesBeforeProbe = spy.callCount; });
      await slot.release();
      assert.equal(await check, false);
      await probe;
      assert.equal(comparesBeforeProbe, 1, 'the other check ran right after the first history comparison');
      assert.equal(spy.callCount, 3);
    });
  });
});
