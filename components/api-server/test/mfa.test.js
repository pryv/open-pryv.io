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
 * MFA acceptance tests.
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
const { injectTestConfigSnapshot } = require('test-helpers');
const { _resetMFASingletons } = require('business/src/mfa/index.ts');
const { base32Decode, totpCode } = require('business/src/mfa/totp.ts');
const crypto = require('node:crypto');

const SMS_HOST = 'http://sms-mock.local';

// A fixed 32-byte at-rest key (base64) for the TOTP test config, and a helper
// that computes a code for a given step offset (0 = current 30s step).
const TOTP_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
const totpTestConfig = {
  services: {
    mfa: {
      active: true,
      defaultMethod: 'totp',
      methods: {
        totp: { active: true, digits: 6, periodSeconds: 30, driftSteps: 1, secretsKey: TOTP_SECRETS_KEY },
        sms: { active: false }
      },
      sessions: { ttlSeconds: 1800 }
    }
  }
};
function totpCodeFor (secretB32, offsetSteps = 0) {
  const now = Math.floor(Date.now() / 1000);
  return totpCode(base32Decode(secretB32), { time: now + offsetSteps * 30, periodSeconds: 30, digits: 6 });
}

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
  // nock >=14 patches the global http stack via @mswjs/interceptors; if a
  // suite leaves it active, later suites' REAL requests flow through the
  // mock socket and intermittently die ("socket hang up"). Activate on
  // entry (restore() in a previous suite deactivates globally), fully
  // restore on exit.
  before(() => { if (!nock.isActive()) nock.activate(); });
  after(() => { nock.cleanAll(); nock.restore(); });

  this.timeout(20000);

  let fixtures;
  let username;
  let password;
  let personalToken;

  before(async function () {
    await initTests();
    await initCore();
    await getConfig();
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
    await _resetMFASingletons();
    nock.cleanAll();
  });

  after(async function () {
    if (fixtures) await fixtures.context.cleanEverything();
    nock.enableNetConnect();
  });

  // --------------------------------------------------------------------
  // MFA now ships ENABLED by default (TOTP), so the "disabled" path must be
  // asserted against an explicitly-disabled config, not the default.
  describe('[MA1] when services.mfa is explicitly disabled', function () {
    let restoreConfig;
    beforeEach(async function () {
      restoreConfig = injectTestConfigSnapshot({ services: { mfa: { active: false } } });
      await _resetMFASingletons();
    });
    afterEach(function () {
      restoreConfig();
    });

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
  // The SHIPPED DEFAULT (no config injection): MFA active, TOTP the default
  // method, working out of the box off the test core's adminAccessKey.
  describe('[MA15] shipped default (TOTP enabled out of the box)', function () {
    beforeEach(async function () { await _resetMFASingletons(); });
    afterEach(async function () { await _resetMFASingletons(); });

    it('[MA15A] an unenrolled user still logs in directly (nothing forced)', async function () {
      const res = await coreRequest
        .post(`/${username}/auth/login`)
        .set('Origin', 'http://test.pryv.local')
        .send({ username, password, appId: 'pryv-test' });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.token != null);
      assert.ok(res.body.mfaToken == null);
    });

    it('[MA15B] mfa.activate returns a TOTP enrolment payload with no MFA config', async function () {
      const res = await coreRequest
        .post(`/${username}/mfa/activate`)
        .set('Authorization', personalToken)
        .send({});
      assert.strictEqual(res.status, 302, `activate failed: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.method, 'totp');
      assert.match(res.body.otpauthUri, /^otpauth:\/\/totp\//);
      assert.match(res.body.secret, /^[A-Z2-7]+$/);
    });

    it('[MA15C] full TOTP ceremony works under pure defaults', async function () {
      const act = await coreRequest
        .post(`/${username}/mfa/activate`).set('Authorization', personalToken).send({});
      assert.strictEqual(act.status, 302);
      const secret = act.body.secret;
      const confirm = await coreRequest
        .post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
        .send({ code: totpCodeFor(secret, -1) });
      assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
      assert.strictEqual(confirm.body.recoveryCodes.length, 10);
      const loginRes = await coreRequest
        .post(`/${username}/auth/login`).set('Origin', 'http://test.pryv.local')
        .send({ username, password, appId: 'pryv-test' });
      assert.strictEqual(loginRes.body.mfaMethod, 'totp');
      const verify = await coreRequest
        .post(`/${username}/mfa/verify`).set('Authorization', loginRes.body.mfaToken)
        .send({ code: totpCodeFor(secret, 0) });
      assert.strictEqual(verify.status, 200, `verify failed: ${JSON.stringify(verify.body)}`);
      assert.ok(verify.body.token != null);
    });
  });

  // --------------------------------------------------------------------
  describe('[MA2] when services.mfa.mode is "challenge-verify"', function () {
    let restoreConfig;
    beforeEach(async function () {
      restoreConfig = injectTestConfigSnapshot(mfaConfig);
      await _resetMFASingletons();
    });
    afterEach(function () {
      restoreConfig();
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
        assert.strictEqual(res.status, 302, `hook mfa.activate failed: ${JSON.stringify(res.body)}`);
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
        assert.strictEqual(activateRes.status, 302, `hook mfa.activate failed: ${JSON.stringify(activateRes.body)}`);
        const confirmRes = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', activateRes.body.mfaToken)
          .send({ code: '1234' });
        assert.strictEqual(confirmRes.status, 200, `hook mfa.confirm failed: ${JSON.stringify(confirmRes.body)}`);

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
        assert.strictEqual(activateRes.status, 302, `hook mfa.activate failed: ${JSON.stringify(activateRes.body)}`);
        const confirmRes = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', activateRes.body.mfaToken)
          .send({ code: '1234' });
        assert.strictEqual(confirmRes.status, 200, `hook mfa.confirm failed: ${JSON.stringify(confirmRes.body)}`);
      });

      it('[MA6A] clears the MFA profile; subsequent login returns a real token', async function () {
        const deactivateRes = await coreRequest
          .post(`/${username}/mfa/deactivate`)
          .set('Authorization', personalToken)
          .send({});
        assert.strictEqual(deactivateRes.status, 200, `mfa.deactivate failed: ${JSON.stringify(deactivateRes.body)}`);

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
        assert.strictEqual(activateRes.status, 302, `hook mfa.activate failed: ${JSON.stringify(activateRes.body)}`);
        const confirmRes = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', activateRes.body.mfaToken)
          .send({ code: '1234' });
        assert.strictEqual(confirmRes.status, 200, `hook mfa.confirm failed: ${JSON.stringify(confirmRes.body)}`);
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

      it('[MA7D] a wrong password and a wrong recovery code stay uniform for an existing user', async function () {
        // Scope note: an unknown username is rejected earlier, by the route's
        // context init, with 404 unknown-resource. That happens on every
        // /:username/* route (auth/login included), so it is a property of the
        // API surface and not of this endpoint, and it is NOT asserted here.
        // What this pins is the part this endpoint owns: for an existing user,
        // the two failure modes return exactly what they always have, so no
        // limiter or lock state can start distinguishing accounts through them.
        const wrongPwd = await coreRequest
          .post(`/${username}/mfa/recover`)
          .send({ username, password: 'wrong', recoveryCode: recoveryCodes[0] });
        assert.strictEqual(wrongPwd.status, 401);
        assert.strictEqual(wrongPwd.body.error.id, 'invalid-credentials');

        const wrongCode = await coreRequest
          .post(`/${username}/mfa/recover`)
          .send({ username, password, recoveryCode: 'not-a-real-code' });
        assert.strictEqual(wrongCode.status, 400);

        // Neither may ever become a throttle response.
        assert.notStrictEqual(wrongPwd.status, 429);
        assert.notStrictEqual(wrongCode.status, 429);
      });

      it('[MA7E] the constant-time code comparison still accepts and rejects correctly', async function () {
        const valid = recoveryCodes[2];
        // Same length, differs only in the final character.
        const lastChar = valid.slice(-1);
        const nearMiss = valid.slice(0, -1) + (lastChar === 'a' ? 'b' : 'a');
        const nearRes = await coreRequest
          .post(`/${username}/mfa/recover`).send({ username, password, recoveryCode: nearMiss });
        assert.strictEqual(nearRes.status, 400, 'a code differing in one character must be rejected');

        // Different length.
        const shortRes = await coreRequest
          .post(`/${username}/mfa/recover`).send({ username, password, recoveryCode: valid.slice(0, -1) });
        assert.strictEqual(shortRes.status, 400, 'a shorter code must be rejected');

        // The exact code still works (last: it deactivates MFA).
        const okRes = await coreRequest
          .post(`/${username}/mfa/recover`).send({ username, password, recoveryCode: valid });
        assert.strictEqual(okRes.status, 200, `the valid code must be accepted: ${JSON.stringify(okRes.body)}`);
      });
    });
  });

  // --------------------------------------------------------------------
  // TOTP (authenticator app) — the default method when MFA is enabled.
  // In-process core: test and server share one clock, so step-offset codes
  // are deterministic. Confirm advances the replay guard, so the login-verify
  // setup confirms with the previous step's code (still within drift) to keep
  // the current-step code usable without waiting for a new 30s window.
  describe('[MA10] TOTP method', function () {
    let restoreConfig;
    beforeEach(async function () {
      restoreConfig = injectTestConfigSnapshot(totpTestConfig);
      await _resetMFASingletons();
    });
    afterEach(function () {
      restoreConfig();
    });

    function activateTotp () {
      return coreRequest
        .post(`/${username}/mfa/activate`)
        .set('Authorization', personalToken)
        .send({ method: 'totp' });
    }
    function login () {
      return coreRequest
        .post(`/${username}/auth/login`)
        .set('Origin', 'http://test.pryv.local')
        .send({ username, password, appId: 'pryv-test' });
    }

    describe('[MA10E] enrolment', function () {
      it('[MA10A] activate(totp)+confirm returns an otpauth URI + secret, then recovery codes', async function () {
        const act = await activateTotp();
        assert.strictEqual(act.status, 302, `activate failed: ${JSON.stringify(act.body)}`);
        assert.strictEqual(act.body.method, 'totp');
        assert.match(act.body.otpauthUri, /^otpauth:\/\/totp\//);
        assert.match(act.body.secret, /^[A-Z2-7]+$/);
        assert.ok(act.body.mfaToken != null);

        const confirm = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', act.body.mfaToken)
          .send({ code: totpCodeFor(act.body.secret, 0) });
        assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
        assert.strictEqual(confirm.body.recoveryCodes.length, 10);
      });

      it('[MA10B] confirm with a wrong code returns 400 and persists nothing', async function () {
        const act = await activateTotp();
        const confirm = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', act.body.mfaToken)
          .send({ code: '000000' });
        assert.strictEqual(confirm.status, 400);
        const loginRes = await login();
        assert.ok(loginRes.body.token != null);
        assert.ok(loginRes.body.mfaToken == null);
      });

      it('[MA10C] an unconfirmed secret is never usable at login', async function () {
        await activateTotp(); // no confirm
        const loginRes = await login();
        assert.ok(loginRes.body.token != null);
        assert.ok(loginRes.body.mfaToken == null);
      });

      it('[MA10D] activate without an explicit method uses the configured default (totp)', async function () {
        const res = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({});
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.body.method, 'totp');
        assert.ok(res.body.otpauthUri != null);
      });
    });

    describe('[MA11] login + verify', function () {
      let secret;
      beforeEach(async function () {
        const act = await activateTotp();
        secret = act.body.secret;
        const confirm = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', act.body.mfaToken)
          .send({ code: totpCodeFor(secret, -1) });
        assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
      });

      it('[MA11A] login returns mfaToken+mfaMethod=totp; verify releases the real token', async function () {
        const loginRes = await login();
        assert.strictEqual(loginRes.status, 200);
        assert.strictEqual(loginRes.body.mfaMethod, 'totp');
        assert.ok(loginRes.body.mfaToken != null);
        assert.ok(loginRes.body.token == null);

        const verify = await coreRequest
          .post(`/${username}/mfa/verify`)
          .set('Authorization', loginRes.body.mfaToken)
          .send({ code: totpCodeFor(secret, 0) });
        assert.strictEqual(verify.status, 200, `verify failed: ${JSON.stringify(verify.body)}`);
        assert.ok(verify.body.token != null);
      });

      it('[MA11B] verify with a wrong code returns 400', async function () {
        const loginRes = await login();
        const verify = await coreRequest
          .post(`/${username}/mfa/verify`)
          .set('Authorization', loginRes.body.mfaToken)
          .send({ code: '000000' });
        assert.strictEqual(verify.status, 400);
      });

      it('[MA11E] a used code cannot be replayed', async function () {
        const loginRes = await login();
        const code = totpCodeFor(secret, 0);
        const first = await coreRequest
          .post(`/${username}/mfa/verify`)
          .set('Authorization', loginRes.body.mfaToken)
          .send({ code });
        assert.strictEqual(first.status, 200);

        const loginRes2 = await login();
        const replay = await coreRequest
          .post(`/${username}/mfa/verify`)
          .set('Authorization', loginRes2.body.mfaToken)
          .send({ code });
        assert.strictEqual(replay.status, 400);
      });

      it('[MA11F] five failed verifies invalidate the MFA session', async function () {
        const loginRes = await login();
        const token = loginRes.body.mfaToken;
        for (let i = 0; i < 4; i++) {
          const r = await coreRequest
            .post(`/${username}/mfa/verify`).set('Authorization', token).send({ code: '000000' });
          assert.strictEqual(r.status, 400, `attempt ${i + 1} should be 400`);
        }
        const fifth = await coreRequest
          .post(`/${username}/mfa/verify`).set('Authorization', token).send({ code: '000000' });
        assert.strictEqual(fifth.status, 401, 'the 5th failure should invalidate the session');
        const after = await coreRequest
          .post(`/${username}/mfa/verify`).set('Authorization', token).send({ code: totpCodeFor(secret, 0) });
        assert.strictEqual(after.status, 401);
      });

      it('[MA11G] a code consumed by one login session cannot be replayed on another concurrent session', async function () {
        // Two pending login sessions opened BEFORE any verify (the F1 attack:
        // the replay guard must consult the stored step, not each session's
        // login-time snapshot).
        const a = await login();
        const b = await login();
        const code = totpCodeFor(secret, 0);
        const vA = await coreRequest
          .post(`/${username}/mfa/verify`).set('Authorization', a.body.mfaToken).send({ code });
        assert.strictEqual(vA.status, 200, `first verify should succeed: ${JSON.stringify(vA.body)}`);
        const vB = await coreRequest
          .post(`/${username}/mfa/verify`).set('Authorization', b.body.mfaToken).send({ code });
        assert.strictEqual(vB.status, 400, 'replay on the concurrent session must be refused');
      });
    });

    describe('[MA13] deactivate', function () {
      it('[MA13B] deactivate wipes the TOTP enrolment', async function () {
        const act = await activateTotp();
        const confirm = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', act.body.mfaToken)
          .send({ code: totpCodeFor(act.body.secret, 0) });
        assert.strictEqual(confirm.status, 200);

        const deactivate = await coreRequest
          .post(`/${username}/mfa/deactivate`)
          .set('Authorization', personalToken)
          .send({});
        assert.strictEqual(deactivate.status, 200);

        const loginRes = await login();
        assert.ok(loginRes.body.token != null);
        assert.ok(loginRes.body.mfaToken == null);
      });
    });

    // ------------------------------------------------------------------
    // Per-account attempt limiter. The per-session ceiling alone is not a
    // limit: re-authenticating used to hand out a fresh budget, so N logins
    // bought 5N guesses. These tests pin that this is no longer true.
    // ------------------------------------------------------------------
    describe('[MA12] per-account attempt limiter', function () {
      const PER_SESSION = 5;
      const PER_ACCOUNT = 8;
      let restoreAttempts;
      let secret;

      function withAttempts (attempts) {
        return {
          services: {
            mfa: {
              ...totpTestConfig.services.mfa,
              attempts: {
                perSession: PER_SESSION,
                perAccount: PER_ACCOUNT,
                // Long enough that the accrual window cannot expire part-way
                // through a test on a slow run; these cases are about the
                // ceiling, not about the window rolling over. A test that
                // wants expiry sets its own value.
                perAccountWindowSeconds: 3600,
                lockoutSeconds: 1,
                ...attempts
              }
            }
          }
        };
      }

      async function enrol () {
        const act = await activateTotp();
        secret = act.body.secret;
        const confirm = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', act.body.mfaToken)
          .send({ code: totpCodeFor(secret, -1) });
        assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
        return confirm.body.recoveryCodes;
      }

      /**
       * One wrong guess on a brand-new login session.
       *
       * Asserts that the attempt actually REACHED the limiter. Without this,
       * a request that failed for an unrelated reason would be counted by the
       * caller as a consumed guess while the server never accrued it, and the
       * mismatch would surface later as a confusing off-by-one in whichever
       * assertion happened to run next, rather than here where it happened.
       */
      async function guessOnFreshLogin (code = '000000') {
        const loginRes = await login();
        assert.strictEqual(loginRes.status, 200,
          `login itself must never be blocked by the MFA lock (got ${loginRes.status} ${JSON.stringify(loginRes.body)})`);
        const res = await coreRequest
          .post(`/${username}/mfa/verify`)
          .set('Authorization', loginRes.body.mfaToken)
          .send({ code });
        assert.ok([200, 400, 401, 429].includes(res.status),
          `a guess must reach the limiter; got ${res.status} ${JSON.stringify(res.body)}`);
        return res;
      }

      afterEach(function () {
        if (restoreAttempts) restoreAttempts();
        restoreAttempts = null;
      });

      it('[MA12A] fresh logins no longer buy a fresh budget; the account locks and even a correct code is refused', async function () {
        restoreAttempts = injectTestConfigSnapshot(withAttempts());
        await _resetMFASingletons();
        await enrol();

        // The reported attack: one wrong guess per fresh login, repeatedly.
        // The lock engages ON the perAccount-th guess (that one answers 429),
        // so the total budget across all logins is exactly perAccount guesses
        // rather than the perSession budget renewed on every login.
        let guesses = 0;
        let locked = null;
        for (let i = 0; i < PER_ACCOUNT + 4; i++) {
          const res = await guessOnFreshLogin();
          guesses++;
          if (res.status === 429) { locked = res; break; }
          assert.ok(res.status === 400 || res.status === 401,
            `guess ${i + 1} unexpected status ${res.status}: ${JSON.stringify(res.body)}`);
        }

        assert.ok(locked != null, 'the account must lock; it never did');
        assert.strictEqual(guesses, PER_ACCOUNT,
          `the lock must engage on guess ${PER_ACCOUNT}, it engaged on ${guesses}`);
        // The point of the issue: the old behaviour would have allowed
        // perSession guesses per login with no ceiling at all.
        assert.ok(guesses < PER_SESSION * 3, 'three logins must not yield three full budgets');
        assert.strictEqual(locked.body.error.id, 'too-many-attempts');
        assert.ok(locked.headers['retry-after'] != null, 'a Retry-After header should be set');

        // The reporter's "a correct code still logs in" must now be FALSE.
        const correct = await guessOnFreshLogin(totpCodeFor(secret, 0));
        assert.strictEqual(correct.status, 429, 'a correct code must be refused while locked');
        assert.strictEqual(correct.body.error.id, 'too-many-attempts');
      });

      it('[MA12B] the lock lifts on its own once lockoutSeconds elapses', async function () {
        restoreAttempts = injectTestConfigSnapshot(withAttempts({ lockoutSeconds: 1 }));
        await _resetMFASingletons();
        await enrol();

        for (let i = 0; i < PER_ACCOUNT; i++) await guessOnFreshLogin();
        const stillLocked = await guessOnFreshLogin(totpCodeFor(secret, 0));
        assert.strictEqual(stillLocked.status, 429);

        await new Promise((resolve) => setTimeout(resolve, 1200));

        const after = await guessOnFreshLogin(totpCodeFor(secret, 0));
        assert.strictEqual(after.status, 200, `login should work after the lock expires: ${JSON.stringify(after.body)}`);
        assert.ok(after.body.token != null);
      });

      it('[MA12C] perAccount:0 disables the per-account limit (behaviour as before)', async function () {
        restoreAttempts = injectTestConfigSnapshot(withAttempts({ perAccount: 0 }));
        await _resetMFASingletons();
        await enrol();

        // Well past the former ceiling: no lock, ever.
        for (let i = 0; i < PER_ACCOUNT + 6; i++) {
          const res = await guessOnFreshLogin();
          assert.notStrictEqual(res.status, 429, `guess ${i + 1} must not be throttled when perAccount is 0`);
        }
        const correct = await guessOnFreshLogin(totpCodeFor(secret, 0));
        assert.strictEqual(correct.status, 200, 'a correct code must still work');
      });

      it('[MA12D] the per-session ceiling is unchanged, and its failures also accrue per account', async function () {
        restoreAttempts = injectTestConfigSnapshot(withAttempts());
        await _resetMFASingletons();
        await enrol();

        // Burn one whole session: 4 x 400 then a 401 that kills the session.
        const loginRes = await login();
        const token = loginRes.body.mfaToken;
        for (let i = 0; i < PER_SESSION - 1; i++) {
          const r = await coreRequest
            .post(`/${username}/mfa/verify`).set('Authorization', token).send({ code: '000000' });
          assert.strictEqual(r.status, 400, `attempt ${i + 1} should be 400`);
        }
        const last = await coreRequest
          .post(`/${username}/mfa/verify`).set('Authorization', token).send({ code: '000000' });
        assert.strictEqual(last.status, 401, 'the per-session ceiling still invalidates the session');

        // Those failures counted toward the account: the lock engages on the
        // (PER_ACCOUNT - PER_SESSION)-th further guess, not on a fresh budget.
        let further = 0;
        for (let i = 0; i < PER_ACCOUNT + 2; i++) {
          const res = await guessOnFreshLogin();
          further++;
          if (res.status === 429) break;
        }
        assert.strictEqual(further, PER_ACCOUNT - PER_SESSION,
          'session failures must count toward the per-account tally, not grant a fresh budget');
      });

      it('[MA12E] mfa.recover lifts the lock along with the enrolment', async function () {
        restoreAttempts = injectTestConfigSnapshot(withAttempts({ lockoutSeconds: 3600 }));
        await _resetMFASingletons();
        const recoveryCodes = await enrol();

        for (let i = 0; i < PER_ACCOUNT; i++) await guessOnFreshLogin();
        const locked = await guessOnFreshLogin(totpCodeFor(secret, 0));
        assert.strictEqual(locked.status, 429, 'precondition: the account is locked');

        const recover = await coreRequest
          .post(`/${username}/mfa/recover`)
          .send({ username, password, recoveryCode: recoveryCodes[0] });
        assert.strictEqual(recover.status, 200, `recover failed: ${JSON.stringify(recover.body)}`);

        // MFA is gone, so login returns a real token directly; the lock did
        // not outlive the enrolment it was guarding.
        const loginRes = await login();
        assert.strictEqual(loginRes.status, 200);
        assert.ok(loginRes.body.token != null, 'login must work after recovery');
        assert.ok(loginRes.body.mfaToken == null);
      });

      it('[MA12F] the throttle never damages the enrolment, and a real success resets the tally', async function () {
        restoreAttempts = injectTestConfigSnapshot(withAttempts());
        await _resetMFASingletons();
        await enrol();

        // Stop one short of the ceiling.
        for (let i = 0; i < PER_ACCOUNT - 1; i++) {
          const res = await guessOnFreshLogin();
          assert.notStrictEqual(res.status, 429, `guess ${i + 1} should not lock yet`);
        }

        // The enrolment is intact despite all those throttle writes.
        const ok = await guessOnFreshLogin(totpCodeFor(secret, 0));
        assert.strictEqual(ok.status, 200, `enrolment must survive the throttle writes: ${JSON.stringify(ok.body)}`);

        // And the successful factor reset the tally: the same number of wrong
        // guesses is accepted again rather than locking on the next one.
        for (let i = 0; i < PER_ACCOUNT - 1; i++) {
          const res = await guessOnFreshLogin();
          assert.notStrictEqual(res.status, 429,
            `guess ${i + 1} after a success should not lock; the tally was not reset`);
        }
      });

      // mfa.recover is the last-resort path and is deliberately exempt from the
      // limiter in BOTH its steps. These two pin that exemption from both
      // sides: a recover failure must not consume the account's budget, and a
      // locked account must not be refused recovery. The budget is checked
      // behaviourally rather than by reading storage: if a recover attempt had
      // accrued, the lock would arrive one guess early.
      function recoverWith (body) {
        return coreRequest.post(`/${username}/mfa/recover`).send(body);
      }

      it('[MA12H] a wrong password on recover neither feeds the lock nor is blocked by it', async function () {
        restoreAttempts = injectTestConfigSnapshot(withAttempts({ lockoutSeconds: 3600 }));
        await _resetMFASingletons();
        const codes = await enrol();

        // One guess short of the ceiling.
        for (let i = 0; i < PER_ACCOUNT - 1; i++) await guessOnFreshLogin();

        const wrongPwd = await recoverWith({ username, password: 'wrong', recoveryCode: codes[0] });
        assert.strictEqual(wrongPwd.status, 401, 'a wrong password must stay 401, never 429');
        assert.strictEqual(wrongPwd.body.error.id, 'invalid-credentials');

        // Budget untouched: the very next guess is still the one that locks.
        const locking = await guessOnFreshLogin();
        assert.strictEqual(locking.status, 429, 'the recover attempt must not have consumed the budget');

        // And recovery stays reachable while the MFA step is locked.
        const underLock = await recoverWith({ username, password: 'wrong', recoveryCode: codes[0] });
        assert.strictEqual(underLock.status, 401, 'recover must never answer 429');
        assert.strictEqual(underLock.body.error.id, 'invalid-credentials');
      });

      it('[MA12I] a wrong recovery code neither feeds the lock nor is blocked by it', async function () {
        restoreAttempts = injectTestConfigSnapshot(withAttempts({ lockoutSeconds: 3600 }));
        await _resetMFASingletons();
        await enrol();

        for (let i = 0; i < PER_ACCOUNT - 1; i++) await guessOnFreshLogin();

        const badCode = await recoverWith({ username, password, recoveryCode: 'not-a-real-code' });
        assert.strictEqual(badCode.status, 400, 'a wrong recovery code must stay 400, never 429');

        const locking = await guessOnFreshLogin();
        assert.strictEqual(locking.status, 429, 'the recover attempt must not have consumed the budget');

        const underLock = await recoverWith({ username, password, recoveryCode: 'not-a-real-code' });
        assert.strictEqual(underLock.status, 400, 'recover must never answer 429');
      });
    });
  });
});
