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
});
