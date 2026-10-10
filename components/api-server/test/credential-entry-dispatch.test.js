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
 * [CEDP] Methods that take credentials instead of an access token (sign-in,
 * registration, password reset, recovery, one-time secret retrieval) are
 * served over their own HTTP routes only: the generic dispatchers (a batch
 * call, a socket.io message) refuse them. A batch is bounded in size, does
 * not nest, and its results are bounded in total. Failed passwords are
 * delayed per account, never locked out.
 */

const storage = require('storage');
const { withInjectedConfig } = require('test-helpers');
const { getUsersRepository } = require('business/src/users/index.ts');

const TRUSTED_ORIGIN = 'http://test.pryv.local';
const APP_ID = 'pryv-test';
// A trusted app id for which no session or personal access exists yet.
const FRESH_APP_ID = 'pryv-test-no-cors';

describe('[CEDP] credential entry methods and batch bounds', function () {
  this.timeout(60000);
  let fixtures, username, password, personalToken, sharedToken, streamId;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
  });

  beforeEach(async function () {
    username = ('cedp' + cuid.slug()).toLowerCase();
    password = 'cedp-passw0rd';
    personalToken = cuid();
    sharedToken = cuid();
    streamId = 'cedp-' + cuid.slug();
    const user = await fixtures.user(username, { password });
    await user.access({ type: 'personal', token: personalToken, name: APP_ID });
    await user.session(personalToken);
    await user.stream({ id: streamId, name: streamId });
    await user.access({
      type: 'shared',
      token: sharedToken,
      name: 'cedp-shared',
      permissions: [{ streamId, level: 'read' }]
    });
  });

  after(async function () {
    await fixtures.clean();
  });

  function batch (token, calls) {
    return coreRequest.post('/' + username).set('Authorization', token).send(calls);
  }

  function login (pwd, appId = APP_ID) {
    return coreRequest.post(`/${username}/auth/login`).set('Origin', TRUSTED_ORIGIN)
      .send({ username, password: pwd, appId });
  }

  /** The accesses of the user and the session a login of `appId` would reuse. */
  async function footprint (appId) {
    const userRow = await (await getUsersRepository()).getUserByUsername(username);
    const layer = await storage.getStorageLayer();
    const accesses = await new Promise((resolve, reject) =>
      layer.accesses.find(userRow, {}, null, (err, res) => err ? reject(err) : resolve(res)));
    const session = await new Promise((resolve, reject) =>
      layer.sessions.getMatching({ username, appId, userId: userRow.id }, (err, id) => err ? reject(err) : resolve(id)));
    return {
      accesses: accesses.map((a) => ({ id: a.id, token: a.token })).sort((a, b) => a.id.localeCompare(b.id)),
      session: session ?? null
    };
  }

  function assertRefusedSlot (slot, what) {
    assert.ok(slot != null && slot.error != null, what + ' must be refused: ' + JSON.stringify(slot));
    assert.strictEqual(slot.error.id, 'invalid-operation', what + ': ' + JSON.stringify(slot));
  }

  describe('[CEDB] inside a batch call', function () {
    it('[CEDB1] auth.login is refused with a shared token, whatever the password, and mints nothing', async function () {
      const before = await footprint(FRESH_APP_ID);
      const wrong = await batch(sharedToken, [1, 2, 3].map((i) => ({
        method: 'auth.login',
        params: { username, password: 'wrong-' + i, appId: FRESH_APP_ID, origin: TRUSTED_ORIGIN }
      })));
      assert.strictEqual(wrong.status, 200, JSON.stringify(wrong.body));
      assert.strictEqual(wrong.body.results.length, 3);
      wrong.body.results.forEach((r, i) => assertRefusedSlot(r, 'wrong password #' + i));

      const right = await batch(sharedToken, [{
        method: 'auth.login',
        params: { username, password, appId: FRESH_APP_ID, origin: TRUSTED_ORIGIN }
      }]);
      assert.strictEqual(right.status, 200, JSON.stringify(right.body));
      assertRefusedSlot(right.body.results[0], 'correct password');
      assert.strictEqual(right.body.results[0].token, undefined);
      assert.deepStrictEqual(await footprint(FRESH_APP_ID), before, 'no session and no access written');
    });

    it('[CEDB2] every credential-less entry method is refused before its own parameter checks', async function () {
      const methods = [
        'auth.login',
        'auth.register',
        'auth.emailChallenge',
        'auth.emailChallengeVerify',
        'account.requestPasswordReset',
        'account.resetPassword',
        'account.verifyEmail',
        'sharedSecrets.retrieve',
        'mfa.recover'
      ];
      // Empty params: a method that ran its parameter validation would answer
      // invalid-parameters-format; the refusal comes first.
      const res = await batch(personalToken, methods.map((method) => ({ method, params: {} })));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      res.body.results.forEach((r, i) => assertRefusedSlot(r, methods[i]));
    });

    it('[CEDB3] account.changePassword and mfa.activate stay batchable', async function () {
      const res = await batch(personalToken, [
        { method: 'account.changePassword', params: { oldPassword: password, newPassword: password + '-new' } },
        { method: 'mfa.activate', params: { method: 'totp' } }
      ]);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.results[0].error, undefined, JSON.stringify(res.body.results[0]));
      const activate = res.body.results[1];
      assert.ok(activate.error == null || activate.error.id !== 'invalid-operation', JSON.stringify(activate));
      assert.strictEqual((await login(password + '-new')).status, 200);
    });

    it('[CEDB4] a nested callBatch is refused in its slot and the sibling calls still run', async function () {
      const res = await batch(personalToken, [
        { method: 'getAccessInfo', params: {} },
        { method: 'callBatch', params: [{ method: 'getAccessInfo', params: {} }] },
        { method: 'streams.get', params: {} }
      ]);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.results[0].type, 'personal');
      assertRefusedSlot(res.body.results[1], 'nested callBatch');
      assert.ok(Array.isArray(res.body.results[2].streams), JSON.stringify(res.body.results[2]));
    });

    it('[CEDB5] a batch of 1000 calls is served; 1001 calls are refused by the parameter schema', async function () {
      const call = { method: 'getAccessInfo', params: {} };
      const tooMany = await batch(personalToken, new Array(1001).fill(call));
      assert.strictEqual(tooMany.status, 400, JSON.stringify(tooMany.body).slice(0, 300));
      assert.strictEqual(tooMany.body.error.id, 'invalid-parameters-format');
      const max = await batch(personalToken, new Array(1000).fill(call));
      assert.strictEqual(max.status, 200, JSON.stringify(max.body).slice(0, 300));
      assert.strictEqual(max.body.results.length, 1000);
    });

    it('[CEDB6] results are bounded across the whole batch, not only per call', async function () {
      for (let i = 0; i < 4; i++) {
        const created = await coreRequest.post(`/${username}/events`).set('Authorization', personalToken)
          .send({ streamIds: [streamId], type: 'note/txt', content: 'e' + i });
        assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      }
      const read = { method: 'events.get', params: { streams: [streamId], limit: 2 } };
      await withInjectedConfig({ limits: { batch: { maxTotalItems: 3 } } }, async () => {
        const over = await batch(personalToken, [read, read]);
        assert.strictEqual(over.body.error?.id, 'too-many-results', JSON.stringify(over.body));
        assert.strictEqual(over.body.results, undefined, 'no partial results');
        const within = await batch(personalToken, [read]);
        assert.strictEqual(within.status, 200, JSON.stringify(within.body));
        assert.strictEqual(within.body.results[0].events.length, 2);
      });
    });
  });

  describe('[CEPB] failed-password backoff per account', function () {
    // One free failure, then a one-second delay; long window.
    const attempts = { auth: { passwordAttempts: { freeFailures: 1, baseSeconds: 1, maxSeconds: 1, windowSeconds: 3600 } } };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function assertDelayed (res, maxSeconds) {
      assert.strictEqual(res.status, 429, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'too-many-attempts');
      assert.ok(res.headers['retry-after'] != null, 'a Retry-After header is set');
      const seconds = res.body.error.data.retryAfterSeconds;
      assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= maxSeconds, 'retryAfterSeconds: ' + seconds);
    }

    function assertWrongPassword (res) {
      assert.strictEqual(res.status, 401, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'invalid-credentials');
    }

    it('[CEPB1] past the free failures the next login is delayed, even with the right password; after the delay it succeeds', async function () {
      await withInjectedConfig(attempts, async () => {
        assertWrongPassword(await login('wrong-1'));
        assertWrongPassword(await login('wrong-2'));
        assertDelayed(await login(password), 1);
        await sleep(1100);
        const ok = await login(password);
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        // The success cleared the tally: the next failure is free again.
        assertWrongPassword(await login('wrong-3'));
        assertWrongPassword(await login('wrong-4'));
      });
    });

    it('[CEPB2] a wrong old password on account.changePassword counts on the same tally', async function () {
      await withInjectedConfig(attempts, async () => {
        const change = await coreRequest.post(`/${username}/account/change-password`).set('Authorization', personalToken)
          .send({ oldPassword: 'wrong-old', newPassword: password + '-x' });
        assert.strictEqual(change.status, 400, JSON.stringify(change.body));
        assertWrongPassword(await login('wrong-1'));
        assertDelayed(await login(password), 1);
      });
    });

    it('[CEPB3] a wrong step-up password on mfa.deactivate counts on the same tally', async function () {
      await withInjectedConfig(attempts, async () => {
        const deactivate = await coreRequest.post(`/${username}/mfa/deactivate`).set('Authorization', personalToken)
          .send({ password: 'wrong-step-up' });
        assert.strictEqual(deactivate.status, 403, JSON.stringify(deactivate.body));
        assert.strictEqual(deactivate.body.error.id, 'invalid-step-up');
        assertWrongPassword(await login('wrong-1'));
        assertDelayed(await login(password), 1);
      });
    });

    it('[CEPB4] a wrong password on mfa.recover counts on the same tally', async function () {
      await withInjectedConfig(attempts, async () => {
        const recover = await coreRequest.post(`/${username}/mfa/recover`)
          .send({ username, password: 'wrong-recover', recoveryCode: 'not-a-code' });
        assertWrongPassword(recover);
        assertWrongPassword(await login('wrong-1'));
        assertDelayed(await login(password), 1);
      });
    });

    it('[CEPB5] the delay never exceeds maxSeconds, however many failures accrue', async function () {
      const capped = { auth: { passwordAttempts: { freeFailures: 0, baseSeconds: 1, maxSeconds: 2, windowSeconds: 3600 } } };
      await withInjectedConfig(capped, async () => {
        for (let i = 0; i < 4; i++) {
          let res = await login('wrong-' + i);
          if (res.status === 429) {
            assertDelayed(res, 2);
            await sleep(res.body.error.data.retryAfterSeconds * 1000 + 100);
            res = await login('wrong-' + i);
          }
          assertWrongPassword(res);
        }
        const delayed = await login(password);
        assertDelayed(delayed, 2);
        await sleep(delayed.body.error.data.retryAfterSeconds * 1000 + 100);
        assert.strictEqual((await login(password)).status, 200, 'the owner is slowed, never locked out');
      });
    });

    it('[CEPB6] maxSeconds 0 disables the backoff', async function () {
      const off = { auth: { passwordAttempts: { freeFailures: 0, baseSeconds: 1, maxSeconds: 0 } } };
      await withInjectedConfig(off, async () => {
        for (let i = 0; i < 4; i++) assertWrongPassword(await login('wrong-' + i));
        assert.strictEqual((await login(password)).status, 200);
      });
    });
  });
});
