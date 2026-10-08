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
 *   6. mfa.deactivate (personal token + step-up: password or current code) → clears profile.mfa
 *   7. mfa.recover (unauth: username/password/recoveryCode) → clears profile.mfa
 *   8. Error cases: MFA disabled server-wide, non-personal token on activate,
 *      invalid mfaToken on verify, wrong code on verify.
 *
 * Sequential (-seq) because the in-memory SessionStore and injected config are
 * shared state across tests.
 */

const nock = require('nock');
const { useNock } = require('test-helpers/src/nockScope.ts');
const { getConfig } = require('@pryv/boiler');
const { injectTestConfigSnapshot, pollUntil } = require('test-helpers');
const { _resetMFASingletons, getMFASessionStore } = require('business/src/mfa/index.ts');
const { base32Decode, totpCode } = require('business/src/mfa/totp.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const storage = require('storage');
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

// The enrolment confirm uses the previous step's code, so the following verify
// has a step of its own (replay protection). Generated in the last seconds of a
// step, that code is two steps old once the server checks it, outside the
// one-step drift: wait for the next step first.
async function previousStepCodeFor (secretB32) {
  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (left < 5) await new Promise((resolve) => setTimeout(resolve, left * 1000 + 100));
  return totpCodeFor(secretB32, -1);
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
        },
        // Re-sends right after a login are part of these flows.
        sendLimits: { minIntervalSeconds: 0 }
      },
      sessions: { ttlSeconds: 1800 }
    }
  }
};

describe('[MFAA] MFA acceptance (seq)', function () {
  useNock();

  this.timeout(20000);

  let fixtures;
  let username;
  let password;
  let personalToken;
  let fixtureUser;

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
    fixtureUser = await fixtures.user(username, { password });
    await fixtureUser.access({ type: 'personal', token: personalToken, name: 'pryv-test' });
    await fixtureUser.session(personalToken);
  });

  afterEach(async function () {
    await _resetMFASingletons();
    nock.cleanAll();
  });

  after(async function () {
    if (fixtures) await fixtures.context.cleanEverything();
    nock.enableNetConnect();
  });

  /** The accesses (id + token) of `user` and the session a login of `appId` would reuse, if any. */
  async function loginFootprintOf (user, appId) {
    const userRow = await (await getUsersRepository()).getUserByUsername(user);
    const layer = await storage.getStorageLayer();
    const accesses = await new Promise((resolve, reject) =>
      layer.accesses.find(userRow, {}, null, (err, res) => err ? reject(err) : resolve(res)));
    const session = await new Promise((resolve, reject) =>
      layer.sessions.getMatching({ username: user, appId, userId: userRow.id }, (err, id) => err ? reject(err) : resolve(id)));
    return {
      accesses: accesses.map((a) => ({ id: a.id, token: a.token })).sort((a, b) => a.id.localeCompare(b.id)),
      session: session ?? null
    };
  }
  // A trusted app with no personal access yet: a login that went through
  // would have to write both a session and an access.
  const FRESH_APP_ID = 'pryv-test-no-cors';
  function loginToApp (user, appId) {
    return coreRequest.post(`/${user}/auth/login`).set('Origin', 'http://test.pryv.local')
      .send({ username: user, password, appId });
  }

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
        .send({ phone: '+41791234567' });
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
        .send({ code: await previousStepCodeFor(secret) });
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

    it('[MA15D] a TOTP enrolment takes no content, and confirm or verify without a code is refused (400)', async function () {
      const withPhone = await coreRequest
        .post(`/${username}/mfa/activate`).set('Authorization', personalToken).send({ method: 'totp', phone: '+41791234567' });
      assert.strictEqual(withPhone.status, 400, JSON.stringify(withPhone.body));
      assert.strictEqual(withPhone.body.error.data.id, 'invalid-mfa-content');
      const act = await coreRequest
        .post(`/${username}/mfa/activate`).set('Authorization', personalToken).send({ method: 'totp' });
      assert.strictEqual(act.status, 302, JSON.stringify(act.body));
      const noCode = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken).send({});
      assert.strictEqual(noCode.status, 400, JSON.stringify(noCode.body));
      assert.strictEqual(noCode.body.error.id, 'invalid-parameters-format');
      const confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
        .send({ code: await previousStepCodeFor(act.body.secret) });
      assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
      const loginRes = await coreRequest
        .post(`/${username}/auth/login`).set('Origin', 'http://test.pryv.local')
        .send({ username, password, appId: 'pryv-test' });
      const verify = await coreRequest.post(`/${username}/mfa/verify`).set('Authorization', loginRes.body.mfaToken).send({});
      assert.strictEqual(verify.status, 400, JSON.stringify(verify.body));
      assert.strictEqual(verify.body.error.id, 'invalid-parameters-format');
    });
  });

  // --------------------------------------------------------------------
  describe('[MA16] a delegate personal token cannot change the owner MFA', function () {
    let delegateToken;
    beforeEach(async function () {
      // Minted storage-side the way the delegation plugin does: personal, marked.
      delegateToken = 'deleg-' + cuid();
      await fixtureUser.access({
        type: 'personal',
        token: delegateToken,
        name: 'delegation:ma16-parent@core',
        clientData: { delegation: { kind: 'delegate-pat', relId: 'ma16-rel', delegate: { username: 'ma16-parent', hostSlug: 'core' } } }
      });
      await fixtureUser.session(delegateToken);
    });

    it('[MA16A] mfa.activate with a delegate token is refused', async function () {
      const res = await coreRequest
        .post(`/${username}/mfa/activate`).set('Authorization', delegateToken).send({});
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'delegation-genuine-login-required');
    });

    it('[MA16B] mfa.deactivate with a delegate token is refused and the owner MFA stays active', async function () {
      const act = await coreRequest
        .post(`/${username}/mfa/activate`).set('Authorization', personalToken).send({});
      assert.strictEqual(act.status, 302);
      const confirm = await coreRequest
        .post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
        .send({ code: await previousStepCodeFor(act.body.secret) });
      assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);

      // Even with the right step-up: the delegate is refused before it is read.
      const res = await coreRequest
        .post(`/${username}/mfa/deactivate`).set('Authorization', delegateToken).send({ password });
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'delegation-genuine-login-required');

      const loginRes = await coreRequest
        .post(`/${username}/auth/login`).set('Origin', 'http://test.pryv.local')
        .send({ username, password, appId: 'pryv-test' });
      assert.strictEqual(loginRes.body.mfaMethod, 'totp', 'the owner MFA is still active');
    });
  });

  // --------------------------------------------------------------------
  // An SMS enrolment made under the legacy SMS mode, then the server runs the
  // shipped multi-method default (TOTP active, SMS not active).
  describe('[MFIN] login of an account whose MFA method is not active on the server', function () {
    const appId = FRESH_APP_ID;
    let warnings, loggerProto, originalWarn;

    beforeEach(async function () {
      warnings = [];
      loggerProto = Object.getPrototypeOf(require('@pryv/boiler').getLogger('methods:auth:mfa'));
      originalWarn = loggerProto.warn;
      loggerProto.warn = function (msg, ...rest) {
        warnings.push(String(msg));
        return originalWarn.call(this, msg, ...rest);
      };
    });
    afterEach(function () {
      loggerProto.warn = originalWarn;
    });

    async function enrolSms (user, token) {
      const restore = injectTestConfigSnapshot(mfaConfig);
      try {
        await _resetMFASingletons();
        nock(SMS_HOST).post('/challenge').reply(200, {});
        nock(SMS_HOST).post('/verify').reply(204);
        const act = await coreRequest.post(`/${user}/mfa/activate`).set('Authorization', token).send({ phone: '+41791234567' });
        assert.strictEqual(act.status, 302, `activate failed: ${JSON.stringify(act.body)}`);
        const confirm = await coreRequest.post(`/${user}/mfa/confirm`).set('Authorization', act.body.mfaToken).send({ code: '1234' });
        assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
      } finally {
        restore();
        await _resetMFASingletons();
      }
    }
    const login = () => loginToApp(username, appId);
    const loginFootprint = () => loginFootprintOf(username, appId);
    const warnedFor = () => warnings.filter((w) => w.includes(`"${username}"`));

    it('[MFIN1] an SMS enrolment while SMS is not active: 403 mfa-method-inactive, no token, no session or access written', async function () {
      await enrolSms(username, personalToken);
      const before = await loginFootprint();
      assert.strictEqual(before.session, null, 'precondition: no session matches this login yet');

      const res = await login();
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'mfa-method-inactive');
      assert.match(res.body.error.message, /\(sms\)/);
      assert.strictEqual(res.body.token, undefined);
      assert.strictEqual(res.body.mfaToken, undefined);
      assert.strictEqual(res.body.apiEndpoint, undefined);

      assert.deepStrictEqual(await loginFootprint(), before, 'the refused login wrote no session and no access');

      // Logged, at most once per user per window.
      const again = await login();
      assert.strictEqual(again.status, 403);
      const refusals = warnedFor().filter((w) => /Login refused/.test(w));
      assert.strictEqual(refusals.length, 1, JSON.stringify(warnedFor()));
      assert.match(refusals[0], /\(sms\)/);
    });

    it('[MFIN2] allowLoginWhenMethodInactive: true restores the password-only login, with a warning at each one', async function () {
      await enrolSms(username, personalToken);
      const restore = injectTestConfigSnapshot({ services: { mfa: { allowLoginWhenMethodInactive: true } } });
      try {
        for (let i = 0; i < 2; i++) {
          const res = await login();
          assert.strictEqual(res.status, 200, JSON.stringify(res.body));
          assert.ok(res.body.token != null, 'a token is released');
          assert.strictEqual(res.body.mfaToken, undefined);
        }
      } finally {
        restore();
      }
      assert.strictEqual(warnedFor().filter((w) => /WITHOUT a second factor/.test(w)).length, 2, JSON.stringify(warnedFor()));
    });

    it('[MFIN3] a TOTP enrolment with TOTP active is still asked for its second factor', async function () {
      const act = await coreRequest.post(`/${username}/mfa/activate`).set('Authorization', personalToken).send({ method: 'totp' });
      assert.strictEqual(act.status, 302, JSON.stringify(act.body));
      const confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
        .send({ code: await previousStepCodeFor(act.body.secret) });
      assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
      const res = await login();
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.mfaMethod, 'totp');
      assert.ok(res.body.mfaToken != null);
      assert.strictEqual(res.body.token, undefined);
    });

    it('[MFIN4] with MFA off server-wide, an SMS-enrolled account logs in with the password (unchanged)', async function () {
      await enrolSms(username, personalToken);
      const restore = injectTestConfigSnapshot({ services: { mfa: { active: false } } });
      try {
        const res = await login();
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(res.body.token != null);
      } finally {
        restore();
      }
    });

    it('[MFIN5] the boot count of SMS enrolments sees SMS enrolments only (PostgreSQL)', async function () {
      const profile = (await storage.getStorageLayer()).profile;
      if (typeof profile.countSmsMfaEnrolments !== 'function') return this.skip(); // not counted on this engine
      const { describeInactiveSmsEnrolments } = require('business/src/mfa/configCheck.ts');
      const n0 = await profile.countSmsMfaEnrolments();

      // A TOTP enrolment is not counted.
      const act = await coreRequest.post(`/${username}/mfa/activate`).set('Authorization', personalToken).send({ method: 'totp' });
      const confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
        .send({ code: await previousStepCodeFor(act.body.secret) });
      assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
      assert.strictEqual(await profile.countSmsMfaEnrolments(), n0);

      // An SMS enrolment is.
      const smsUsername = ('mfa' + cuid.slug()).toLowerCase();
      const smsToken = cuid();
      const smsUser = await fixtures.user(smsUsername, { password });
      await smsUser.access({ type: 'personal', token: smsToken, name: 'pryv-test' });
      await smsUser.session(smsToken);
      await enrolSms(smsUsername, smsToken);
      assert.strictEqual(await profile.countSmsMfaEnrolments(), n0 + 1);

      const message = await describeInactiveSmsEnrolments({ active: true }, () => profile.countSmsMfaEnrolments());
      assert.match(message, /enrolled in SMS MFA.*refused/);
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
          .send({ phone: '+41791234567' });

        assert.strictEqual(res.status, 302);
        assert.ok(res.body.mfaToken != null);
        assert.ok(challengeBody != null, 'SMS challenge should have been sent');
        // The body template {{ phone }} was replaced.
        assert.ok(!challengeBody.to.includes('{{'));
        assert.strictEqual(challengeBody.to, '+41791234567');
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
          .send({ phone: '+41791234567' });

        assert.strictEqual(res.status, 403);
      });

      it('[MA3C] propagates an SMS provider error as 400, without the provider answer, and leaves no pending session', async function () {
        nock(SMS_HOST).post('/challenge').reply(500, { id: 'sms-down', message: 'down' });

        const res = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({ phone: '+41791234567' });

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.data.id, 'mfa-sms-provider-error', JSON.stringify(res.body));
        assert.ok(!JSON.stringify(res.body).includes('sms-down'), JSON.stringify(res.body));
        assert.strictEqual(res.body.mfaToken, undefined);
      });
    });

    // ----- inputs of the SMS provider requests -----------------------
    describe('[MA17] inputs of the SMS provider requests', function () {
      function activate (body) {
        return coreRequest.post(`/${username}/mfa/activate`).set('Authorization', personalToken).send(body);
      }
      function assertMalformed (res) {
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(res.body.error.id, 'invalid-parameters-format', JSON.stringify(res.body));
      }
      /** An enrolment pending confirmation; returns its mfaToken. */
      async function pendingEnrolment () {
        nock(SMS_HOST).post('/challenge').reply(200, {});
        const act = await activate({ phone: '+41791234567' });
        assert.strictEqual(act.status, 302, JSON.stringify(act.body));
        return act.body.mfaToken;
      }
      /** A login pending its second factor; returns its mfaToken. */
      async function pendingLogin () {
        const mfaToken = await pendingEnrolment();
        nock(SMS_HOST).post('/verify').reply(204);
        const confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', mfaToken).send({ code: '1234' });
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        nock(SMS_HOST).post('/challenge').reply(200, {});
        const login = await coreRequest.post(`/${username}/auth/login`).set('Origin', 'http://test.pryv.local')
          .send({ username, password, appId: 'pryv-test' });
        assert.ok(login.body.mfaToken != null, JSON.stringify(login.body));
        return login.body.mfaToken;
      }

      it('[MA17A] a malformed or missing code is refused (400) on confirm and verify, before any provider request', async function () {
        const loginToken = await pendingLogin();
        // A pending enrolment opened after the login (an activation replaces
        // any earlier pending one), over the active enrolment: with a step-up.
        nock(SMS_HOST).post('/challenge').reply(200, {});
        const act = await activate({ phone: '+41791234567', password });
        assert.strictEqual(act.status, 302, JSON.stringify(act.body));
        const enrolToken = act.body.mfaToken;
        const provider = nock(SMS_HOST).post('/verify').reply(204);
        for (const body of [{ code: '12&4' }, { code: '1234"' }, { code: '%0d%0a' }, { code: '1234\r\n' }, { code: '{{ phone }}' }, { code: 1234 }, {}]) {
          assertMalformed(await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', enrolToken).send(body));
          assertMalformed(await coreRequest.post(`/${username}/mfa/verify`).set('Authorization', loginToken).send(body));
        }
        assert.ok(!provider.isDone(), 'no verify request reached the provider');
        // Both sessions are still usable with a well-formed code.
        const verify = await coreRequest.post(`/${username}/mfa/verify`).set('Authorization', loginToken).send({ code: '1234' });
        assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));
      });

      it('[MA17B] only the code of a verify body reaches the provider', async function () {
        const loginToken = await pendingLogin();
        let verifyBody = null;
        nock(SMS_HOST).post('/verify').reply(200, function (_uri, body) { verifyBody = body; return ''; });
        const res = await coreRequest.post(`/${username}/mfa/verify`).set('Authorization', loginToken)
          .send({ code: '1234', phone: '+10000000000', to: 'x' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(verifyBody, { to: '+41791234567', code: '1234' });
      });

      it('[MA17C] the phone must be E.164 and any other enrolment key is refused unless allow-listed', async function () {
        const provider = nock(SMS_HOST).post('/challenge').reply(200, {});
        for (const body of [{ phone: '+1 555 1234567' }, { phone: '41791234567' }, {}, { phone: 41791234567 },
          { phone: '+41791234567', language: 'fr' }, { phone: '+41791234567', language: ['fr'] }]) {
          assertMalformed(await activate(body));
        }
        assert.ok(!provider.isDone(), 'no challenge was sent');
        const ok = await activate({ phone: '+41791234567' });
        assert.strictEqual(ok.status, 302, JSON.stringify(ok.body));
      });

      it('[MA17D] allow-listed values reach the provider encoded (URL, JSON body), within a size cap, never expanded again', async function () {
        const restore = injectTestConfigSnapshot({
          services: {
            mfa: {
              sms: {
                contentKeys: ['note'],
                endpoints: { challenge: { url: SMS_HOST + '/challenge?note={{ note }}', body: '{ "to": "{{ phone }}", "note": "{{ note }}" }' } }
              }
            }
          }
        });
        try {
          await _resetMFASingletons();
          const note = 'a&b"c\r\nd {{ phone }}';
          let seen = null;
          nock(SMS_HOST).post('/challenge').query(true).reply(200, function (uri, body) { seen = { uri, body }; return {}; });
          const res = await activate({ phone: '+41791234567', note });
          assert.strictEqual(res.status, 302, JSON.stringify(res.body));
          assert.ok(seen != null, 'the challenge was sent');
          assert.strictEqual(seen.uri, '/challenge?note=' + encodeURIComponent(note));
          assert.deepStrictEqual(seen.body, { to: '+41791234567', note });
          assertMalformed(await activate({ phone: '+41791234567', note: 'x'.repeat(300) }));
        } finally {
          restore();
        }
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
          .send({ phone: '+41791234567' });
        assert.strictEqual(res.status, 302, `hook mfa.activate failed: ${JSON.stringify(res.body)}`);
        mfaToken = res.body.mfaToken;
      });

      it('[MA4A] verifies the code, persists profile.mfa, returns 10 recovery codes', async function () {
        nock(SMS_HOST).post('/verify').reply(204);

        const res = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', mfaToken)
          .send({ code: '1234' });

        assert.strictEqual(res.status, 200);
        assert.ok(Array.isArray(res.body.recoveryCodes));
        assert.strictEqual(res.body.recoveryCodes.length, 10);
      });

      it('[MA4B] rejects an invalid mfaToken with 401', async function () {
        nock(SMS_HOST).post('/verify').reply(204);

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
        nock(SMS_HOST).post('/verify').reply(204);
        const activateRes = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({ phone: '+41791234567' });
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
        nock(SMS_HOST).post('/verify').reply(204);

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
        nock(SMS_HOST).post('/verify').reply(204);
        const activateRes = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({ phone: '+41791234567' });
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
          .send({ password });
        assert.strictEqual(deactivateRes.status, 200, `mfa.deactivate failed: ${JSON.stringify(deactivateRes.body)}`);

        const loginRes = await coreRequest
          .post(`/${username}/auth/login`)
          .set('Origin', 'http://test.pryv.local')
          .send({ username, password, appId: 'pryv-test' });

        assert.strictEqual(loginRes.status, 200);
        assert.ok(loginRes.body.token != null);
        assert.ok(loginRes.body.mfaToken == null);
      });

      it('[MA6B] an SMS enrolment steps up with the password only: a code is refused', async function () {
        // No SMS is sent for a step-up, so no SMS code can be valid for it.
        const res = await coreRequest
          .post(`/${username}/mfa/deactivate`)
          .set('Authorization', personalToken)
          .send({ code: '1234' });
        assert.strictEqual(res.status, 403, JSON.stringify(res.body));
        assert.strictEqual(res.body.error.id, 'invalid-step-up');
        nock(SMS_HOST).post('/challenge').reply(200, {});
        const loginRes = await coreRequest
          .post(`/${username}/auth/login`)
          .set('Origin', 'http://test.pryv.local')
          .send({ username, password, appId: 'pryv-test' });
        assert.ok(loginRes.body.mfaToken != null, 'MFA is still active');
      });

      it('[MA6C] replacing an SMS enrolment needs the step-up, which never becomes enrolment content', async function () {
        const refused = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({ phone: '+41791111111' });
        assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
        assert.strictEqual(refused.body.error.data.id, 'step-up-required');

        let challengeBody = null;
        nock(SMS_HOST).post('/challenge').reply(200, function (_uri, body) { challengeBody = body; return {}; });
        nock(SMS_HOST).post('/verify').reply(204);
        const act = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({ phone: '+41791111111', password });
        assert.strictEqual(act.status, 302, JSON.stringify(act.body));
        assert.ok(!JSON.stringify(challengeBody).includes(password), 'the password must not reach the SMS provider');
        const confirm = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', act.body.mfaToken)
          .send({ code: '1234' });
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        const user = await (await getUsersRepository()).getUserByUsername(username);
        const profileStorage = (await storage.getStorageLayer()).profile;
        const item = await new Promise((resolve, reject) =>
          profileStorage.findOne(user, { id: 'private' }, null, (err, res) => err ? reject(err) : resolve(res)));
        assert.deepStrictEqual(item.data.mfa.content, { phone: '+41791111111' });
      });
    });

    // ----- recover ---------------------------------------------------
    describe('[MA7] mfa.recover', function () {
      let recoveryCodes;

      beforeEach(async function () {
        nock(SMS_HOST).post('/challenge').reply(200, {});
        nock(SMS_HOST).post('/verify').reply(204);
        const activateRes = await coreRequest
          .post(`/${username}/mfa/activate`)
          .set('Authorization', personalToken)
          .send({ phone: '+41791234567' });
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

      it('[MA7F] refuses when the body names another account than the path', async function () {
        const otherName = ('mfo' + cuid.slug()).toLowerCase();
        await fixtures.user(otherName, { password: 'mfa-other-pwd-123' });
        const res = await coreRequest
          .post(`/${otherName}/mfa/recover`)
          .send({ username, password, recoveryCode: recoveryCodes[1] });
        assert.strictEqual(res.status, 401, JSON.stringify(res.body));
        assert.strictEqual(res.body.error.id, 'invalid-credentials');
        // The enrolment is untouched: the same code still works on its own path.
        const okRes = await coreRequest
          .post(`/${username}/mfa/recover`)
          .send({ username, password, recoveryCode: recoveryCodes[1] });
        assert.strictEqual(okRes.status, 200, JSON.stringify(okRes.body));
      });
    });
  });

  // --------------------------------------------------------------------
  // Challenge-verify: what makes the provider's answer to a verify a success.
  describe('[MCVP] challenge-verify success predicate', function () {
    let restoreConfig;
    afterEach(function () { if (restoreConfig) restoreConfig(); restoreConfig = null; });

    async function pendingEnrolment (success) {
      const verify = { success };
      restoreConfig = injectTestConfigSnapshot({ services: { mfa: { ...mfaConfig.services.mfa, sms: { ...mfaConfig.services.mfa.sms, endpoints: { ...mfaConfig.services.mfa.sms.endpoints, verify: { ...mfaConfig.services.mfa.sms.endpoints.verify, ...verify } } } } } });
      await _resetMFASingletons();
      nock(SMS_HOST).post('/challenge').reply(200, {});
      const act = await coreRequest.post(`/${username}/mfa/activate`).set('Authorization', personalToken).send({ phone: '+41791234567' });
      assert.strictEqual(act.status, 302, JSON.stringify(act.body));
      return act.body.mfaToken;
    }
    const confirm = (mfaToken) => coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', mfaToken).send({ code: '123456' });
    function assertInvalidCode (res) {
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.data.id, 'invalid-mfa-code', JSON.stringify(res.body));
    }

    it('[MCVP1] with { jsonPath: status, equals: approved }: "pending" is refused, "approved" accepted', async function () {
      const mfaToken = await pendingEnrolment({ jsonPath: 'status', equals: 'approved' });
      nock(SMS_HOST).post('/verify').reply(200, { status: 'pending' });
      assertInvalidCode(await confirm(mfaToken));
      nock(SMS_HOST).post('/verify').reply(200, { status: 'approved' });
      const ok = await confirm(mfaToken);
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(ok.body.recoveryCodes.length, 10);
    });

    it('[MCVP2] without a predicate: an empty 2xx is accepted, a 2xx with a body is refused', async function () {
      const mfaToken = await pendingEnrolment();
      nock(SMS_HOST).post('/verify').reply(200, { status: 'approved' });
      assertInvalidCode(await confirm(mfaToken));
      nock(SMS_HOST).post('/verify').reply(200, '');
      const ok = await confirm(mfaToken);
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });
  });

  // --------------------------------------------------------------------
  // SMS single mode: the core generates the code, the provider delivers it.
  describe('[MSMS] SMS single mode', function () {
    let restoreConfig;
    let sends;

    function singleConfig (sms = {}) {
      return {
        services: {
          mfa: {
            active: true,
            defaultMethod: 'sms',
            methods: {
              totp: { active: true, secretsKey: TOTP_SECRETS_KEY },
              sms: {
                active: true,
                mode: 'single',
                endpoints: {
                  single: {
                    url: SMS_HOST + '/send',
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: '{ "to": "{{ phone }}", "text": "Your code: {{ code }}" }'
                  }
                },
                ...sms,
                sendLimits: { minIntervalSeconds: 0, perUserPerHour: 100, perDestinationPerDay: 100, ...sms.sendLimits }
              }
            },
            sessions: { ttlSeconds: 1800 }
          }
        }
      };
    }
    async function setUp (sms) {
      restoreConfig = injectTestConfigSnapshot(singleConfig(sms));
      await _resetMFASingletons();
    }
    beforeEach(function () {
      sends = [];
      nock(SMS_HOST).post('/send').times(50).reply(200, (_uri, body) => { sends.push(body); return ''; });
    });
    afterEach(function () { if (restoreConfig) restoreConfig(); restoreConfig = null; });

    const codeOf = (send) => /^Your code: ([0-9]+)$/.exec(send.text)[1];
    const lastCode = () => codeOf(sends[sends.length - 1]);
    function activate (user = username, token = personalToken, phone = '+41791234567') {
      return coreRequest.post(`/${user}/mfa/activate`).set('Authorization', token).send({ method: 'sms', phone });
    }
    function confirm (mfaToken, code) {
      return coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', mfaToken).send({ code });
    }
    function login (user = username) {
      return coreRequest.post(`/${user}/auth/login`).set('Origin', 'http://test.pryv.local')
        .send({ username: user, password, appId: 'pryv-test' });
    }
    function verify (mfaToken, code) {
      return coreRequest.post(`/${username}/mfa/verify`).set('Authorization', mfaToken).send({ code });
    }
    function challenge (mfaToken) {
      return coreRequest.post(`/${username}/mfa/challenge`).set('Authorization', mfaToken).send({});
    }
    async function enrol (user = username, token = personalToken, phone = '+41791234567') {
      const act = await activate(user, token, phone);
      assert.strictEqual(act.status, 302, JSON.stringify(act.body));
      const res = await coreRequest.post(`/${user}/mfa/confirm`).set('Authorization', act.body.mfaToken).send({ code: lastCode() });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    }
    function assertInvalidCode (res) {
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.data.id, 'invalid-mfa-code', JSON.stringify(res.body));
    }
    function assertTooManySends (res) {
      assert.strictEqual(res.status, 429, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'too-many-attempts');
      const seconds = res.body.error.data.retryAfterSeconds;
      assert.ok(Number.isInteger(seconds) && seconds >= 1, `retryAfterSeconds: ${seconds}`);
      assert.strictEqual(res.headers['retry-after'], String(seconds));
      return seconds;
    }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    it('[MSMS1] enrolment and login each send a 6-digit code, accepted on its own session', async function () {
      await setUp();
      await enrol();
      assert.match(sends[0].text, /^Your code: [0-9]{6}$/);
      assert.strictEqual(sends[0].to, '+41791234567');
      const loginRes = await login();
      assert.strictEqual(loginRes.body.mfaMethod, 'sms', JSON.stringify(loginRes.body));
      assert.strictEqual(sends.length, 2);
      const enrolCode = codeOf(sends[0]);
      if (enrolCode !== lastCode()) assertInvalidCode(await verify(loginRes.body.mfaToken, enrolCode));
      const ok = await verify(loginRes.body.mfaToken, lastCode());
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.ok(ok.body.token != null);
    });

    it('[MSMS2] a code is refused after its lifetime while its session lives; a new challenge sends one that works', async function () {
      await setUp({ codeTtlSeconds: 1 });
      await enrol();
      const loginRes = await login();
      const expired = lastCode();
      await sleep(1200);
      assertInvalidCode(await verify(loginRes.body.mfaToken, expired));
      const again = await challenge(loginRes.body.mfaToken);
      assert.strictEqual(again.status, 200, JSON.stringify(again.body));
      const ok = await verify(loginRes.body.mfaToken, lastCode());
      assert.strictEqual(ok.status, 200, `the session outlived the code: ${JSON.stringify(ok.body)}`);
    });

    it('[MSMS3] two login sessions get different codes; a code works on its own session only', async function () {
      await setUp({ codeLength: 10 });
      await enrol();
      const a = await login();
      const codeA = lastCode();
      const b = await login();
      const codeB = lastCode();
      assert.match(codeA, /^[0-9]{10}$/);
      assert.notStrictEqual(codeA, codeB);
      assertInvalidCode(await verify(b.body.mfaToken, codeA));
      assert.strictEqual((await verify(b.body.mfaToken, codeB)).status, 200);
      assert.strictEqual((await verify(a.body.mfaToken, codeA)).status, 200);
    });

    it('[MSMS4] a re-challenge replaces the code of the session', async function () {
      await setUp({ codeLength: 10 });
      await enrol();
      const loginRes = await login();
      const first = lastCode();
      const again = await challenge(loginRes.body.mfaToken);
      assert.strictEqual(again.status, 200, JSON.stringify(again.body));
      const second = lastCode();
      assert.notStrictEqual(first, second);
      assertInvalidCode(await verify(loginRes.body.mfaToken, first));
      assert.strictEqual((await verify(loginRes.body.mfaToken, second)).status, 200);
    });

    it('[MSMS5] a second send on one session within the interval answers 429, and sends nothing', async function () {
      await setUp({ sendLimits: { minIntervalSeconds: 30 } });
      await enrol();
      const loginRes = await login();
      assert.ok(loginRes.body.mfaToken != null, JSON.stringify(loginRes.body));
      const count = sends.length;
      const seconds = assertTooManySends(await challenge(loginRes.body.mfaToken));
      assert.ok(seconds <= 30, `retry in ${seconds}`);
      assert.strictEqual(sends.length, count, 'no SMS sent');
      // The pending code is unchanged.
      assert.strictEqual((await verify(loginRes.body.mfaToken, lastCode())).status, 200);
    });

    it('[MSMS6] past the sends per user per hour, a login answers 429 with no token, and sends nothing', async function () {
      await setUp({ sendLimits: { perUserPerHour: 3 } });
      await enrol(); // 1
      assert.ok((await login()).body.mfaToken != null); // 2
      assert.ok((await login()).body.mfaToken != null); // 3
      const refused = await login();
      assertTooManySends(refused);
      assert.strictEqual(refused.body.token, undefined);
      assert.strictEqual(refused.body.mfaToken, undefined);
      assert.strictEqual(sends.length, 3);
    });

    it('[MSMS7] past the sends per destination per day, a send for another user to the same phone answers 429', async function () {
      await setUp({ sendLimits: { perDestinationPerDay: 2 } });
      await enrol(); // 1, to +41791234567
      const other = ('mfa' + cuid.slug()).toLowerCase();
      const otherToken = cuid();
      const otherUser = await fixtures.user(other, { password });
      await otherUser.access({ type: 'personal', token: otherToken, name: 'pryv-test' });
      await otherUser.session(otherToken);
      const act = await activate(other, otherToken); // 2, same phone
      assert.strictEqual(act.status, 302, JSON.stringify(act.body));
      assertTooManySends(await login()); // 3rd send to that phone, first user
      const elsewhere = await activate(other, otherToken, '+41790000000');
      assert.strictEqual(elsewhere.status, 302, `another phone is not held back: ${JSON.stringify(elsewhere.body)}`);
    });

    it('[MSMS8] a new activation invalidates the previous pending enrolment', async function () {
      await setUp();
      const first = await activate();
      assert.strictEqual(first.status, 302, JSON.stringify(first.body));
      const firstCode = lastCode();
      const second = await activate();
      assert.strictEqual(second.status, 302, JSON.stringify(second.body));
      const refused = await confirm(first.body.mfaToken, firstCode);
      assert.strictEqual(refused.status, 401, JSON.stringify(refused.body));
      const ok = await confirm(second.body.mfaToken, lastCode());
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });

    it('[MSMS9] neither the login parameters (password included) nor the challenge parameters reach the MFA method', async function () {
      await setUp();
      await enrol();
      const { SmsMethod } = require('business/src/mfa/index.ts');
      const original = SmsMethod.prototype.challenge;
      const seen = [];
      SmsMethod.prototype.challenge = function (u, profile, clientRequest) {
        seen.push(clientRequest);
        return original.call(this, u, profile, clientRequest);
      };
      try {
        const loginRes = await login();
        assert.ok(loginRes.body.mfaToken != null, JSON.stringify(loginRes.body));
        const again = await challenge(loginRes.body.mfaToken);
        assert.strictEqual(again.status, 200, JSON.stringify(again.body));
      } finally {
        SmsMethod.prototype.challenge = original;
      }
      assert.strictEqual(seen.length, 2);
      for (const clientRequest of seen) {
        assert.ok(!JSON.stringify(clientRequest).includes(password), JSON.stringify(clientRequest));
        assert.deepStrictEqual(clientRequest.body, {});
      }
      assert.ok(sends.every((s) => s.to === '+41791234567'), 'the stored phone, never one from the request');
    });

    function assertEnrolmentChanged (res) {
      assert.strictEqual(res.status, 401, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'invalid-access-token');
      assert.match(res.body.error.message, /enrolment changed since login/);
      assert.strictEqual(res.body.token, undefined);
    }

    it('[MSMS10] once the SMS enrolment is replaced (same phone), a login session is refused by verify and by challenge (401)', async function () {
      await setUp();
      await enrol();
      const a = await login();
      const codeA = lastCode();
      const b = await login();
      assert.ok(a.body.mfaToken != null && b.body.mfaToken != null);
      const act = await coreRequest.post(`/${username}/mfa/activate`).set('Authorization', personalToken)
        .send({ method: 'sms', phone: '+41791234567', password });
      assert.strictEqual(act.status, 302, JSON.stringify(act.body));
      assert.strictEqual((await confirm(act.body.mfaToken, lastCode())).status, 200);
      const sent = sends.length;
      assertEnrolmentChanged(await verify(a.body.mfaToken, codeA));
      assertEnrolmentChanged(await challenge(b.body.mfaToken));
      assert.strictEqual(sends.length, sent, 'nothing sent for the stale session');
    });

    it('[MSMS11] once MFA is turned off, a login session is refused by verify and by challenge (401)', async function () {
      await setUp();
      await enrol();
      const a = await login();
      const codeA = lastCode();
      const b = await login();
      const off = await coreRequest.post(`/${username}/mfa/deactivate`).set('Authorization', personalToken).send({ password });
      assert.strictEqual(off.status, 200, JSON.stringify(off.body));
      assertEnrolmentChanged(await verify(a.body.mfaToken, codeA));
      assertEnrolmentChanged(await challenge(b.body.mfaToken));
    });

    it('[MSMS12] re-sent challenges do not extend a login session past its lifetime', async function () {
      await setUp();
      const restoreTtl = injectTestConfigSnapshot({ services: { mfa: { sessions: { ttlSeconds: 2 } } } });
      try {
        await _resetMFASingletons();
        await enrol();
        const loginRes = await login();
        for (let i = 0; i < 3; i++) {
          await sleep(700);
          const again = await challenge(loginRes.body.mfaToken);
          if (i < 2) assert.strictEqual(again.status, 200, JSON.stringify(again.body));
        }
        // 2.1 s after the login: the session is over, whatever was sent since.
        const late = await verify(loginRes.body.mfaToken, lastCode());
        assert.strictEqual(late.status, 401, `the session outlived its lifetime: ${JSON.stringify(late.body)}`);
        assert.strictEqual(late.body.token, undefined);
      } finally {
        restoreTtl();
      }
    });

    /** From now on the SMS provider answers 500 (once). */
    function failNextSend () {
      nock.cleanAll();
      nock(SMS_HOST).post('/send').reply(500, '');
    }

    it('[MSMS13] a login refused by a failing provider or by the send limits writes no session and no access', async function () {
      await setUp({ sendLimits: { perUserPerHour: 2 } });
      await enrol(); // 1
      const before = await loginFootprintOf(username, FRESH_APP_ID);
      assert.strictEqual(before.session, null, 'precondition: no session matches this login yet');

      failNextSend();
      const failed = await loginToApp(username, FRESH_APP_ID); // 2, counted: it reached the provider
      assert.strictEqual(failed.status, 400, JSON.stringify(failed.body));
      assert.strictEqual(failed.body.error.data.id, 'mfa-sms-provider-error', JSON.stringify(failed.body));
      assert.deepStrictEqual(await loginFootprintOf(username, FRESH_APP_ID), before, 'the failed login wrote no session and no access');

      const refused = await loginToApp(username, FRESH_APP_ID);
      assertTooManySends(refused);
      assert.strictEqual(refused.body.token, undefined);
      assert.strictEqual(refused.body.mfaToken, undefined);
      assert.deepStrictEqual(await loginFootprintOf(username, FRESH_APP_ID), before, 'the refused login wrote no session and no access');

      // The tokens the account already had are untouched.
      const who = await coreRequest.get(`/${username}/access-info`).set('Authorization', personalToken);
      assert.strictEqual(who.status, 200, JSON.stringify(who.body));
    });

    it('[MSMS14] an activation that loses the enrolment slot to concurrent ones answers 429 and sends nothing', async function () {
      await setUp();
      const store = getMFASessionStore(singleConfig().services.mfa);
      const kv = store.kv;
      const originalSet = kv.set;
      // Every compare-and-set on the slot loses, as under concurrent activations.
      kv.set = function (key, ...rest) {
        return key.startsWith(store.enrolSlotNamespace) ? Promise.resolve(false) : originalSet.call(this, key, ...rest);
      };
      let res;
      try {
        res = await activate();
      } finally {
        kv.set = originalSet;
      }
      assert.strictEqual(res.status, 429, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.id, 'too-many-attempts');
      assert.strictEqual(res.body.mfaToken, undefined);
      assert.strictEqual(sends.length, 0, 'no SMS sent');
    });

    it('[MSMS15] an activation refused by a failing provider or by the send limits leaves the earlier pending enrolment usable', async function () {
      await setUp({ sendLimits: { perUserPerHour: 2 } });
      const first = await activate(); // 1
      assert.strictEqual(first.status, 302, JSON.stringify(first.body));
      const firstCode = lastCode();

      failNextSend();
      const failed = await activate(); // 2
      assert.strictEqual(failed.status, 400, JSON.stringify(failed.body));
      assert.strictEqual(failed.body.error.data.id, 'mfa-sms-provider-error', JSON.stringify(failed.body));
      assertTooManySends(await activate());

      const ok = await confirm(first.body.mfaToken, firstCode);
      assert.strictEqual(ok.status, 200, `the earlier enrolment was dropped: ${JSON.stringify(ok.body)}`);
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
    /** The stored private profile of the test user, read straight from storage. */
    async function storedProfile () {
      const user = await (await getUsersRepository()).getUserByUsername(username);
      const profile = (await storage.getStorageLayer()).profile;
      const item = await new Promise((resolve, reject) =>
        profile.findOne(user, { id: 'private' }, null, (err, res) => err ? reject(err) : resolve(res)));
      return { user, profile, data: item?.data };
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

      it('[MA10F] a second activation invalidates the first pending enrolment', async function () {
        const first = await activateTotp();
        const second = await activateTotp();
        assert.strictEqual(second.status, 302, JSON.stringify(second.body));
        const refused = await coreRequest
          .post(`/${username}/mfa/confirm`).set('Authorization', first.body.mfaToken)
          .send({ code: totpCodeFor(first.body.secret, 0) });
        assert.strictEqual(refused.status, 401, JSON.stringify(refused.body));
        const ok = await coreRequest
          .post(`/${username}/mfa/confirm`).set('Authorization', second.body.mfaToken)
          .send({ code: totpCodeFor(second.body.secret, 0) });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
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
          .send({ code: await previousStepCodeFor(secret) });
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
        // The per-session ceiling alone: with the default backoff (3 free
        // failures) the 5th attempt would already be delayed (see [MA12D]).
        const restore = injectTestConfigSnapshot({
          services: { mfa: { ...totpTestConfig.services.mfa, attempts: { backoff: { maxSeconds: 0 } } } }
        });
        try {
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
        } finally {
          restore();
        }
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

      it('[MA11H] the same code verified concurrently on two sessions releases exactly one token', async function () {
        // Both requests pass the replay pre-check at the same time (neither has
        // consumed the step yet); only the storage-level compare-and-set can
        // keep the second one out.
        const a = await login();
        const b = await login();
        const code = totpCodeFor(secret, 0);
        const [vA, vB] = await Promise.all([
          coreRequest.post(`/${username}/mfa/verify`).set('Authorization', a.body.mfaToken).send({ code }),
          coreRequest.post(`/${username}/mfa/verify`).set('Authorization', b.body.mfaToken).send({ code })
        ]);
        const statuses = [vA.status, vB.status].sort();
        assert.deepStrictEqual(statuses, [200, 400], `exactly one verify may succeed: ${JSON.stringify([vA.body, vB.body])}`);
        // The loser is answered exactly like a wrong code.
        const loser = vA.status === 400 ? vA : vB;
        assert.strictEqual(loser.body.error.data.id, 'invalid-mfa-code');
        assert.strictEqual(loser.body.error.message, 'The provided MFA code is invalid.');
      });

      it('[MA11I] once a later step is consumed, an earlier in-drift code is refused', async function () {
        const later = await login();
        // Step and code from the same instant, so a step boundary between two
        // clock reads cannot make them disagree.
        const nowSec = Math.floor(Date.now() / 1000);
        const laterStep = Math.floor(nowSec / 30) + 1;
        const laterCode = totpCode(base32Decode(secret), { time: nowSec + 30, periodSeconds: 30, digits: 6 });
        const vLater = await coreRequest
          .post(`/${username}/mfa/verify`).set('Authorization', later.body.mfaToken).send({ code: laterCode });
        assert.strictEqual(vLater.status, 200, `a code one step ahead is inside the drift window: ${JSON.stringify(vLater.body)}`);
        const earlier = await login();
        const vEarlier = await coreRequest
          .post(`/${username}/mfa/verify`).set('Authorization', earlier.body.mfaToken).send({ code: totpCodeFor(secret, 0) });
        assert.strictEqual(vEarlier.status, 400, 'the stored step must never move backwards');
        const { data } = await storedProfile();
        assert.strictEqual(data.mfa.totp.lastUsedStep, laterStep, 'the consumed later step stays stored');
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
          .send({ password });
        assert.strictEqual(deactivate.status, 200);

        const loginRes = await login();
        assert.ok(loginRes.body.token != null);
        assert.ok(loginRes.body.mfaToken == null);
      });
    });

    // ------------------------------------------------------------------
    // Step-up: turning MFA off, or replacing an active enrolment, needs the
    // account password or a code of the current factor on top of the
    // personal token.
    // ------------------------------------------------------------------
    describe('[MSU] step-up on deactivate and on replacing an enrolment', function () {
      let secret;

      /** Enrol TOTP, leaving the current step's code unused. */
      async function enrol () {
        const act = await activateTotp();
        assert.strictEqual(act.status, 302, `activate failed: ${JSON.stringify(act.body)}`);
        secret = act.body.secret;
        const confirm = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', act.body.mfaToken)
          .send({ code: await previousStepCodeFor(secret) });
        assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
        return confirm.body;
      }
      function deactivate (body) {
        return coreRequest.post(`/${username}/mfa/deactivate`).set('Authorization', personalToken).send(body);
      }
      function activateWith (body) {
        return coreRequest.post(`/${username}/mfa/activate`).set('Authorization', personalToken).send({ method: 'totp', ...body });
      }
      async function assertMfaStillActive () {
        const loginRes = await login();
        assert.strictEqual(loginRes.status, 200);
        assert.strictEqual(loginRes.body.mfaMethod, 'totp', `MFA must still be active: ${JSON.stringify(loginRes.body)}`);
        const { data } = await storedProfile();
        return data.mfa;
      }
      function assertStepUpMissing (res) {
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(res.body.error.id, 'invalid-parameters-format');
        assert.strictEqual(res.body.error.data.id, 'step-up-required');
      }
      function assertWrongStepUp (res) {
        assert.strictEqual(res.status, 403, JSON.stringify(res.body));
        assert.strictEqual(res.body.error.id, 'invalid-step-up');
      }

      it('[MSU1] deactivate without a step-up is refused (400) and MFA stays active', async function () {
        await enrol();
        assertStepUpMissing(await deactivate({}));
        await assertMfaStillActive();
      });

      it('[MSU2] deactivate with a wrong password is refused (403 invalid-step-up) and MFA stays active', async function () {
        await enrol();
        assertWrongStepUp(await deactivate({ password: 'not-the-password' }));
        await assertMfaStillActive();
      });

      it('[MSU3] deactivate with the account password turns MFA off', async function () {
        await enrol();
        const res = await deactivate({ password });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const loginRes = await login();
        assert.ok(loginRes.body.token != null && loginRes.body.mfaToken == null, 'login is direct again');
      });

      it('[MSU4] deactivate with a current TOTP code turns MFA off; a wrong code is refused', async function () {
        await enrol();
        assertWrongStepUp(await deactivate({ code: '000000' }));
        await assertMfaStillActive();
        const res = await deactivate({ code: totpCodeFor(secret, 0) });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const loginRes = await login();
        assert.ok(loginRes.body.token != null && loginRes.body.mfaToken == null, 'login is direct again');
      });

      it('[MSU5] a TOTP code used for a step-up is consumed: it cannot step up again, nor log in', async function () {
        await enrol();
        const code = totpCodeFor(secret, 0);
        // Re-activation over the active enrolment, stepped up with the code.
        const act = await activateWith({ code });
        assert.strictEqual(act.status, 302, JSON.stringify(act.body));
        // The enrolment is unchanged until that activation is confirmed.
        const mfa = await assertMfaStillActive();
        assert.ok(mfa.totp.lastUsedStep >= Math.floor(Date.now() / 1000 / 30) - 1, 'the step was consumed');
        assertWrongStepUp(await deactivate({ code }));
        const loginRes = await login();
        const verify = await coreRequest
          .post(`/${username}/mfa/verify`).set('Authorization', loginRes.body.mfaToken).send({ code });
        assert.strictEqual(verify.status, 400, 'the code cannot be replayed at login either');
      });

      it('[MSU6] activate over an active enrolment without a step-up, or with a wrong one, leaves it unchanged', async function () {
        await enrol();
        const before = (await storedProfile()).data.mfa;
        const none = await activateWith({});
        assertStepUpMissing(none);
        assert.strictEqual(none.body.mfaToken, undefined);
        assertWrongStepUp(await activateWith({ password: 'not-the-password' }));
        const after = await assertMfaStillActive();
        assert.strictEqual(after.totp.secret, before.totp.secret, 'the enrolment is unchanged');
        assert.deepStrictEqual(after.recoveryCodes, before.recoveryCodes);
      });

      it('[MSU7] activate over an active enrolment with the password replaces it once confirmed', async function () {
        await enrol();
        const oldSecret = secret;
        const act = await activateWith({ password });
        assert.strictEqual(act.status, 302, JSON.stringify(act.body));
        assert.notStrictEqual(act.body.secret, oldSecret);
        const confirm = await coreRequest
          .post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
          .send({ code: totpCodeFor(act.body.secret, 0) });
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        const loginRes = await login();
        const oldCode = await coreRequest
          .post(`/${username}/mfa/verify`).set('Authorization', loginRes.body.mfaToken).send({ code: totpCodeFor(oldSecret, 0) });
        assert.strictEqual(oldCode.status, 400, 'the replaced factor no longer works');
      });

      it('[MSU8] a first enrolment needs no step-up', async function () {
        const act = await activateWith({});
        assert.strictEqual(act.status, 302, JSON.stringify(act.body));
        const confirm = await coreRequest
          .post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
          .send({ code: totpCodeFor(act.body.secret, 0) });
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
      });

      it('[MSU9] an activation started with no enrolment cannot be confirmed over one enrolled meanwhile', async function () {
        // Started while the account had no MFA, so no step-up was asked...
        const early = await activateWith({});
        assert.strictEqual(early.status, 302);
        // ...then an enrolment is made on another session, whose activation
        // also invalidates the earlier pending one.
        await enrol();
        const before = (await storedProfile()).data.mfa;
        const confirm = await coreRequest
          .post(`/${username}/mfa/confirm`).set('Authorization', early.body.mfaToken)
          .send({ code: totpCodeFor(early.body.secret, 0) });
        assert.strictEqual(confirm.status, 401, JSON.stringify(confirm.body));
        assert.strictEqual(confirm.body.error.id, 'invalid-access-token');
        const after = await assertMfaStillActive();
        assert.strictEqual(after.totp.secret, before.totp.secret, 'the enrolment made meanwhile is kept');
      });

      it('[MSU13] an activation cannot be confirmed over an enrolment written meanwhile by another path', async function () {
        const early = await activateWith({});
        assert.strictEqual(early.status, 302);
        // An enrolment that did not go through mfa.activate on this core
        // (e.g. restored), so it did not invalidate the pending activation.
        const { user, profile, data } = await storedProfile();
        const enrolled = { data: { mfa: { content: { phone: '+41791234567' }, recoveryCodes: ['restored'] } } };
        await new Promise((resolve, reject) => {
          const cb = (err) => err ? reject(err) : resolve();
          if (data == null) profile.insertOne(user, { id: 'private', ...enrolled }, cb);
          else profile.updateOne(user, { id: 'private' }, enrolled, cb);
        });
        const confirm = await coreRequest
          .post(`/${username}/mfa/confirm`).set('Authorization', early.body.mfaToken)
          .send({ code: totpCodeFor(early.body.secret, 0) });
        assert.strictEqual(confirm.status, 400, JSON.stringify(confirm.body));
        assert.strictEqual(confirm.body.error.id, 'invalid-operation');
        assert.deepStrictEqual((await storedProfile()).data.mfa.recoveryCodes, ['restored'], 'the enrolment written meanwhile is kept');
      });

      it('[MSU10] both a password and a code, or a non-string, are refused as malformed', async function () {
        await enrol();
        assertStepUpMissing(await deactivate({ password, code: totpCodeFor(secret, 0) }));
        const notString = await deactivate({ password: 12345 });
        assert.strictEqual(notString.status, 400, JSON.stringify(notString.body));
        assert.strictEqual(notString.body.error.id, 'invalid-parameters-format', JSON.stringify(notString.body));
        // Refused by the deactivate params schema (`password` is typed there), before any step-up check.
        assert.ok(Array.isArray(notString.body.error.data) &&
          notString.body.error.data.some((e) => e.path === '#/password' && e.code === 'INVALID_TYPE'), JSON.stringify(notString.body));
        assertStepUpMissing(await activateWith({ password: 12345 }));
        assertStepUpMissing(await activateWith({ password: { $ne: '' } }));
        await assertMfaStillActive();
      });

      it('[MSU11] wrong step-ups count on the account tally: past the free failures the next one is delayed, even when right', async function () {
        const restore = injectTestConfigSnapshot({
          services: {
            mfa: {
              ...totpTestConfig.services.mfa,
              attempts: { perAccountWindowSeconds: 3600, backoff: { freeFailures: 3, baseSeconds: 60, maxSeconds: 60 } }
            }
          }
        });
        try {
          await enrol();
          for (let i = 0; i < 4; i++) {
            assertWrongStepUp(await deactivate({ password: 'not-the-password-' + i }));
          }
          const delayed = await deactivate({ password });
          assert.strictEqual(delayed.status, 429, JSON.stringify(delayed.body));
          assert.strictEqual(delayed.body.error.id, 'too-many-attempts');
          const mfa = await assertMfaStillActive();
          assert.ok(mfa != null, 'not checked during the delay, so nothing changed');
          const { data } = await storedProfile();
          assert.strictEqual(data.mfaThrottle.failures, 4, 'each wrong step-up counted, the delayed one did not');
        } finally {
          restore();
        }
      });

      it('[MSU12] services.mfa.stepUp.required: false lets a personal token alone turn MFA off or replace it', async function () {
        await enrol();
        const restore = injectTestConfigSnapshot({
          services: { mfa: { ...totpTestConfig.services.mfa, stepUp: { required: false } } }
        });
        try {
          const replace = await activateWith({});
          assert.strictEqual(replace.status, 302, JSON.stringify(replace.body));
          const res = await deactivate({});
          assert.strictEqual(res.status, 200, JSON.stringify(res.body));
          const loginRes = await login();
          assert.ok(loginRes.body.token != null && loginRes.body.mfaToken == null, 'login is direct again');
        } finally {
          restore();
        }
      });
    });

    // ------------------------------------------------------------------
    // E-mail notice of an MFA change. Off in the test configuration
    // (services.email.enabled.mfaChange: false); switched on here against
    // the Mandrill double the other mail tests use.
    // ------------------------------------------------------------------
    describe('[MSN] e-mail notice of an MFA change', function () {
      const MANDRILL = 'https://mandrillapp.local';
      const MANDRILL_PATH = '/api/1.0/messages/send-template.json';
      let restoreMail;
      let email;

      beforeEach(async function () {
        restoreMail = injectTestConfigSnapshot({ services: { email: { enabled: { mfaChange: true } } } });
        await _resetMFASingletons();
        // A user of its own, with a known address.
        username = ('mfn' + cuid.slug()).toLowerCase();
        email = username + '@notice.example.com';
        personalToken = cuid();
        fixtureUser = await fixtures.user(username, { password, email, language: 'en' });
        await fixtureUser.access({ type: 'personal', token: personalToken, name: 'pryv-test' });
        await fixtureUser.session(personalToken);
      });
      afterEach(function () { restoreMail(); });

      /** Capture every Mandrill send; `status` is what the double answers. */
      function captureMails (status = 200) {
        const captured = [];
        nock(MANDRILL).post(MANDRILL_PATH).times(10)
          .reply(status, (uri, body) => { captured.push(body); return {}; });
        return captured;
      }
      const vars = (mail) => Object.fromEntries(mail.message.global_merge_vars.map((v) => [v.name, v.content]));
      async function waitForMails (captured, n) {
        return await pollUntil(async () => captured.length, (len) => len >= n, { timeoutMs: 3000 });
      }

      it('[MSN1] enrol, replace, deactivate and recover each send a notice naming the change', async function () {
        const captured = captureMails();
        // Enrol.
        let act = await activateTotp();
        let confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
          .send({ code: await previousStepCodeFor(act.body.secret) });
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        await waitForMails(captured, 1);
        // Replace.
        act = await coreRequest.post(`/${username}/mfa/activate`).set('Authorization', personalToken)
          .send({ method: 'totp', password });
        assert.strictEqual(act.status, 302, JSON.stringify(act.body));
        confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
          .send({ code: await previousStepCodeFor(act.body.secret) });
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        await waitForMails(captured, 2);
        // Recover, then enrol again (a 3rd notice) and deactivate.
        const recover = await coreRequest.post(`/${username}/mfa/recover`)
          .send({ username, password, recoveryCode: confirm.body.recoveryCodes[0] });
        assert.strictEqual(recover.status, 200, JSON.stringify(recover.body));
        await waitForMails(captured, 3);
        act = await activateTotp();
        confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
          .send({ code: await previousStepCodeFor(act.body.secret) });
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        await waitForMails(captured, 4);
        const off = await coreRequest.post(`/${username}/mfa/deactivate`).set('Authorization', personalToken).send({ password });
        assert.strictEqual(off.status, 200, JSON.stringify(off.body));
        await waitForMails(captured, 5);

        assert.deepStrictEqual(captured.map((m) => vars(m).MFA_CHANGE), ['enrolled', 'replaced', 'recovered', 'enrolled', 'deactivated']);
        for (const mail of captured) {
          assert.strictEqual(mail.template_name, 'mfa-change');
          assert.deepStrictEqual(mail.message.to.map((t) => t.email), [email]);
          const v = vars(mail);
          assert.strictEqual(v.USERNAME, username);
          // Exactly one flag is set, the one of the change.
          const flags = ['MFA_ENROLLED', 'MFA_REPLACED', 'MFA_DEACTIVATED', 'MFA_RECOVERED'].filter((k) => v[k] === 'true');
          assert.deepStrictEqual(flags, ['MFA_' + v.MFA_CHANGE.toUpperCase()]);
        }
      });

      it('[MSN2] a mail delivery failure never fails the MFA call', async function () {
        const captured = captureMails(500);
        const act = await activateTotp();
        const confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
          .send({ code: await previousStepCodeFor(act.body.secret) });
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        const off = await coreRequest.post(`/${username}/mfa/deactivate`).set('Authorization', personalToken).send({ password });
        assert.strictEqual(off.status, 200, JSON.stringify(off.body));
        await waitForMails(captured, 2);
        assert.strictEqual(captured.length, 2, 'both notices were attempted');
        const loginRes = await login();
        assert.ok(loginRes.body.token != null && loginRes.body.mfaToken == null, 'MFA is off despite the failed notice');
      });

      it('[MSN3] no notice when deactivate finds no active enrolment, nor when the class is switched off', async function () {
        const captured = captureMails();
        const off = await coreRequest.post(`/${username}/mfa/deactivate`).set('Authorization', personalToken).send({ password });
        assert.strictEqual(off.status, 200, JSON.stringify(off.body));
        const restore = injectTestConfigSnapshot({ services: { email: { enabled: { mfaChange: false } } } });
        try {
          const act = await activateTotp();
          const confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
            .send({ code: await previousStepCodeFor(act.body.secret) });
          assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        } finally {
          restore();
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.strictEqual(captured.length, 0, JSON.stringify(captured));
      });

      // mfa.recover and system.deactivateMfa are audited without a user (no
      // access of the account), so they leave a row in the account's trail.
      async function auditRows () {
        const res = await coreRequest.get(`/${username}/events`).set('Authorization', personalToken)
          .query({ streams: [':_audit:'], limit: 200 });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        return res.body.events ?? [];
      }
      async function enrolTotp () {
        const act = await activateTotp();
        assert.strictEqual(act.status, 302, JSON.stringify(act.body));
        const confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
          .send({ code: await previousStepCodeFor(act.body.secret) });
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        return confirm.body.recoveryCodes;
      }

      /** The admin reset, through the system API (wired by the standalone
       *  server, not by initCore: registered here on the app coreRequest uses). */
      async function adminDeactivateMfa () {
        const app = global.app;
        await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
        const adminKey = (await getConfig()).get('auth:adminAccessKey');
        return await coreRequest.delete(`/system/users/${username}/mfa`).set('Authorization', adminKey);
      }

      it('[MAUD1] mfa.recover leaves an mfa.recovered row in the account audit trail', async function () {
        captureMails();
        const recoveryCodes = await enrolTotp();
        const recover = await coreRequest.post(`/${username}/mfa/recover`)
          .send({ username, password, recoveryCode: recoveryCodes[0] });
        assert.strictEqual(recover.status, 200, JSON.stringify(recover.body));
        const row = (await auditRows()).find((e) => e.content?.action === 'mfa.recovered');
        assert.ok(row != null, 'no mfa.recovered row');
        assert.deepStrictEqual(row.content.record, { method: 'totp' });
      });

      it('[MAUD2] system.deactivateMfa leaves an mfa.deactivatedByAdmin row and sends a notice saying an administrator did it', async function () {
        const captured = captureMails();
        await enrolTotp();
        await waitForMails(captured, 1);
        const res = await adminDeactivateMfa();
        assert.strictEqual(res.status, 204, JSON.stringify(res.body));
        await waitForMails(captured, 2);
        assert.strictEqual(captured.length, 2, 'the reset sent its notice');
        const v = vars(captured[1]);
        assert.strictEqual(v.MFA_CHANGE, 'deactivatedByAdmin');
        assert.strictEqual(v.MFA_DEACTIVATED_BY_ADMIN, 'true');
        assert.strictEqual(v.MFA_DEACTIVATED, '');
        assert.deepStrictEqual(captured[1].message.to.map((t) => t.email), [email]);
        const row = (await auditRows()).find((e) => e.content?.action === 'mfa.deactivatedByAdmin');
        assert.ok(row != null, 'no mfa.deactivatedByAdmin row');
        assert.deepStrictEqual(row.content.record, { enrolled: true, method: 'totp' });
        const loginRes = await login();
        assert.ok(loginRes.body.token != null && loginRes.body.mfaToken == null, 'MFA is off');
      });

      it('[MAUD3] system.deactivateMfa on an account without MFA: an audit row, no notice', async function () {
        const captured = captureMails();
        const res = await adminDeactivateMfa();
        assert.strictEqual(res.status, 204, JSON.stringify(res.body));
        const row = (await auditRows()).find((e) => e.content?.action === 'mfa.deactivatedByAdmin');
        assert.ok(row != null, 'no mfa.deactivatedByAdmin row');
        assert.deepStrictEqual(row.content.record, { enrolled: false });
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.strictEqual(captured.length, 0, JSON.stringify(captured));
      });
    });

    // ------------------------------------------------------------------
    // The pending MFA sessions are held in memory: their number is capped.
    // ------------------------------------------------------------------
    describe('[MCAP] cap on pending MFA sessions', function () {
      let restoreCap;
      beforeEach(async function () {
        restoreCap = injectTestConfigSnapshot({ services: { mfa: { sessions: { maxPending: 2 } } } });
        await _resetMFASingletons();
      });
      afterEach(function () {
        restoreCap();
      });

      it('[MCAP1] past maxPending sessions a login and an activation answer 429; a completed session frees a place', async function () {
        const act = await activateTotp();
        const secret = act.body.secret;
        const confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
          .send({ code: await previousStepCodeFor(secret) });
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        // The enrolment slot of that activation is still held: it does not count.
        const a = await login();
        assert.ok(a.body.mfaToken != null, JSON.stringify(a.body));
        const b = await login();
        assert.ok(b.body.mfaToken != null, JSON.stringify(b.body));
        const refused = await login();
        assert.strictEqual(refused.status, 429, JSON.stringify(refused.body));
        assert.strictEqual(refused.body.error.id, 'too-many-requests');
        assert.strictEqual(refused.headers['retry-after'], '60');
        assert.strictEqual(refused.body.token, undefined);
        assert.strictEqual(refused.body.mfaToken, undefined);
        const replace = await coreRequest.post(`/${username}/mfa/activate`).set('Authorization', personalToken)
          .send({ method: 'totp', password });
        assert.strictEqual(replace.status, 429, JSON.stringify(replace.body));
        // Completing one session gives its place back.
        const ok = await coreRequest.post(`/${username}/mfa/verify`).set('Authorization', a.body.mfaToken)
          .send({ code: totpCodeFor(secret, 0) });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        const again = await login();
        assert.ok(again.body.mfaToken != null, JSON.stringify(again.body));
      });

      it('[MCAP2] a login refused at the cap writes no session and no access', async function () {
        const act = await activateTotp();
        const confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
          .send({ code: await previousStepCodeFor(act.body.secret) });
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        assert.ok((await login()).body.mfaToken != null);
        assert.ok((await login()).body.mfaToken != null);
        const before = await loginFootprintOf(username, FRESH_APP_ID);
        assert.strictEqual(before.session, null, 'precondition: no session matches this login yet');
        const refused = await loginToApp(username, FRESH_APP_ID);
        assert.strictEqual(refused.status, 429, JSON.stringify(refused.body));
        assert.strictEqual(refused.body.error.id, 'too-many-requests');
        assert.deepStrictEqual(await loginFootprintOf(username, FRESH_APP_ID), before, 'the refused login wrote no session and no access');
      });
    });

    // ------------------------------------------------------------------
    // An MFA session acts only under the path of its own account.
    // ------------------------------------------------------------------
    describe('[MPUS] the MFA session belongs to the account of the request path', function () {
      let other;
      beforeEach(async function () {
        other = ('mfo' + cuid.slug()).toLowerCase();
        await fixtures.user(other, { password });
      });
      function assertUnknownToken (res) {
        assert.strictEqual(res.status, 401, JSON.stringify(res.body));
        assert.strictEqual(res.body.error.id, 'invalid-access-token');
        assert.strictEqual(res.body.token, undefined);
        assert.strictEqual(res.body.recoveryCodes, undefined);
      }

      it('[MPUS1] a login token used under another account path is refused by challenge and verify, and works under its own', async function () {
        const act = await activateTotp();
        const secret = act.body.secret;
        const confirm = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken)
          .send({ code: await previousStepCodeFor(secret) });
        assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
        const mfaToken = (await login()).body.mfaToken;
        assert.ok(mfaToken != null);
        const code = totpCodeFor(secret, 0);
        assertUnknownToken(await coreRequest.post(`/${other}/mfa/challenge`).set('Authorization', mfaToken).send({}));
        assertUnknownToken(await coreRequest.post(`/${other}/mfa/verify`).set('Authorization', mfaToken).send({ code }));
        const ok = await coreRequest.post(`/${username}/mfa/verify`).set('Authorization', mfaToken).send({ code });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.ok(ok.body.token != null);
      });

      it('[MPUS2] an enrolment token used under another account path is refused by confirm and challenge, and works under its own', async function () {
        const act = await activateTotp();
        const code = totpCodeFor(act.body.secret, 0);
        assertUnknownToken(await coreRequest.post(`/${other}/mfa/confirm`).set('Authorization', act.body.mfaToken).send({ code }));
        assertUnknownToken(await coreRequest.post(`/${other}/mfa/challenge`).set('Authorization', act.body.mfaToken).send({}));
        const ok = await coreRequest.post(`/${username}/mfa/confirm`).set('Authorization', act.body.mfaToken).send({ code });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        assert.strictEqual(ok.body.recoveryCodes.length, 10);
      });
    });

    // ------------------------------------------------------------------
    // Per-account backoff. The per-session ceiling alone is not a limit:
    // re-authenticating used to hand out a fresh budget, so N logins bought 5N
    // guesses. Failures therefore accrue per account, and past the free ones
    // each failure delays the NEXT attempt. It is a delay, never a lockout: a
    // caller holding the password must not be able to lock the real user out.
    // ------------------------------------------------------------------
    describe('[MA12] per-account backoff', function () {
      const PER_SESSION = 5;
      const FREE = 3;
      let restoreAttempts;
      let secret;

      function withAttempts (attempts = {}, backoff = {}) {
        return {
          services: {
            mfa: {
              ...totpTestConfig.services.mfa,
              attempts: {
                perSession: PER_SESSION,
                // Long enough that the window cannot lapse part-way through a
                // test on a slow run.
                perAccountWindowSeconds: 3600,
                ...attempts,
                backoff: { freeFailures: FREE, baseSeconds: 1, maxSeconds: 2, ...backoff }
              }
            }
          }
        };
      }

      async function setUp (attempts, backoff) {
        restoreAttempts = injectTestConfigSnapshot(withAttempts(attempts, backoff));
        await _resetMFASingletons();
        return await enrol();
      }

      async function enrol () {
        const act = await activateTotp();
        secret = act.body.secret;
        const confirm = await coreRequest
          .post(`/${username}/mfa/confirm`)
          .set('Authorization', act.body.mfaToken)
          .send({ code: await previousStepCodeFor(secret) });
        assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
        return confirm.body.recoveryCodes;
      }

      /**
       * One guess on a brand-new login session. Asserts the attempt reached
       * the limiter, so a request failing for an unrelated reason cannot pass
       * for a consumed guess and surface later as an off-by-one.
       */
      async function guessOnFreshLogin (code = '000000') {
        const loginRes = await login();
        assert.strictEqual(loginRes.status, 200,
          `login itself must never be blocked by the MFA backoff (got ${loginRes.status} ${JSON.stringify(loginRes.body)})`);
        const res = await coreRequest
          .post(`/${username}/mfa/verify`)
          .set('Authorization', loginRes.body.mfaToken)
          .send({ code });
        assert.ok([200, 400, 401, 429].includes(res.status),
          `a guess must reach the limiter; got ${res.status} ${JSON.stringify(res.body)}`);
        return res;
      }

      /** `n` wrong guesses, each on a fresh login, none of which may be delayed. */
      async function freeWrongGuesses (n) {
        for (let i = 0; i < n; i++) {
          const res = await guessOnFreshLogin();
          assert.ok(res.status === 400 || res.status === 401, `guess ${i + 1}: ${res.status} ${JSON.stringify(res.body)}`);
        }
      }

      function assertDelayed (res, expectedSeconds) {
        assert.strictEqual(res.status, 429, `expected a backoff delay: ${res.status} ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.error.id, 'too-many-attempts');
        assert.ok(res.headers['retry-after'] != null, 'a Retry-After header should be set');
        const seconds = res.body.error.data.retryAfterSeconds;
        assert.ok(Number.isInteger(seconds) && seconds >= 1, `retryAfterSeconds: ${seconds}`);
        if (expectedSeconds != null) assert.strictEqual(seconds, expectedSeconds);
        return seconds;
      }

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      afterEach(function () {
        if (restoreAttempts) restoreAttempts();
        restoreAttempts = null;
      });

      it('[MA12A] fresh logins do not buy a fresh budget: past the free failures the next attempt is delayed, even with a correct code', async function () {
        await setUp();
        // The free failures, one per fresh login: no delay yet.
        await freeWrongGuesses(FREE);
        // The first failure past them answers as a failure (not 429)...
        const breaching = await guessOnFreshLogin();
        assert.strictEqual(breaching.status, 400, 'the failing guess itself is answered as a failure');
        // ...and delays the NEXT attempt, whatever the code.
        const correct = await guessOnFreshLogin(totpCodeFor(secret, 0));
        assertDelayed(correct, 1);
      });

      it('[MA12B] the delay lifts on its own and doubles on the next failure', async function () {
        await setUp({}, { maxSeconds: 60 });
        await freeWrongGuesses(FREE + 1);
        assertDelayed(await guessOnFreshLogin(), 1);
        await sleep(1100);
        const next = await guessOnFreshLogin();
        assert.strictEqual(next.status, 400, `after the delay a guess is verified again: ${JSON.stringify(next.body)}`);
        const doubled = assertDelayed(await guessOnFreshLogin(), 2);
        await sleep(doubled * 1000 + 100);
        const ok = await guessOnFreshLogin(totpCodeFor(secret, 0));
        assert.strictEqual(ok.status, 200, `a correct code logs in once the delay ran out: ${JSON.stringify(ok.body)}`);
      });

      it('[MA12C] backoff.maxSeconds:0 disables the per-account backoff', async function () {
        await setUp({}, { maxSeconds: 0 });
        for (let i = 0; i < FREE + 6; i++) {
          const res = await guessOnFreshLogin();
          assert.notStrictEqual(res.status, 429, `guess ${i + 1} must not be delayed when the backoff is off`);
        }
        const correct = await guessOnFreshLogin(totpCodeFor(secret, 0));
        assert.strictEqual(correct.status, 200, 'a correct code must still work');
      });

      it('[MA12D] the per-session ceiling is unchanged, and its failures also accrue per account', async function () {
        await setUp({}, { freeFailures: PER_SESSION + 2, maxSeconds: 60 });
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
        // Those five counted: two more free failures, one that breaches, then a delay.
        await freeWrongGuesses(3);
        assertDelayed(await guessOnFreshLogin());
      });

      it('[MA12E] mfa.recover clears the tally along with the enrolment', async function () {
        const recoveryCodes = await setUp({}, { baseSeconds: 3600, maxSeconds: 3600 });
        await freeWrongGuesses(FREE + 1);
        assertDelayed(await guessOnFreshLogin(totpCodeFor(secret, 0)));

        const recover = await coreRequest
          .post(`/${username}/mfa/recover`)
          .send({ username, password, recoveryCode: recoveryCodes[0] });
        assert.strictEqual(recover.status, 200, `recover failed: ${JSON.stringify(recover.body)}`);
        // Re-enrolling goes through mfa.confirm, which a surviving delay would refuse.
        await enrol();
        const ok = await guessOnFreshLogin(totpCodeFor(secret, 0));
        assert.strictEqual(ok.status, 200, `the delay must not outlive the enrolment: ${JSON.stringify(ok.body)}`);
      });

      it('[MA12F] the tally never damages the enrolment, and a success resets it', async function () {
        await setUp();
        await freeWrongGuesses(FREE);
        const ok = await guessOnFreshLogin(totpCodeFor(secret, 0));
        assert.strictEqual(ok.status, 200, `the enrolment must survive the tally writes: ${JSON.stringify(ok.body)}`);
        // Reset: the same number of free failures is granted again.
        await freeWrongGuesses(FREE);
        const notDelayed = await guessOnFreshLogin();
        assert.strictEqual(notDelayed.status, 400, 'the tally restarted from zero after the success');
      });

      it('[MA12G] the real user is never locked out: at the cap the wait is maxSeconds, then a correct code logs in', async function () {
        this.timeout(30000);
        await setUp({}, { baseSeconds: 1, maxSeconds: 2 });
        // An attacker keeps guessing, waiting out each delay: failures past the
        // free ones grow the delay 1, 2, 2, 2, ... (capped).
        let failures = 0;
        let lastDelay = 0;
        while (failures < FREE + 5) {
          const res = await guessOnFreshLogin();
          if (res.status === 429) {
            lastDelay = assertDelayed(res);
            assert.ok(lastDelay <= 2, `a delay never exceeds maxSeconds (got ${lastDelay})`);
            await sleep(lastDelay * 1000 + 100);
            continue;
          }
          assert.ok(res.status === 400 || res.status === 401, `a verified wrong guess: ${res.status} ${JSON.stringify(res.body)}`);
          failures++;
        }
        const refused = await guessOnFreshLogin(totpCodeFor(secret, 0));
        const wait = assertDelayed(refused, 2);
        await sleep(wait * 1000 + 100);
        const ok = await guessOnFreshLogin(totpCodeFor(secret, 0));
        assert.strictEqual(ok.status, 200, `the real user logs in after at most maxSeconds: ${JSON.stringify(ok.body)}`);
      });

      // mfa.recover is the last-resort path and is deliberately exempt from the
      // limiter in BOTH its steps: a recover failure must not feed the tally,
      // and an account in backoff must not be refused recovery. Checked
      // behaviourally: had a recover attempt accrued, the delay would come one
      // guess early.
      function recoverWith (body) {
        return coreRequest.post(`/${username}/mfa/recover`).send(body);
      }

      it('[MA12H] a wrong password on recover neither feeds the tally nor is delayed by it', async function () {
        const codes = await setUp({}, { baseSeconds: 3600, maxSeconds: 3600 });
        await freeWrongGuesses(FREE - 1);
        const wrongPwd = await recoverWith({ username, password: 'wrong', recoveryCode: codes[0] });
        assert.strictEqual(wrongPwd.status, 401, 'a wrong password must stay 401, never 429');
        assert.strictEqual(wrongPwd.body.error.id, 'invalid-credentials');
        // Still one free failure left: this guess must not trigger a delay.
        await freeWrongGuesses(1);
        const stillFree = await guessOnFreshLogin();
        assert.strictEqual(stillFree.status, 400, 'the recover attempt must not have been counted');
        // Now in backoff: recovery stays reachable.
        assertDelayed(await guessOnFreshLogin());
        const underDelay = await recoverWith({ username, password: 'wrong', recoveryCode: codes[0] });
        assert.strictEqual(underDelay.status, 401, 'recover must never answer 429');
      });

      it('[MA12I] a wrong recovery code neither feeds the tally nor is delayed by it', async function () {
        await setUp({}, { baseSeconds: 3600, maxSeconds: 3600 });
        await freeWrongGuesses(FREE - 1);
        const badCode = await recoverWith({ username, password, recoveryCode: 'not-a-real-code' });
        assert.strictEqual(badCode.status, 400, 'a wrong recovery code must stay 400, never 429');
        await freeWrongGuesses(1);
        const stillFree = await guessOnFreshLogin();
        assert.strictEqual(stillFree.status, 400, 'the recover attempt must not have been counted');
        assertDelayed(await guessOnFreshLogin());
        const underDelay = await recoverWith({ username, password, recoveryCode: 'not-a-real-code' });
        assert.strictEqual(underDelay.status, 400, 'recover must never answer 429');
      });

      it('[MA12J] concurrent wrong guesses each count', async function () {
        await setUp({}, { freeFailures: 100, maxSeconds: 60 });
        const N = 8;
        const tokens = [];
        for (let i = 0; i < N; i++) tokens.push((await login()).body.mfaToken);
        const results = await Promise.all(tokens.map((t) =>
          coreRequest.post(`/${username}/mfa/verify`).set('Authorization', t).send({ code: '000000' })));
        assert.deepStrictEqual(results.map((r) => r.status), Array(N).fill(400));
        const { data } = await storedProfile();
        assert.strictEqual(data.mfaThrottle.failures, N, 'no failure may be lost to a concurrent one');
      });

      it('[MA12K] a tally stored by the former lockout counts, and its lock is not honoured', async function () {
        await setUp();
        const { user, profile } = await storedProfile();
        const legacy = { count: FREE, windowStartedAt: Date.now(), lockedUntil: Date.now() + 3600 * 1000 };
        await new Promise((resolve, reject) => profile.updateOne(user, { id: 'private' }, { data: { mfaThrottle: legacy } },
          (err) => err ? reject(err) : resolve()));
        // The stored lock is ignored: a guess is verified...
        const guess = await guessOnFreshLogin();
        assert.strictEqual(guess.status, 400, `a former lock must not be honoured: ${JSON.stringify(guess.body)}`);
        // ...and the former count carried over: that was failure FREE + 1.
        assertDelayed(await guessOnFreshLogin(), 1);
        const { data } = await storedProfile();
        assert.strictEqual(data.mfaThrottle.failures, FREE + 1);
        assert.strictEqual(data.mfaThrottle.lockedUntil, undefined, 'the former shape is replaced');
      });

      // Parallel attempts: each one is counted before its code is checked, so
      // attempts in flight at once cannot all pass the check and reach the
      // method. Evaluations are counted at the method itself, which is slowed
      // down (as a remote SMS check would be) so the attempts overlap.
      async function countingVerifies (fn) {
        const TotpService = require('business/src/mfa/TotpService.ts').default;
        const original = TotpService.prototype.verify;
        const counter = { calls: 0 };
        TotpService.prototype.verify = async function (...args) {
          counter.calls++;
          await sleep(200);
          return original.apply(this, args);
        };
        try {
          counter.result = await fn();
        } finally {
          TotpService.prototype.verify = original;
        }
        return counter;
      }

      function burst (tokens, perToken, code = '000000') {
        const requests = [];
        for (const token of tokens) {
          for (let i = 0; i < perToken; i++) {
            requests.push(coreRequest.post(`/${username}/mfa/verify`).set('Authorization', token).send({ code }));
          }
        }
        return Promise.all(requests);
      }

      function assertRefusedOrFailed (results) {
        for (const r of results) {
          assert.ok([400, 401, 429].includes(r.status), `unexpected answer in a burst: ${r.status} ${JSON.stringify(r.body)}`);
        }
      }

      it('[MA12L] a parallel burst on one session reaches the method at most the per-session ceiling', async function () {
        await setUp({}, { maxSeconds: 0 });
        const token = (await login()).body.mfaToken;
        const K = 20;
        const { calls, result } = await countingVerifies(() => burst([token], K));
        assertRefusedOrFailed(result);
        assert.ok(calls >= 1 && calls <= PER_SESSION, `${calls} of ${K} parallel guesses reached the method (ceiling ${PER_SESSION})`);
        assert.strictEqual(result.filter((r) => r.status === 400).length, calls - 1,
          'every evaluated guess but the one using the last slot answers as a wrong code');
        const after = await coreRequest
          .post(`/${username}/mfa/verify`).set('Authorization', token).send({ code: totpCodeFor(secret, 0) });
        assert.strictEqual(after.status, 401, 'a correct code after the session ceiling is refused');
      });

      it('[MA12M] a parallel burst on one session: the account tally equals the evaluated attempts', async function () {
        // A delay long enough that it cannot lapse during the burst.
        await setUp({}, { baseSeconds: 60, maxSeconds: 60 });
        const token = (await login()).body.mfaToken;
        const K = 20;
        const { calls, result } = await countingVerifies(() => burst([token], K));
        assertRefusedOrFailed(result);
        assert.ok(calls >= 1 && calls <= FREE + 1, `${calls} of ${K} parallel guesses reached the method (cap ${FREE + 1})`);
        const { data } = await storedProfile();
        assert.strictEqual(data.mfaThrottle.failures, calls, 'every evaluated attempt counted, and only those');
      });

      it('[MA12N] parallel bursts across several sessions respect the account ceiling, and a correct code after it is refused', async function () {
        await setUp({}, { baseSeconds: 60, maxSeconds: 60 });
        const tokens = [];
        for (let i = 0; i < 8; i++) tokens.push((await login()).body.mfaToken);
        const { calls, result } = await countingVerifies(() => burst(tokens, PER_SESSION));
        assertRefusedOrFailed(result);
        assert.ok(calls >= 1 && calls <= FREE + 1, `${calls} of ${tokens.length * PER_SESSION} parallel guesses reached the method (cap ${FREE + 1})`);
        const { data } = await storedProfile();
        assert.strictEqual(data.mfaThrottle.failures, calls, 'every evaluated attempt counted, and only those');
        const correct = await countingVerifies(() => guessOnFreshLogin(totpCodeFor(secret, 0)));
        assertDelayed(correct.result);
        assert.strictEqual(correct.calls, 0, 'a correct code past the ceiling is refused before it is checked');
      });

      it('[MA12O] an attempt refused by the account tally gives its session slot back', async function () {
        // The first failure sets a delay, so concurrent attempts on the same
        // session are refused by the account reservation after taking a slot.
        await setUp({ perSession: 10 }, { freeFailures: 0, baseSeconds: 60, maxSeconds: 60 });
        const token = (await login()).body.mfaToken;
        const K = 5;
        const { calls, result } = await countingVerifies(() => burst([token], K));
        assertRefusedOrFailed(result);
        assert.strictEqual(calls, 1, 'only the first attempt reaches the method');
        const session = await getMFASessionStore(null).get(token);
        assert.ok(session != null, 'the session survives the burst');
        assert.strictEqual(session.attempts, calls, 'only evaluated attempts keep their session slot');
      });
    });
  });
});
