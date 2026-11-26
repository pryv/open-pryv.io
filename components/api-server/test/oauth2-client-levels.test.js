/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OCLV] OAuth client validation levels on the real platform store, end to
 * end: `maxGrants` counts the accounts a Non-Validated client reached (one
 * row each, reserved before the consent is written), a level whose consent is
 * `refuse` is refused at /oauth2/authorize and at refresh, and the grant is
 * stamped with the level at consent.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const oauth2 = require('oauth2');
const storage = require('oauth2/src/storage.ts');
const cv = require('oauth2/src/clientValidation.ts');
const { persistDeveloperClient } = require('oauth2/src/clientRegistry.ts');

const REDIRECT_URI = 'https://app.levels.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const STATE_KEY = 'test-oauth-state-key-' + 'z9Y8x7W6v5'.repeat(2);
const AUD = 'https://resource.test/levels';

const toyExtension = {
  apiVersion: 1,
  name: 'toy-levels',
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

describe('[OCLV] OAuth client validation levels on the platform store', function () {
  this.timeout(60000);

  let fixtures, restoreConfig, platformDB;
  const owners = { capped: 'own' + cuid().slice(-10), refused: 'own' + cuid().slice(-10) };
  const ids = { capped: 'Lvc.' + cuid().slice(-10), refused: 'Lvr.' + cuid().slice(-10) };

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = require('test-helpers').injectTestConfigSnapshot({
      oauth: {
        consentUrl: CONSENT_URL,
        stateKey: STATE_KEY,
        audienceBoundSessions: false,
        clientRegistration: { mode: 'delegated', levels: { nonValidated: { maxGrants: 1 }, publisherValidated: { consent: 'refuse' } } },
      },
    });
    oauth2.extension.setExtension(toyExtension);
    platformDB = require('storages').platformDB;
    const row = {
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [AUD],
      subjectType: 'public',
      scope: ['read/a'],
      clientName: 'Levels app',
    };
    await persistDeveloperClient(platformDB, owners.capped, { ...row, clientId: ids.capped });
    await persistDeveloperClient(platformDB, owners.refused, { ...row, clientId: ids.refused });
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of Object.values(ids)) {
      try { await cv.releaseLevelGrants(platformDB, id); } catch (_) { /* best-effort */ }
      try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
    }
    for (const userId of Object.values(owners)) {
      try { await platformDB.deletePlatformKv('dev-publisher/' + userId); } catch (_) { /* best-effort */ }
    }
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

  async function authorize (cid) {
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
    return { verifier, cid, loc, state: res.headers.location.startsWith(CONSENT_URL) ? loc.searchParams.get('state') : null };
  }

  async function consent (who, cid) {
    const flow = await authorize(cid);
    assert.ok(flow.state, 'not sent to the consent: ' + flow.loc.href);
    const o = await coreRequest.post('/oauth2/authorize/offer').send({ state: flow.state, username: who.username, userToken: who.token });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const granted = o.body.offer.permissions.map(({ currentlyGranted: _c, ...p }) => p);
    const accept = await coreRequest.post('/oauth2/authorize/accept')
      .send({ state: flow.state, username: who.username, userToken: who.token, grantedPermissions: granted, shownDigest: o.body.shownDigest });
    return { flow, offer: o.body, accept };
  }

  async function token (flow, acceptRes) {
    const code = new URL(acceptRes.body.redirectTo).searchParams.get('code');
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: flow.verifier, client_id: flow.cid, redirect_uri: REDIRECT_URI,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    return t.body;
  }

  function refresh (refreshToken, cid) {
    return coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cid });
  }

  it('[OCLV1] maxGrants: the first account is counted once (stamped Non-Validated), a second account is refused at the cap', async () => {
    const first = await newUser();
    const c1 = await consent(first, ids.capped);
    assert.equal(c1.accept.status, 200, JSON.stringify(c1.accept.body));
    assert.deepEqual(c1.offer.client.validation, { level: 'nonValidated' });
    const t = await token(c1.flow, c1.accept);
    const grant = (await coreRequest.get('/' + first.username + '/accesses').set('Authorization', first.token))
      .body.accesses.find((a) => a.name === 'oauth-grant:' + ids.capped);
    assert.deepEqual(grant.clientData.oauth.client, { name: 'Levels app', origin: 'developer', validation: { level: 'nonValidated' } });
    assert.equal(await cv.countLevelGrants(platformDB, ids.capped), 1);
    // The same account again: not counted twice.
    const again = await consent(first, ids.capped);
    assert.equal(again.accept.status, 200, JSON.stringify(again.accept.body));
    assert.equal(await cv.countLevelGrants(platformDB, ids.capped), 1);
    const second = await newUser();
    const c2 = await consent(second, ids.capped);
    assert.equal(c2.accept.status, 403, JSON.stringify(c2.accept.body));
    assert.deepEqual([c2.accept.body.error, c2.accept.body.reason], ['access_denied', 'client-grant-limit']);
    assert.equal(await cv.countLevelGrants(platformDB, ids.capped), 1);
    // The first account's refresh is not capped.
    const r = await refresh(t.refresh_token, ids.capped);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('[OCLV2] consent refuse: refused at /oauth2/authorize, and the refresh of a grant given before the level changed is refused too', async () => {
    const who = await newUser();
    const c = await consent(who, ids.refused);
    assert.equal(c.accept.status, 200, JSON.stringify(c.accept.body));
    const t = await token(c.flow, c.accept);
    // The publisher is validated: Publisher Validated, whose policy here is refuse.
    await cv.setPublisher(platformDB, owners.refused, { status: 'validated', displayName: 'Refused Co' });
    const a = await authorize(ids.refused);
    assert.equal(a.state, null);
    assert.equal(a.loc.origin + a.loc.pathname, REDIRECT_URI);
    assert.deepEqual([a.loc.searchParams.get('error'), a.loc.searchParams.get('error_description')],
      ['unauthorized_client', 'this application is not validated on this platform']);
    const r = await refresh(t.refresh_token, ids.refused);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.deepEqual([r.body.error, r.body.error_description], ['unauthorized_client', 'this application is not validated on this platform']);
    // Refused without touching the token: back to Non-Validated (allowed), the same token refreshes.
    await cv.setPublisher(platformDB, owners.refused, { status: 'pending' });
    const back = await refresh(t.refresh_token, ids.refused);
    assert.equal(back.status, 200, JSON.stringify(back.body));
  });
});
