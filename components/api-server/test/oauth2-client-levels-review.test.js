/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OCLR] OAuth client levels driven by the review routes, end to end on the
 * real platform store: a publisher decided validated makes its unreviewed app
 * Publisher Validated (served while Non-Validated is refused); the publisher
 * suspended stops the refresh of the grants already given (the refresh token
 * is not consumed: validated again, it refreshes); an app approved over HTTP
 * is offered as App Validated.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const oauth2 = require('oauth2');
const storage = require('oauth2/src/storage.ts');
const setup = require('business/src/admin/setupState.ts');
const { KEYS } = require('business/src/admin/store.ts');
const { persistDeveloperClient } = require('oauth2/src/clientRegistry.ts');

const REDIRECT_URI = 'https://app.review-levels.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const STATE_KEY = 'test-oauth-state-key-' + 'q1W2e3R4t5'.repeat(2);
const AUD = 'https://resource.test/review-levels';

const toyExtension = {
  apiVersion: 1,
  name: 'toy-review-levels',
  scopeGrammar: {
    parse (scopeString) {
      const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
      for (const t of tokens) if (!/^read\/[a-z]+$/.test(t)) return { ok: false, description: 'unknown token ' + t };
      return { ok: true, tokens, offer: { permissions: tokens.map((t) => ({ streamId: t.slice(5), level: 'read' })) } };
    },
    echo: ({ requestedTokens }) => requestedTokens,
  },
};

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

describe('[OCLR] OAuth client levels driven by the review routes', function () {
  this.timeout(60000);

  let fixtures, restoreConfig, platformDB, adminKey;
  const owner = 'own' + cuid().slice(-10);
  const cid = 'Lvrr.' + cuid().slice(-10);

  before(async function () {
    await initTests();
    await initCore();
    const app = globalThis.app;
    if (!app.systemAPI.has('system.oauthClients.list')) await require('api-server/src/methods/systemAdminOauth.ts').default(app.systemAPI);
    fixtures = getNewFixture();
    restoreConfig = require('test-helpers').injectTestConfigSnapshot({
      oauth: {
        consentUrl: CONSENT_URL,
        stateKey: STATE_KEY,
        audienceBoundSessions: false,
        clientRegistration: { mode: 'delegated', levels: { nonValidated: { consent: 'refuse' } } },
      },
    });
    oauth2.extension.setExtension(toyExtension);
    platformDB = require('storages').platformDB;
    adminKey = (await require('@pryv/boiler').getConfig()).get('auth:adminAccessKey');
    await setup.recordLegacyReady(platformDB, { coreId: require('platform').platform.coreId, now: Date.now() });
    await persistDeveloperClient(platformDB, owner, {
      clientId: cid,
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [AUD],
      subjectType: 'public',
      scope: ['read/a'],
      clientName: 'Review levels app',
    });
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    try { await storage.deleteClient(platformDB, cid); } catch (_) { /* best-effort */ }
    await platformDB.deletePlatformKv('dev-publisher/' + owner);
    await platformDB.deletePlatformKv(KEYS.setupState);
    if (fixtures != null) await fixtures.clean();
  });

  async function newUser () {
    const username = cuid();
    const token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    const s = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id: 'a', name: 'a' });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    return { username, token };
  }

  async function authorize () {
    const { verifier, challenge } = pkce();
    const res = await coreRequest.get('/oauth2/authorize').query({
      client_id: cid,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'offline_access read/a',
      aud: AUD,
    });
    assert.equal(res.status, 302, res.text);
    const loc = new URL(res.headers.location);
    return { verifier, loc, state: res.headers.location.startsWith(CONSENT_URL) ? loc.searchParams.get('state') : null };
  }

  async function consent (who) {
    const flow = await authorize();
    assert.ok(flow.state, 'not sent to the consent: ' + flow.loc.href);
    const o = await coreRequest.post('/oauth2/authorize/offer').send({ state: flow.state, username: who.username, userToken: who.token });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const granted = o.body.offer.permissions.map(({ currentlyGranted: _c, ...p }) => p);
    const accept = await coreRequest.post('/oauth2/authorize/accept')
      .send({ state: flow.state, username: who.username, userToken: who.token, grantedPermissions: granted, shownDigest: o.body.shownDigest });
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    const code = new URL(accept.body.redirectTo).searchParams.get('code');
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: flow.verifier, client_id: cid, redirect_uri: REDIRECT_URI,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    return { offer: o.body, tokens: t.body };
  }

  const refresh = (refreshToken) => coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cid });
  const decide = (body) => coreRequest.put('/system/admin/oauth/publishers/' + owner).set('authorization', adminKey).send(body);

  it('[OCLR1] a publisher decided validated serves its app; suspended, the refresh of its grants is refused without consuming the token; validated again, it refreshes', async () => {
    // Non-Validated is refused: not served before the decision.
    assert.equal((await authorize()).state, null);
    const v = await decide({ status: 'validated', displayName: 'Review Co', reason: 'KYC done' });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    const who = await newUser();
    const c = await consent(who);
    assert.deepEqual(c.offer.client.validation, { level: 'publisherValidated', publisher: { name: 'Review Co', validated: true } });
    const s = await decide({ status: 'suspended', reason: 'complaints' });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const refused = await refresh(c.tokens.refresh_token);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.deepEqual([refused.body.error, refused.body.error_description], ['unauthorized_client', 'this application is not validated on this platform']);
    assert.equal((await decide({ status: 'validated', reason: 'complaints answered' })).status, 200);
    const back = await refresh(c.tokens.refresh_token);
    assert.equal(back.status, 200, JSON.stringify(back.body));
  });

  it('[OCLR2] an app approved over HTTP is offered as App Validated, with when', async () => {
    const shown = await coreRequest.get('/system/admin/oauth/clients/' + cid).set('authorization', adminKey);
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    const before = Date.now();
    const a = await coreRequest.post('/system/admin/oauth/clients/' + cid + '/approve').set('authorization', adminKey).send({ digest: shown.body.digest });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const flow = await authorize();
    const o = await coreRequest.post('/oauth2/authorize/offer').send({ state: flow.state });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.equal(o.body.client.validation.level, 'appValidated');
    assert.ok(o.body.client.validation.validatedAt >= before);
  });
});
