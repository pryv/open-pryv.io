/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const nock = require('nock');
const charlatan = require('charlatan');
const cuid = require('cuid');
const { listeningAgent } = require('test-helpers');

const { getApplication } = require('api-server/src/application.ts');
const { getConfig } = require('@pryv/boiler');
const { databaseFixture, injectTestConfigSnapshot } = require('test-helpers');
const { produceStorageConnection } = require('api-server/test/test-helpers');
const { pubsub } = require('messages');
const challenge = require('business/src/emails/challenge.ts');

const MAIL_HOST = 'https://mandrillapp.local';
const MAIL_PATH = '/api/1.0/messages/send-template.json';

describe('[EMCR] registration email gate', function () {
  // nock >=14 patches the global http stack; activate on entry and fully
  // restore on exit so a later suite's real requests are not intercepted.
  before(() => { if (!nock.isActive()) nock.activate(); });
  after(() => { nock.cleanAll(); nock.restore(); });

  this.timeout(20000);

  let fixtures;
  let app;
  let request;
  let restoreConfig;
  let captured;

  before(async function () {
    await getConfig();
    restoreConfig = injectTestConfigSnapshot({
      dnsLess: { isActive: true },
      custom: { systemStreams: null },
      account: {
        emailVerification: {
          requireAtRegistration: true,
          registrationCodeResendCooldownMs: 0
        }
      }
    });
  });

  after(async function () {
    restoreConfig();
  });

  before(async function () {
    fixtures = databaseFixture(await produceStorageConnection());
    app = getApplication(true);
    await app.initiate();

    await require('api-server/src/methods/auth/register.ts').default(app.api);
    await require('api-server/src/methods/account.ts').default(app.api);
    await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);

    const testMsgs = [];
    pubsub.setTestNotifier({ emit: (...args) => testMsgs.push(args) });

    request = await listeningAgent(app.expressApp);

    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });

  after(async function () {
    if (fixtures != null) await fixtures.context.cleanEverything();
  });

  beforeEach(function () {
    captured = [];
    nock.cleanAll();
  });

  /** Intercept one Mandrill send and record the posted body. */
  function mailNock (status = 200) {
    return nock(MAIL_HOST)
      .post(MAIL_PATH)
      .reply(status, (uri, body) => {
        captured.push(body);
        return {};
      });
  }

  function mergeVar (body, name) {
    const found = body.message.global_merge_vars.find((v) => v.name === name);
    return found != null ? found.content : undefined;
  }

  function newEmail () {
    return 'emcr-' + cuid.slug().toLowerCase() + '@test.com';
  }

  function generateRegisterBody (overrides = {}) {
    return Object.assign({
      username: 'emcr' + cuid.slug().toLowerCase(),
      password: charlatan.Lorem.characters(9),
      email: newEmail(),
      appId: charlatan.Lorem.characters(7),
      insurancenumber: charlatan.Number.number(3),
      phoneNumber: charlatan.Number.number(3)
    }, overrides);
  }

  /** Full challenge -> verify round trip; returns { email, proof }. */
  async function proveEmail (email) {
    mailNock();
    const challengeRes = await request.post('/reg/email-challenge').send({ email });
    assert.strictEqual(challengeRes.status, 200, JSON.stringify(challengeRes.body));
    const code = mergeVar(captured[captured.length - 1], 'CODE');
    const verifyRes = await request.post('/reg/email-challenge/verify').send({ email, code });
    assert.strictEqual(verifyRes.status, 200, JSON.stringify(verifyRes.body));
    return { email, proof: verifyRes.body.emailProof };
  }

  it('[EMCR1] leaves registration untouched and the endpoint closed when the gate is off', async function () {
    const restore = injectTestConfigSnapshot({
      account: { emailVerification: { requireAtRegistration: false } }
    });
    try {
      const res = await request.post('/users').send(generateRegisterBody());
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));

      const challengeRes = await request.post('/reg/email-challenge').send({ email: newEmail() });
      assert.strictEqual(challengeRes.status, 403);
      assert.strictEqual(challengeRes.body.error.id, 'forbidden');
      assert.strictEqual(challengeRes.body.error.data.emailVerificationRequired, false);
      assert.strictEqual(captured.length, 0, 'no mail may be sent when the gate is off');
    } finally {
      restore();
    }
  });

  it('[EMCR2] refuses registration without an email address', async function () {
    const res = await request.post('/users').send(generateRegisterBody({ email: '' }));
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.id, 'invalid-parameters-format');
    assert.strictEqual(res.body.error.data.emailVerificationRequired, true);
  });

  it('[EMCR3] refuses registration when no proof is supplied', async function () {
    const body = generateRegisterBody();
    const res = await request.post('/users').send(body);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.id, 'forbidden');
    assert.strictEqual(res.body.error.data.emailVerificationRequired, true);

    const { getUsersRepository } = require('business/src/users/index.ts');
    const usersRepository = await getUsersRepository();
    assert.strictEqual(await usersRepository.usernameExists(body.username), false,
      'no user row may be created for a refused registration');
  });

  it('[EMCR4] refuses a proof issued for a different address', async function () {
    const { proof } = await proveEmail(newEmail());
    const res = await request.post('/users').send(generateRegisterBody({ email: newEmail(), emailProof: proof }));
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.id, 'forbidden');
  });

  it('[EMCR5] proves the founding email by code end to end', async function () {
    const email = newEmail();
    mailNock();
    const challengeRes = await request.post('/reg/email-challenge').send({ email });
    assert.strictEqual(challengeRes.status, 200, JSON.stringify(challengeRes.body));
    assert.strictEqual(challengeRes.body.sent, true);

    const code = mergeVar(captured[0], 'CODE');
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'the mailed code is formatted in two groups');
    assert.strictEqual(mergeVar(captured[0], 'EMAIL'), email);
    assert.ok(!JSON.stringify(captured[0].message.subject || '').includes(code.replace('-', '')),
      'the code must not travel in the subject');

    const verifyRes = await request.post('/reg/email-challenge/verify').send({ email, code });
    assert.strictEqual(verifyRes.status, 200, JSON.stringify(verifyRes.body));
    const proof = verifyRes.body.emailProof;
    assert.strictEqual(typeof proof, 'string');

    const body = generateRegisterBody({ email, emailProof: proof });
    const res = await request.post('/users').send(body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const token = res.body.apiEndpoint.split('//')[1].split('@')[0];
    const accountRes = await request.get('/' + body.username + '/account').set('authorization', token);
    assert.strictEqual(accountRes.status, 200, JSON.stringify(accountRes.body));
    const only = accountRes.body.account.emails[0];
    assert.strictEqual(only.value, email);
    assert.strictEqual(only.primary, true);
    assert.strictEqual(only.status, 'verified');
    assert.strictEqual(only.verificationMethod, 'email-code');
    assert.strictEqual(typeof only.verifiedAt, 'number');

    assert.strictEqual(await challenge.checkProof(email, proof), false,
      'the proof is consumed once the account exists');
  });

  it('[EMCR6] refuses a second account on a proof already spent', async function () {
    const email = newEmail();
    const { proof } = await proveEmail(email);
    const first = await request.post('/users').send(generateRegisterBody({ email, emailProof: proof }));
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const second = await request.post('/users').send(generateRegisterBody({ email, emailProof: proof }));
    assert.strictEqual(second.status, 403, JSON.stringify(second.body));
    assert.strictEqual(second.body.error.id, 'forbidden');
  });

  it('[EMCR7] keeps the proof usable when registration fails on a taken username', async function () {
    const email = newEmail();
    const { proof } = await proveEmail(email);

    const taken = generateRegisterBody();
    const seed = await proveEmail(taken.email);
    const seedRes = await request.post('/users').send(Object.assign({}, taken, { emailProof: seed.proof }));
    assert.strictEqual(seedRes.status, 201, JSON.stringify(seedRes.body));

    const clash = await request.post('/users').send(generateRegisterBody({
      username: taken.username, email, emailProof: proof
    }));
    assert.strictEqual(clash.status, 409, JSON.stringify(clash.body));

    const retry = await request.post('/users').send(generateRegisterBody({ email, emailProof: proof }));
    assert.strictEqual(retry.status, 201, JSON.stringify(retry.body));
  });

  it('[EMCR8] leaves no challenge row behind when the mail cannot be delivered', async function () {
    const email = newEmail();
    mailNock(500);
    const failed = await request.post('/reg/email-challenge').send({ email });
    assert.strictEqual(failed.status, 500, JSON.stringify(failed.body));
    assert.strictEqual(failed.body.error.id, 'unexpected-error');

    const { platformDB } = require('storages');
    assert.strictEqual(await platformDB.getAccessState(challenge.challengeKey(email)), null,
      'a failed send must release the row and the cooldown slot');

    captured = [];
    nock.cleanAll();
    mailNock();
    const retry = await request.post('/reg/email-challenge').send({ email });
    assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
  });

  it('[EMCR9] refuses a challenge for an address that already has an account', async function () {
    const email = newEmail();
    const { proof } = await proveEmail(email);
    const created = await request.post('/users').send(generateRegisterBody({ email, emailProof: proof }));
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));

    captured = [];
    nock.cleanAll();
    mailNock();
    const res = await request.post('/reg/email-challenge').send({ email });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.error.id, 'item-already-exists');
    assert.strictEqual(res.body.error.data.email, email);
    assert.strictEqual(captured.length, 0, 'no code may be mailed to a taken address');
  });

  it('[EMCR10] spends the attempt budget then closes the code', async function () {
    const email = newEmail();
    mailNock();
    const challengeRes = await request.post('/reg/email-challenge').send({ email });
    assert.strictEqual(challengeRes.status, 200, JSON.stringify(challengeRes.body));

    const first = await request.post('/reg/email-challenge/verify').send({ email, code: 'ZZZZ-ZZZZ' });
    assert.strictEqual(first.status, 401, JSON.stringify(first.body));
    assert.strictEqual(first.body.error.id, 'invalid-access-token');
    assert.strictEqual(first.body.error.data.attemptsRemaining, 4);

    let last = first;
    for (let i = 0; i < 10 && last.status !== 429; i++) {
      last = await request.post('/reg/email-challenge/verify').send({ email, code: 'ZZZZ-ZZZZ' });
    }
    assert.strictEqual(last.status, 429, JSON.stringify(last.body));
    assert.strictEqual(last.body.error.id, 'too-many-attempts');
    assert.strictEqual(last.body.error.data.reason, 'exhausted');
  });

  it('[EMCR11] holds a second code back for the cooldown', async function () {
    const restore = injectTestConfigSnapshot({
      account: { emailVerification: { registrationCodeResendCooldownMs: 60000 } }
    });
    try {
      const email = newEmail();
      mailNock();
      const first = await request.post('/reg/email-challenge').send({ email });
      assert.strictEqual(first.status, 200, JSON.stringify(first.body));

      mailNock();
      const second = await request.post('/reg/email-challenge').send({ email });
      assert.strictEqual(second.status, 429, JSON.stringify(second.body));
      assert.strictEqual(second.body.error.id, 'too-many-attempts');
      assert.strictEqual(second.body.error.data.retryAfterSeconds, 60);
      assert.strictEqual(second.headers['retry-after'], '60');
    } finally {
      restore();
    }
  });

  it('[EMCR12] leaves the admin create-user path outside the gate', async function () {
    const config = await getConfig();
    const username = 'emcrsys' + cuid.slug().toLowerCase();
    const email = newEmail();
    const { encryption } = require('utils');

    const res = await request.post('/system/create-user')
      .set('authorization', config.get('auth:adminAccessKey'))
      .send({
        username,
        passwordHash: encryption.hashSync('1l0v3p0t1r0nZ'),
        email,
        language: 'en'
      });
    assert.ok(res.status === 200 || res.status === 201, 'admin creation bypasses the gate: ' + res.status + ' ' + JSON.stringify(res.body));

    const { getUsersRepository } = require('business/src/users/index.ts');
    const usersRepository = await getUsersRepository();
    const user = await usersRepository.getUserByUsername(username);
    const emailsContainer = require('business/src/emails/container.ts');
    const views = await emailsContainer.listViews(user.id);
    assert.strictEqual(views[0].verificationMethod, 'registration',
      'an admin-created founding email carries registration trust, not email-code');
  });
});
