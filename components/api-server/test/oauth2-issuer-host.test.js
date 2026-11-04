/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * On a DNS-topology core (username in the host), the OAuth endpoints and the
 * discovery documents are served at the root on every host the core answers:
 * a vanity issuer host (`auth-eu.<domain>`) or a user host is never read as a
 * username for them. The test core runs dnsLess: the front of a DNS-topology
 * app (its username-rewriter included) is put before it, so a request reaches
 * the core's routes exactly as on a DNS deployment.
 */

/* global initTests, initCore, coreRequest, assert, app, getNewFixture, injectTestConfigSnapshot */

const cuid = require('cuid');
const { listeningAgent } = require('test-helpers');

const DOMAIN = 'issuer-host.pryv.li';

describe('[OAIH] OAuth endpoints on any host of a DNS-topology core', function () {
  let front, fixtures, username, token;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    const { expressAppInit } = require('../src/expressApp.ts');
    const restore = injectTestConfigSnapshot({ dnsLess: { isActive: false }, dns: { domain: DOMAIN }, core: { id: 'core-a' } });
    let frontApp;
    try {
      frontApp = await expressAppInit(app.logging);
    } finally {
      restore();
    }
    frontApp.use((req, res, next) => app.expressApp(req, res, next));
    front = await listeningAgent(frontApp);
    fixtures = getNewFixture();
    username = 'oaih' + cuid().slice(-8).toLowerCase();
    token = cuid();
    const user = await fixtures.user(username);
    await user.access({ type: 'personal', token });
    await user.session(token);
  });

  after(async function () {
    await fixtures.clean();
  });

  it('[OAIH1] the discovery document answers on a vanity issuer host and on a user host, naming the configured issuer', async function () {
    const atRoot = await coreRequest.get('/.well-known/oauth-authorization-server');
    assert.strictEqual(atRoot.status, 200, atRoot.text);
    for (const host of ['auth-eu.' + DOMAIN, username + '.' + DOMAIN]) {
      const res = await front.get('/.well-known/oauth-authorization-server').set('Host', host);
      assert.strictEqual(res.status, 200, host + ': ' + res.text);
      assert.strictEqual(res.body.issuer, atRoot.body.issuer, host);
    }
  });

  it('[OAIH2] /oauth2/* reaches the OAuth routes on a vanity issuer host, not a user route', async function () {
    // An unknown client is the OAuth routes' own answer, not a 404 of the user router.
    const res = await front.get('/oauth2/authorize').set('Host', 'auth-eu.' + DOMAIN)
      .query({ response_type: 'code', client_id: 'no-such-client', redirect_uri: 'https://app.example.com/cb' });
    const atRoot = await coreRequest.get('/oauth2/authorize')
      .query({ response_type: 'code', client_id: 'no-such-client', redirect_uri: 'https://app.example.com/cb' });
    assert.notStrictEqual(res.status, 404, res.text);
    assert.strictEqual(res.status, atRoot.status, res.text);
    assert.deepStrictEqual(res.body, atRoot.body);
  });

  it('[OAIH3] other paths of a user host are still the user\'s', async function () {
    const res = await front.get('/events').set('Host', username + '.' + DOMAIN).set('Authorization', token);
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(Array.isArray(res.body.events), res.text);
  });
});
