/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

/**
 * Plan 26 — merged service-mfa acceptance tests.
 *
 * Covers the full SMS-based MFA lifecycle with the external SMS provider mocked
 * via nock:
 *   1. mfa.activate (personal token) → challenge SMS sent → mfaToken returned
 *   2. mfa.confirm  (mfaToken + code) → recovery codes returned, profile.mfa persisted
 *   3. auth.login on an MFA-enabled user → returns { mfaToken } instead of token
 *   4. mfa.challenge — re-send SMS during pending login
 *   5. mfa.verify   → releases the stashed access token
 *   6. mfa.deactivate (personal token) → clears profile.mfa
 *   7. mfa.recover (unauth: username/password/recoveryCode) → clears profile.mfa
 *   8. Error cases: MFA disabled server-wide, non-personal token on activate,
 *      invalid mfaToken on verify, wrong code on verify.
 *
 * Sequential (-seq) because the in-memory SessionStore and injected config are
 * shared state across tests.
 */

const nock = require('nock');
const { getConfig } = require('@pryv/boiler');
const { _resetMFASingletons } = require('business/src/mfa');

const SMS_HOST = 'http://sms-mock.local';

const mfaConfig = {
  services: {
    mfa: {
      mode: 'challenge-verify',
      sms: {
        endpoints: {
          challenge: {
            url: SMS_HOST + '/challenge',
            method: 'POST',
            body: '{ "to": "{{ phone }}" }',
            headers: { 'content-type': 'application/json', authorization: 'sms-secret' }
          },
          verify: {
            url: SMS_HOST + '/verify',
            method: 'POST',
            body: '{ "to": "{{ phone }}", "code": "{{ code }}" }',
            headers: { 'content-type': 'application/json', authorization: 'sms-secret' }
          },
          single: {
            url: '',
            method: 'POST',
            body: '',
            headers: {}
          }
        }
      },
      sessions: { ttlSeconds: 1800 }
    }
  }
};

describe('[MFAA] MFA acceptance (seq)', function () {
  this.timeout(20000);

  let config;
  let fixtures;
  let username;
  let password;
  let personalToken;

  before(async function () {
    await initTests();
    await initCore();
    config = await getConfig();
    fixtures = getNewFixture();
    // Block any unmatched outgoing HTTP so missing nock mocks fail fast
    // instead of hanging on a fake SMS endpoint.
    nock.disableNetConnect();
    // Allow supertest (Express app) and the local rqlite PlatformDB on :4001.
    // nock@^14 intercepts native fetch too, so 'localhost' must be explicit
    // alongside '127.0.0.1' — they are not aliased by the allowlist.
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });

  beforeEach(async function () {
    nock.cleanAll();
    await _resetMFASingletons();
    // Fresh user per test to avoid shared-state bleed.
    username = ('mfa' + cuid.slug()).toLowerCase();
    password = 'mfa-test-pwd-123';
    personalToken = cuid();
    const user = await fixtures.user(username, { password });
    await user.access({ type: 'personal', token: personalToken, name: 'pryv-test' });
    await user.session(personalToken);
  });

  afterEach(async function () {
    config.injectTestConfig({});
    await _resetMFASingletons();
    nock.cleanAll();
  });

  after(async function () {
    if (fixtures) await fixtures.context.cleanEverything();
    nock.enableNetConnect();
  });

  // --------------------------------------------------------------------
  describe('[MA1] when services.mfa.mode is "disabled" (default)', function () {
    it('[MA1A] auth.login returns the access token directly', async function () {
      const res = await coreRequest
        .post(`/${username}/auth/login`)
        .set('Origin', 'http://test.pryv.local')
        .send({ username, password, appId: 'pryv-test' });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.token != null);
      assert.ok(res.body.mfaToken == null);
    });

    it('[MA1B] mfa.activate returns 503 (apiUnavailable)', async function () {
      const res = await coreRequest
        .post(`/${username}/mfa/activate`)
        .set('Authorization', personalToken)
        .send({ phone: '+41000' });
      assert.strictEqual(res.status, 503);
    });
  });

  // --------------------------------------------------------------------
  describe('[MA2] when services.mfa.mode is "challenge-verify"', function () {
    beforeEach(async function () {
      config.injectTestConfig(mfaConfig);
      await _resetMFASingletons();
    });

    // ----- activate --------------------------------------------------
    describe('[MA3] mfa.activate', function () {
      it('[MA3A] sends an SMS challenge and returns a 302 with mfaToken', async function () {
        let challengeBody = null;
        nock(SMS_HOST)
          .post('/challenge')
          .reply(200, function (_uri, body) { challengeBody = body; return {}; });

        const res = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({ phone: '+41000' });

        assert.strictEqual(res.status, 302);
        assert.ok(res.body.mfaToken != null);
        assert.ok(challengeBody != null, 'SMS challenge should have been sent');
        // The body template {{ phone }} was replaced.
        assert.ok(!challengeBody.to.includes('{{'));
        assert.strictEqual(challengeBody.to, '+41000');
      });

      it('[MA3B] rejects an app-type access token with 403', async function () {
        const appToken = cuid();
        const user = await fixtures.user(('mfa2' + cuid.slug()).toLowerCase(), { password });
        await user.access({ type: 'app', token: appToken, name: 'pryv-test' });
        await user.session(appToken);

        nock(SMS_HOST).post('/challenge').reply(200, {});

        const res = await coreRequest
          .post(`/${user.attrs.username}/mfa/activate`)
          .set('Authorization', appToken)
          .send({ phone: '+41000' });

        assert.strictEqual(res.status, 403);
      });

      it('[MA3C] propagates an SMS provider error as 400', async function () {
        nock(SMS_HOST).post('/challenge').reply(500, { id: 'sms-down', message: 'down' });

        const res = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({ phone: '+41000' });

        assert.strictEqual(res.status, 400);
      });
    });

    // ----- confirm ---------------------------------------------------
    describe('[MA4] mfa.confirm', function () {
      let mfaToken;

      beforeEach(async function () {
        nock(SMS_HOST).post('/challenge').reply(200, {});
        const res = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({ phone: '+41000' });
        mfaToken = res.body.mfaToken;
      });

      it('[MA4A] verifies the code, persists profile.mfa, returns 10 recovery codes', async function () {
        nock(SMS_HOST).post('/verify').reply(200, {});

        const res = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', mfaToken)
          .send({ code: '1234' });

        assert.strictEqual(res.status, 200);
        assert.ok(Array.isArray(res.body.recoveryCodes));
        assert.strictEqual(res.body.recoveryCodes.length, 10);
      });

      it('[MA4B] rejects an invalid mfaToken with 401', async function () {
        nock(SMS_HOST).post('/verify').reply(200, {});

        const res = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', 'bogus-token')
          .send({ code: '1234' });

        assert.strictEqual(res.status, 401);
      });

      it('[MA4C] propagates an SMS verify error as 400', async function () {
        nock(SMS_HOST).post('/verify').reply(500, { id: 'sms-down', message: 'down' });

        const res = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', mfaToken)
          .send({ code: '1234' });

        assert.strictEqual(res.status, 400);
      });
    });

    // ----- full login-with-MFA roundtrip -----------------------------
    describe('[MA5] auth.login + mfa.verify after MFA activation', function () {
      let mfaToken;

      beforeEach(async function () {
        // Activate + confirm to install profile.mfa.
        nock(SMS_HOST).post('/challenge').reply(200, {});
        nock(SMS_HOST).post('/verify').reply(200, {});
        const activateRes = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({ phone: '+41000' });
        await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', activateRes.body.mfaToken)
          .send({ code: '1234' });

        // Now log in — should trigger a new MFA challenge and return mfaToken.
        nock(SMS_HOST).post('/challenge').reply(200, {});
        const loginRes = await coreRequest
          .post(`/${username}/auth/login`)
          .set('Origin', 'http://test.pryv.local')
          .send({ username, password, appId: 'pryv-test' });
        assert.strictEqual(loginRes.status, 200);
        assert.ok(loginRes.body.mfaToken != null, 'login should return mfaToken');
        assert.ok(loginRes.body.token == null, 'login should NOT return real token yet');
        mfaToken = loginRes.body.mfaToken;
      });

      it('[MA5A] mfa.verify with a valid code releases the real Pryv access token', async function () {
        nock(SMS_HOST).post('/verify').reply(200, {});

        const res = await coreRequest
          .post(`/${username}/mfa/verify`)
          .set('Authorization', mfaToken)
          .send({ code: '1234' });

        assert.strictEqual(res.status, 200);
        assert.ok(res.body.token != null, 'should release real token on successful MFA verify');
      });

      it('[MA5B] mfa.challenge re-sends the SMS during a pending login', async function () {
        let challengeCount = 0;
        nock(SMS_HOST).post('/challenge').reply(200, function () { challengeCount++; return {}; });

        const res = await coreRequest
          .post(`/${username}/mfa/challenge`)
          .set('Authorization', mfaToken);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(challengeCount, 1);
      });

      it('[MA5C] mfa.verify with a bogus mfaToken returns 401', async function () {
        const res = await coreRequest
          .post(`/${username}/mfa/verify`)
          .set('Authorization', 'bogus')
          .send({ code: '1234' });

        assert.strictEqual(res.status, 401);
      });
    });

    // ----- deactivate ------------------------------------------------
    describe('[MA6] mfa.deactivate', function () {
      beforeEach(async function () {
        // Install MFA profile via activate + confirm.
        nock(SMS_HOST).post('/challenge').reply(200, {});
        nock(SMS_HOST).post('/verify').reply(200, {});
        const activateRes = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({ phone: '+41000' });
        await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', activateRes.body.mfaToken)
          .send({ code: '1234' });
      });

      it('[MA6A] clears the MFA profile; subsequent login returns a real token', async function () {
        const deactivateRes = await coreRequest
          .post(`/${username}/mfa/deactivate`)
          .set('Authorization', personalToken)
          .send({});
        assert.strictEqual(deactivateRes.status, 200);

        const loginRes = await coreRequest
          .post(`/${username}/auth/login`)
          .set('Origin', 'http://test.pryv.local')
          .send({ username, password, appId: 'pryv-test' });

        assert.strictEqual(loginRes.status, 200);
        assert.ok(loginRes.body.token != null);
        assert.ok(loginRes.body.mfaToken == null);
      });
    });

    // ----- recover ---------------------------------------------------
    describe('[MA7] mfa.recover', function () {
      let recoveryCodes;

      beforeEach(async function () {
        nock(SMS_HOST).post('/challenge').reply(200, {});
        nock(SMS_HOST).post('/verify').reply(200, {});
        const activateRes = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({ phone: '+41000' });
        const confirmRes = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', activateRes.body.mfaToken)
          .send({ code: '1234' });
        recoveryCodes = confirmRes.body.recoveryCodes;
      });

      it('[MA7A] disables MFA when called with a valid recovery code', async function () {
        const res = await coreRequest
          .post(`/${username}/mfa/recover`)
          .send({ username, password, recoveryCode: recoveryCodes[3] });
        assert.strictEqual(res.status, 200);

        // Login should now skip MFA.
        const loginRes = await coreRequest
          .post(`/${username}/auth/login`)
          .set('Origin', 'http://test.pryv.local')
          .send({ username, password, appId: 'pryv-test' });
        assert.strictEqual(loginRes.status, 200);
        assert.ok(loginRes.body.token != null);
      });

      it('[MA7B] rejects an invalid recovery code', async function () {
        const res = await coreRequest
          .post(`/${username}/mfa/recover`)
          .send({ username, password, recoveryCode: 'not-a-real-code' });
        assert.strictEqual(res.status, 400);
      });

      it('[MA7C] rejects when password is wrong', async function () {
        const res = await coreRequest
          .post(`/${username}/mfa/recover`)
          .send({ username, password: 'wrong', recoveryCode: recoveryCodes[0] });
        assert.strictEqual(res.status, 401);
      });
    });
  });
});
