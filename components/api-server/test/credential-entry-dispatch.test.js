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
 * delayed per account, never locked out, and budgeted per client address.
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

  describe('[CEPI] failed-password budget per client address', function () {
    const { configureTrustedProxies, currentTrustedProxies } = require('middleware/src/clientIp.ts');
    const { clearPasswordIpThrottle } = require('business/src/auth/passwordIpThrottle.ts');
    const { normalizePasswordAttempts } = require('business/src/auth/passwordAttempts.ts');
    // A window far wider than a test run, so no run straddles a window end.
    const WIDE = 100000000;
    // The per-account delay is off here, so only the address budget answers
    // (the pool accounts take a failure in most cases).
    const perIp = (maxFailures, windowSeconds = WIDE) => ({ auth: { passwordAttempts: { maxSeconds: 0, perIp: { maxFailures, windowSeconds } } } });
    const ADDRESSES = ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4', '198.51.100.5',
      '198.51.100.6', '2001:db8:7:1::1', '2001:db8:7:2::1', '127.0.0.1', '::1'];
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const POOL_SIZE = 31;
    const pool = [];

    before(async function () {
      this.timeout(120000);
      for (let i = 0; i < POOL_SIZE; i++) {
        const name = ('cepi' + i + cuid.slug()).toLowerCase();
        await fixtures.user(name, { password });
        pool.push(name);
      }
    });

    beforeEach(async function () {
      await clearPasswordIpThrottle(ADDRESSES, { maxFailures: 30, windowSeconds: WIDE });
    });

    after(async function () {
      await clearPasswordIpThrottle(ADDRESSES, { maxFailures: 30, windowSeconds: WIDE });
    });

    function from (req, address) {
      return address == null ? req : req.set('X-Forwarded-For', address);
    }

    function loginAs (name, pwd, address) {
      return from(coreRequest.post(`/${name}/auth/login`).set('Origin', TRUSTED_ORIGIN), address)
        .send({ username: name, password: pwd, appId: APP_ID });
    }

    function assertWrongPassword (res) {
      assert.strictEqual(res.status, 401, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'invalid-credentials');
    }

    function assertAddressRefused (res, maxSeconds = WIDE) {
      assert.strictEqual(res.status, 429, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'too-many-attempts');
      assert.ok(/from this address/.test(res.body.error.message), res.body.error.message);
      const seconds = res.body.error.data.retryAfterSeconds;
      assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= maxSeconds, 'retryAfterSeconds: ' + seconds);
      assert.strictEqual(res.headers['retry-after'], String(seconds));
    }

    it('[CEPI1] 30 failures across 30 accounts from one address: the 31st account is refused from it, even with its right password; another address is not', async function () {
      const A = '198.51.100.1';
      await withInjectedConfig(perIp(30), async () => {
        for (let i = 0; i < 30; i++) assertWrongPassword(await loginAs(pool[i], 'wrong-' + i, A));
        const last = pool[30];
        assertAddressRefused(await loginAs(last, 'wrong-31', A));
        assertAddressRefused(await loginAs(last, password, A));
        assertWrongPassword(await loginAs(last, 'wrong-31', '198.51.100.2'));
        assert.strictEqual((await loginAs(last, password, '198.51.100.2')).status, 200);
      });
    });

    it('[CEPI2] X-Forwarded-For is believed only from a trusted proxy', async function () {
      const previous = currentTrustedProxies();
      configureTrustedProxies([]);
      try {
        await withInjectedConfig(perIp(2), async () => {
          assertWrongPassword(await loginAs(pool[0], 'wrong-1', '198.51.100.3'));
          assertWrongPassword(await loginAs(pool[1], 'wrong-2', '198.51.100.4'));
          // Every forged header still comes from the same peer address.
          assertAddressRefused(await loginAs(pool[2], 'wrong-3', '198.51.100.5'));
        });
      } finally {
        configureTrustedProxies(previous);
      }
      // From the trusted loopback peer, the header names the client again.
      await withInjectedConfig(perIp(2), async () => {
        assertWrongPassword(await loginAs(pool[2], 'wrong-3', '198.51.100.5'));
      });
    });

    it('[CEPI3] IPv6 addresses of one /64 share a budget', async function () {
      await withInjectedConfig(perIp(1), async () => {
        assertWrongPassword(await loginAs(pool[0], 'wrong-1', '2001:db8:7:1::1'));
        assertAddressRefused(await loginAs(pool[1], 'wrong-2', '2001:db8:7:1:abcd::99'));
        assertWrongPassword(await loginAs(pool[1], 'wrong-2', '2001:db8:7:2::1'));
      });
    });

    it('[CEPI4] a wrong old password, step-up password or recovery password counts on the same budget', async function () {
      const A = '198.51.100.6';
      await withInjectedConfig(perIp(3), async () => {
        const change = await from(coreRequest.post(`/${username}/account/change-password`).set('Authorization', personalToken), A)
          .send({ oldPassword: 'wrong-old', newPassword: password + '-x' });
        assert.strictEqual(change.status, 400, JSON.stringify(change.body));
        const deactivate = await from(coreRequest.post(`/${username}/mfa/deactivate`).set('Authorization', personalToken), A)
          .send({ password: 'wrong-step-up' });
        assert.strictEqual(deactivate.status, 403, JSON.stringify(deactivate.body));
        const recover = await from(coreRequest.post(`/${pool[0]}/mfa/recover`), A)
          .send({ username: pool[0], password: 'wrong-recover', recoveryCode: 'not-a-code' });
        assertWrongPassword(recover);
        assertAddressRefused(await loginAs(pool[1], password, A));
        const refusedChange = await from(coreRequest.post(`/${username}/account/change-password`).set('Authorization', personalToken), A)
          .send({ oldPassword: password, newPassword: password + '-x' });
        assertAddressRefused(refusedChange);
      });
    });

    it('[CEPI5] a success neither counts nor clears the budget', async function () {
      const A = '198.51.100.1';
      await withInjectedConfig(perIp(2), async () => {
        assertWrongPassword(await loginAs(pool[0], 'wrong-1', A));
        assert.strictEqual((await loginAs(pool[1], password, A)).status, 200);
        assertWrongPassword(await loginAs(pool[2], 'wrong-2', A));
        assertAddressRefused(await loginAs(pool[3], password, A));
      });
    });

    it('[CEPI6] failures sent in parallel each count', async function () {
      const A = '198.51.100.2';
      await withInjectedConfig(perIp(4), async () => {
        const results = await Promise.all([0, 1, 2, 3].map((i) => loginAs(pool[i], 'wrong-' + i, A)));
        results.forEach(assertWrongPassword);
        assertAddressRefused(await loginAs(pool[4], password, A));
      });
    });

    it('[CEPI7] the refusal ends with its window', async function () {
      const A = '198.51.100.3';
      // Start at the beginning of a two-second window.
      await sleep(2000 - (Date.now() % 2000) + 50);
      await withInjectedConfig(perIp(1, 2), async () => {
        assertWrongPassword(await loginAs(pool[0], 'wrong-1', A));
        const refused = await loginAs(pool[1], password, A);
        assertAddressRefused(refused, 2);
        await sleep(refused.body.error.data.retryAfterSeconds * 1000 + 100);
        assert.strictEqual((await loginAs(pool[1], password, A)).status, 200);
      });
    });

    it('[CEPI8] maxFailures 0 disables the budget; defaults are 30 failures per 900 s', async function () {
      const A = '198.51.100.4';
      await withInjectedConfig(perIp(0), async () => {
        for (let i = 0; i < 4; i++) assertWrongPassword(await loginAs(pool[i], 'wrong-' + i, A));
        assert.strictEqual((await loginAs(pool[4], password, A)).status, 200);
      });
      assert.deepStrictEqual(normalizePasswordAttempts({}).perIp, { maxFailures: 30, windowSeconds: 900 });
      assert.deepStrictEqual(normalizePasswordAttempts({ perIp: { maxFailures: 'x', windowSeconds: 0 } }).perIp,
        { maxFailures: 30, windowSeconds: 900 }, 'an invalid value keeps the default');
    });
  });
});
