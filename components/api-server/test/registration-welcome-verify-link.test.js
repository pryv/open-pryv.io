/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The welcome mail of a new account carries a "verify my email" link
 * (VERIFY_LINK) when the founding address is not proved and the verification
 * mail is enabled; a registration proved by code gets the plain welcome mail.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const nock = require('nock');
const { useNock } = require('test-helpers/src/nockScope.ts');
const charlatan = require('charlatan');
const cuid = require('cuid');
const { setTimeout } = require('node:timers/promises');
const { listeningAgent } = require('test-helpers');

const { getApplication } = require('api-server/src/application.ts');
const { getConfig } = require('@pryv/boiler');
const { databaseFixture, injectTestConfigSnapshot } = require('test-helpers');
const { produceStorageConnection } = require('api-server/test/test-helpers');
const { pubsub } = require('messages');
const container = require('business/src/emails/container.ts');
const { getUsersRepository } = require('business/src/users/index.ts');

const MAIL_HOST = 'https://mandrillapp.local';
const MAIL_PATH = '/api/1.0/messages/send-template.json';
const TRUSTED_APP = 'pryv-test-no-cors';
const MAIL_ON = { welcome: true, resetPassword: false, verifyEmail: true };

describe('[WELC] welcome mail verification link', function () {
  useNock();

  this.timeout(20000);

  let fixtures;
  let request;
  let restoreConfig;
  let captured;

  before(async function () {
    await getConfig();
    restoreConfig = injectTestConfigSnapshot({
      dnsLess: { isActive: true },
      custom: { systemStreams: null },
      services: { email: { enabled: MAIL_ON } },
      account: { emailVerification: { requireAtRegistration: false, registrationCodeResendCooldownMs: 0 } }
    });
    fixtures = databaseFixture(await produceStorageConnection());
    const app = getApplication(true);
    await app.initiate();
    await require('api-server/src/methods/auth/register.ts').default(app.api);
    await require('api-server/src/methods/account.ts').default(app.api);
    await require('api-server/src/methods/events.ts').default(app.api);
    await require('api-server/src/methods/system.ts').default(app.systemAPI, app.api);
    pubsub.setTestNotifier({ emit: () => {} });
    request = await listeningAgent(app.expressApp);
    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });

  after(async function () {
    restoreConfig();
    if (fixtures != null) await fixtures.context.cleanEverything();
  });

  beforeEach(function () {
    captured = [];
    nock.cleanAll();
    nock(MAIL_HOST).persist().post(MAIL_PATH).reply(200, (uri, body) => {
      captured.push(body);
      return {};
    });
  });

  function mergeVar (body, name) {
    const found = body.message.global_merge_vars.find((v) => v.name === name);
    return found != null ? found.content : undefined;
  }
  function registerBody (overrides = {}) {
    return Object.assign({
      username: 'welc' + cuid.slug().toLowerCase(),
      password: charlatan.Lorem.characters(9),
      email: 'welc-' + cuid.slug().toLowerCase() + '@test.com',
      appId: charlatan.Lorem.characters(7),
      insurancenumber: charlatan.Number.number(3),
      phoneNumber: charlatan.Number.number(3)
    }, overrides);
  }
  // The welcome mail is sent in the background, after the response.
  async function welcomeMails () {
    for (let i = 0; i < 100; i++) {
      const found = captured.filter((b) => /welcome/.test(b.template_name));
      if (found.length > 0) {
        await setTimeout(100); // let a duplicate, if any, arrive too
        return captured.filter((b) => /welcome/.test(b.template_name));
      }
      await setTimeout(50);
    }
    return [];
  }
  async function containerEvent (username, email) {
    const usersRepository = await getUsersRepository();
    const userId = await usersRepository.getUserIdForUsername(username);
    return { userId, ev: await container.findRawByValue(userId, email) };
  }

  it('[WEL01] an unproved registration gets one welcome mail with the link; [WEL04] the link proves the address', async function () {
    const body = registerBody();
    const res = await request.post('/users').send(body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const mails = await welcomeMails();
    assert.strictEqual(mails.length, 1, 'exactly one welcome mail');
    assert.ok(!captured.some((b) => /verify-email/.test(b.template_name)), 'no separate verification mail');
    const link = mergeVar(mails[0], 'VERIFY_LINK');
    assert.ok(typeof link === 'string' && link.startsWith('http://test.pryv.local/verify-email?verifyToken='), link);
    const url = new URL(link);
    assert.strictEqual(url.searchParams.get('username'), body.username);
    assert.strictEqual(mergeVar(mails[0], 'VERIFY_TOKEN'), url.searchParams.get('verifyToken'), 'paste fallback: same token');
    assert.strictEqual(mergeVar(mails[0], 'VERIFY_URL'), 'http://test.pryv.local/verify-email');
    const { ev } = await containerEvent(body.username, body.email);
    assert.strictEqual(typeof ev.content.verificationTokenHash, 'string', 'only the hash is stored');
    assert.ok(ev.content.verificationTokenExpires > Date.now() / 1000, 'the token has a future expiry');
    assert.strictEqual(typeof ev.content.verificationSentAt, 'number', 'the resend cooldown starts');
    assert.ok(!JSON.stringify(ev.content).includes(url.searchParams.get('verifyToken')), 'the token itself is not stored');

    const verify = await request.post('/' + body.username + '/account/verify-email')
      .set('Origin', 'http://test.pryv.local').send({ appId: TRUSTED_APP, token: url.searchParams.get('verifyToken') });
    assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));
    const token = res.body.apiEndpoint.split('//')[1].split('@')[0];
    const events = await request.get('/' + body.username + '/events').set('authorization', token)
      .query({ streams: JSON.stringify([':system:email']), types: ['verification/email'] });
    assert.strictEqual(events.status, 200, JSON.stringify(events.body));
    assert.strictEqual(events.body.events[0].content.verified, true);
    assert.strictEqual(events.body.events[0].content.method, 'email-link');
  });

  it('[WEL02] a registration proved by code gets the plain welcome mail', async function () {
    const restore = injectTestConfigSnapshot({ account: { emailVerification: { requireAtRegistration: true } } });
    try {
      const email = 'welc-' + cuid.slug().toLowerCase() + '@test.com';
      const challengeRes = await request.post('/reg/email-challenge').send({ email });
      assert.strictEqual(challengeRes.status, 200, JSON.stringify(challengeRes.body));
      const code = mergeVar(captured[captured.length - 1], 'CODE');
      const verifyRes = await request.post('/reg/email-challenge/verify').send({ email, code });
      assert.strictEqual(verifyRes.status, 200, JSON.stringify(verifyRes.body));
      const body = registerBody({ email, emailProof: verifyRes.body.emailProof });
      const res = await request.post('/users').send(body);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const mails = await welcomeMails();
      assert.strictEqual(mails.length, 1);
      assert.strictEqual(mergeVar(mails[0], 'VERIFY_LINK'), undefined);
      const { ev } = await containerEvent(body.username, email);
      assert.strictEqual(ev.content.verificationMethod, 'email-code');
      assert.ok(ev.content.verificationTokenHash == null, 'no token minted');
    } finally {
      restore();
    }
  });

  it('[WEL06] a user created through the system API also gets the link', async function () {
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    const user = {
      username: 'welc' + cuid.slug().toLowerCase(),
      passwordHash: '$2b$10$' + 'a'.repeat(53),
      email: 'welc-' + cuid.slug().toLowerCase() + '@test.com',
      language: 'en'
    };
    const res = await request.post('/system/create-user')
      .set('authorization', config.get('auth:adminAccessKey')).send(user);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const mails = await welcomeMails();
    assert.strictEqual(mails.length, 1);
    assert.match(mergeVar(mails[0], 'VERIFY_LINK') || '', /verifyToken=/);
  });

  it('[WEL07] services.email.enabled: false sends no welcome mail', async function () {
    const restore = injectTestConfigSnapshot({ services: { email: { enabled: false } } });
    try {
      const res = await request.post('/users').send(registerBody());
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.deepStrictEqual(await welcomeMails(), []);
    } finally {
      restore();
    }
  });

  it('[WEL03] with the verification mail off: no link, no token minted', async function () {
    const restore = injectTestConfigSnapshot({ services: { email: { enabled: { welcome: true, resetPassword: false, verifyEmail: false } } } });
    try {
      const body = registerBody();
      const res = await request.post('/users').send(body);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const mails = await welcomeMails();
      assert.strictEqual(mails.length, 1);
      assert.strictEqual(mergeVar(mails[0], 'VERIFY_LINK'), undefined);
      const { ev } = await containerEvent(body.username, body.email);
      assert.ok(ev.content.verificationTokenHash == null, 'no token minted');
    } finally {
      restore();
    }
  });
});
