/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The password-reset link mailed by POST /:username/account/request-password-reset
 * (Pattern C): `auth.passwordResetPageURL` plus the token, whether or not the
 * operator's page URL already carries a query (the account app needs
 * `pryvServiceInfoUrl` on it when it serves several platforms).
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const nock = require('nock');
const { useNock } = require('test-helpers/src/nockScope.ts');
const { withInjectedConfig } = require('test-helpers');

// A trusted app with a wildcard origin in the test config.
const TRUSTED_APP = 'pryv-test-no-cors';

describe('[RSLK] password-reset link', function () {
  this.timeout(30000);
  let fixtures;
  useNock();

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
  });

  after(async function () {
    await fixtures.clean();
  });

  async function requestResetLink (pageURL) {
    const username = 'rsl' + cuid().toLowerCase().slice(1, 12);
    await fixtures.user(username, { email: username + '@reset.example.com' });
    const captured = [];
    nock('https://mandrillapp.local').post('/api/1.0/messages/send-template.json')
      .reply(200, (uri, body) => { captured.push(body); return {}; });
    await withInjectedConfig({
      services: { email: { enabled: { resetPassword: true } } },
      auth: { passwordResetPageURL: pageURL }
    }, async () => {
      const res = await coreRequest.post('/' + username + '/account/request-password-reset')
        .send({ appId: TRUSTED_APP });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    });
    assert.strictEqual(captured.length, 1);
    const vars = captured[0].message.global_merge_vars;
    return {
      link: new URL(vars.find((v) => v.name === 'RESET_LINK').content),
      token: vars.find((v) => v.name === 'RESET_TOKEN').content
    };
  }

  it('[RSLK1] a page URL without a query gets ?resetToken=', async function () {
    const { link, token } = await requestResetLink('https://app.example.com/reset-password');
    assert.strictEqual(link.origin + link.pathname, 'https://app.example.com/reset-password');
    assert.strictEqual(link.searchParams.get('resetToken'), token);
  });

  it('[RSLK2] a page URL that already carries a query keeps its own parameters intact', async function () {
    const { link, token } = await requestResetLink(
      'https://app.example.com/reset-password?pryvServiceInfoUrl=https%3A%2F%2Fcore.example.com%2Freg%2Fservice%2Finfo');
    // A second '?' would fold the token into the operator's parameter value.
    assert.strictEqual(link.searchParams.get('pryvServiceInfoUrl'), 'https://core.example.com/reg/service/info');
    assert.strictEqual(link.searchParams.get('resetToken'), token);
  });

  it('[RSLK3] no reset mail goes to an account\'s email that another account holds now; the answer is the same as when it is sent', async function () {
    const { platform } = require('platform');
    const username = 'rsl' + cuid().toLowerCase().slice(1, 12);
    const email = username + '@reset.example.com';
    await fixtures.user(username, { email });
    const captured = [];
    nock('https://mandrillapp.local').post('/api/1.0/messages/send-template.json').times(2)
      .reply(200, (uri, body) => { captured.push(body); return {}; });
    const request = () => withInjectedConfig({
      services: { email: { enabled: { resetPassword: true } } },
      auth: { passwordResetPageURL: 'https://app.example.com/reset-password' }
    }, async () => await coreRequest.post('/' + username + '/account/request-password-reset').send({ appId: TRUSTED_APP }));
    const withoutMeta = (body) => { const { meta, ...rest } = body; return rest; };

    // Sent while the account holds its email.
    const sent = await request();
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual(captured.length, 1);
    // A second request within the minute is otherwise refused.
    await require('storages').platformDB.deleteAccessState(require('business/src/auth/passwordResetThrottle.ts').cooldownKey(username));

    // The address changed hands (e.g. the account was restored from a backup older than that).
    const holder = 'rslholder' + cuid().toLowerCase().slice(1, 10);
    await platform.deleteUserUniqueField('email', email);
    await platform.setUserUniqueField(holder, 'email', email);
    try {
      const held = await request();
      assert.strictEqual(held.status, sent.status, JSON.stringify(held.body));
      assert.deepStrictEqual(withoutMeta(held.body), withoutMeta(sent.body));
      assert.strictEqual(captured.length, 1, 'no mail sent to the holder of the address');
    } finally {
      await platform.deleteUserUniqueField('email', email);
      await platform.setUserUniqueField(username, 'email', email);
      nock.cleanAll();
    }
  });

  /** A reset request for a new account whose email row `prepare` changes; the mails it sent. */
  async function resetWith (prepare, emailOf = (username) => username + '@reset.example.com') {
    const { platform } = require('platform');
    const username = 'rsl' + cuid().toLowerCase().slice(1, 12);
    const email = emailOf(username);
    await fixtures.user(username, { email });
    const captured = [];
    nock('https://mandrillapp.local').post('/api/1.0/messages/send-template.json')
      .reply(200, (uri, body) => { captured.push(body); return {}; });
    const undo = await prepare(platform, email, username);
    try {
      const res = await withInjectedConfig({
        services: { email: { enabled: { resetPassword: true } } },
        auth: { passwordResetPageURL: 'https://app.example.com/reset-password' }
      }, async () => await coreRequest.post('/' + username + '/account/request-password-reset').send({ appId: TRUSTED_APP }));
      return { res, captured, email };
    } finally {
      await undo();
      await platform.deleteUserUniqueField('email', email);
      await platform.setUserUniqueField(username, 'email', email);
      nock.cleanAll();
    }
  }

  it('[RSLK4] an account\'s email with no platform row at all is mailed (an absent row is not a held one)', async function () {
    const { res, captured, email } = await resetWith(async (platform, address) => {
      await platform.deleteUserUniqueField('email', address);
      return async () => {};
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(captured.length, 1);
    assert.deepStrictEqual(captured[0].message.to.map((t) => t.email), [email]);
  });

  it('[RSLK6] in cleartext mode, another spelling of the address held by another account counts as held: no mail', async function () {
    // The platform in cleartext mode (rows keyed by the address as written,
    // over the same store): the account holds the stored spelling, another
    // account the lowercase one (a registration by whoever controls that
    // inbox now).
    const { res, captured } = await resetWith(async (platform, address, username) => {
      const platformDB = require('storages').platformDB;
      const config = await require('@pryv/boiler').getConfig();
      const { PiiHasher } = require('platform/src/PiiHasher.ts');
      platform._setDependenciesForTests(platformDB, null);
      await platformDB.setUserUniqueField(username, 'email', address);
      await platformDB.setUserUniqueField('rslholder', 'email', address.toLowerCase());
      return async () => {
        for (const value of [address, address.toLowerCase()]) await platformDB.deleteUserUniqueField('email', value);
        platform._setDependenciesForTests(platformDB, new PiiHasher(config.get('platform:piiHmacKey'), config.get('platform:piiAlgorithm') || undefined));
      };
    }, (username) => 'Rsl' + username.slice(3) + '@Reset.example.com');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(captured.length, 0, 'no mail to the address another account holds under another spelling');
  });

  it('[RSLK5] when the platform rows cannot be read, the reset fails and no mail is sent', async function () {
    // The platform store's reads of unique rows fail (both lookups the check may use).
    const { res, captured } = await resetWith(async () => {
      const platformDB = require('storages').platformDB;
      const unreachable = async () => { throw new Error('platform store unreachable'); };
      const methods = ['getUsersUniqueField', 'getUsersUniqueFieldAnyCase'];
      const saved = methods.map((m) => Object.getOwnPropertyDescriptor(platformDB, m));
      for (const m of methods) platformDB[m] = unreachable;
      return async () => {
        methods.forEach((m, i) => {
          if (saved[i] != null) Object.defineProperty(platformDB, m, saved[i]);
          else delete platformDB[m];
        });
      };
    });
    assert.ok(res.status >= 500, res.status + ' ' + JSON.stringify(res.body));
    assert.strictEqual(res.body.error?.id, 'unexpected-error', JSON.stringify(res.body));
    assert.strictEqual(captured.length, 0, 'no mail');
  });
});
