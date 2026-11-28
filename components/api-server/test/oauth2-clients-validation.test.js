/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OCURA] `POST /oauth2/clients/validation` on a real core: an account reads
 * the current validation level of the apps it granted (told by the
 * server-owned stamps of its accesses, never by an access name it chose),
 * and of no other client (an access the owner named, or a shared access an
 * OAuth session created, never counts); a level change since consent shows at
 * once; a request without a personal token (none, wrong, expired, an app's
 * session, a delegation's) or with more than 50 ids is refused.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const oauth2 = require('oauth2');
const storage = require('oauth2/src/storage.ts');
const cv = require('oauth2/src/clientValidation.ts');
const { persistDeveloperClient } = require('oauth2/src/clientRegistry.ts');

const REDIRECT_URI = 'https://app.current-level.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const STATE_KEY = 'test-oauth-state-key-' + 'q1W2e3R4t5'.repeat(2);
const AUD = 'https://resource.test/current-level';

const toyExtension = {
  apiVersion: 1,
  name: 'toy-current-level',
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

describe('[OCURA] OAuth current validation level of the apps an account granted', function () {
  this.timeout(60000);

  let fixtures, restoreConfig, platformDB, who, sessionToken, userFixture;
  const owner = 'own' + cuid().slice(-10);
  const ids = { granted: 'Cvg.' + cuid().slice(-10), other: 'Cvo.' + cuid().slice(-10) };

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = require('test-helpers').injectTestConfigSnapshot({
      oauth: {
        consentUrl: CONSENT_URL,
        stateKey: STATE_KEY,
        audienceBoundSessions: false,
        clientRegistration: { mode: 'delegated', levels: { publisherValidated: { consent: 'refuse' } } },
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
      clientName: 'Current level app',
    };
    await persistDeveloperClient(platformDB, owner, { ...row, clientId: ids.granted });
    await persistDeveloperClient(platformDB, owner, { ...row, clientId: ids.other });

    const username = cuid();
    const token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    const s = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id: 'a', name: 'a' });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    who = { username, token };
    userFixture = user;

    // The account consents to one of the two clients and gets a session.
    const { verifier, challenge } = pkce();
    const a = await coreRequest.get('/oauth2/authorize').query({
      client_id: ids.granted,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'offline_access read/a',
      aud: AUD,
    });
    assert.equal(a.status, 302, a.text);
    const state = new URL(a.headers.location).searchParams.get('state');
    const o = await coreRequest.post('/oauth2/authorize/offer').send({ state, username, userToken: token });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const granted = o.body.offer.permissions.map(({ currentlyGranted: _c, ...p }) => p);
    const accept = await coreRequest.post('/oauth2/authorize/accept')
      .send({ state, username, userToken: token, grantedPermissions: granted, shownDigest: o.body.shownDigest });
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    const code = new URL(accept.body.redirectTo).searchParams.get('code');
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: ids.granted, redirect_uri: REDIRECT_URI,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    sessionToken = t.body.access_token;
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of Object.values(ids)) {
      try { await cv.releaseLevelGrants(platformDB, id); } catch (_) { /* best-effort */ }
      try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
    }
    try { await platformDB.deletePlatformKv('dev-publisher/' + owner); } catch (_) { /* best-effort */ }
    if (fixtures != null) await fixtures.clean();
  });

  function read (body) {
    return coreRequest.post('/oauth2/clients/validation').send(body);
  }

  // An access written storage-side (no API guard), with a session for its token when asked.
  async function storedAccess (attrs, withSession = false) {
    await userFixture.access(attrs);
    if (withSession) await userFixture.session(attrs.token);
  }

  it('[OCURA1] answers the granted client only; a client the account did not grant and an unknown id are left out alike', async () => {
    const res = await read({ username: who.username, userToken: who.token, clientIds: [ids.granted, ids.other, 'unknown-' + cuid().slice(-8)] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.deepEqual(res.body, { clients: { [ids.granted]: { level: 'nonValidated', served: true } } });
  });

  it('[OCURA2] an access the owner names after another client gives no answer for it (only server-owned stamps count)', async () => {
    const made = await coreRequest.post('/' + who.username + '/accesses').set('Authorization', who.token)
      .send({ type: 'app', name: 'oauth-grant:' + ids.other, deviceName: 'oauth-grant', permissions: [{ streamId: 'a', level: 'read' }] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const res = await read({ username: who.username, userToken: who.token, clientIds: [ids.other] });
    assert.deepEqual([res.status, res.body], [200, { clients: {} }]);
  });

  it('[OCURA6] a shared access an OAuth session created (stamped with its dataGrantId) and named after another client gives no answer', async () => {
    // Written storage-side with the stamp accesses.create puts on every access
    // an OAuth session creates; its name is the app's choice.
    const sessionAccess = (await coreRequest.get('/' + who.username + '/accesses').set('Authorization', who.token))
      .body.accesses.find((a) => a.name === 'oauth:' + ids.granted);
    assert.ok(sessionAccess?.clientData?.oauth?.dataGrantId, 'no stamped session found');
    await storedAccess({ type: 'shared', name: 'oauth:' + ids.other, clientData: { oauth: { dataGrantId: sessionAccess.clientData.oauth.dataGrantId } } });
    const listed = (await coreRequest.get('/' + who.username + '/accesses').set('Authorization', who.token))
      .body.accesses.find((a) => a.name === 'oauth:' + ids.other);
    assert.deepEqual([listed?.type, typeof listed?.clientData?.oauth?.dataGrantId], ['shared', 'string'], 'the stamped shared access is not listed as such');
    const res = await read({ username: who.username, userToken: who.token, clientIds: [ids.other, ids.granted] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body.clients), [ids.granted]);
  });

  it('[OCURA7] a token obtained through account delegation is refused (403), an expired personal token too (401)', async () => {
    const delegateToken = 'deleg-' + cuid();
    await storedAccess({
      type: 'personal',
      token: delegateToken,
      name: 'delegation:ocura7-parent@core',
      clientData: { delegation: { kind: 'delegate-pat', relId: 'ocura7-rel', delegate: { username: 'ocura7-parent', hostSlug: 'core' } } },
    }, true);
    let res = await read({ username: who.username, userToken: delegateToken, clientIds: [ids.granted] });
    assert.deepEqual([res.status, res.body.error], [403, 'access_denied'], JSON.stringify(res.body));
    // A personal token whose session is gone (expired): the access alone does not sign in.
    const expiredToken = 'expired-' + cuid();
    await storedAccess({ type: 'personal', token: expiredToken, name: 'ocura7-expired' }, false);
    res = await read({ username: who.username, userToken: expiredToken, clientIds: [ids.granted] });
    assert.equal(res.status, 401, JSON.stringify(res.body));
  });

  it('[OCURA3] a level change since consent shows at the next read: publisher validated under a refused level is not served', async () => {
    await cv.setPublisher(platformDB, owner, { status: 'validated', displayName: 'Current Co' });
    try {
      const res = await read({ username: who.username, userToken: who.token, clientIds: [ids.granted] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.clients[ids.granted], { level: 'publisherValidated', publisher: { name: 'Current Co', validated: true }, served: false });
    } finally {
      await platformDB.deletePlatformKv('dev-publisher/' + owner);
    }
  });

  it('[OCURA4] the token may come in the Authorization header', async () => {
    const res = await coreRequest.post('/oauth2/clients/validation').set('Authorization', who.token)
      .send({ username: who.username, clientIds: [ids.granted] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body.clients), [ids.granted]);
  });

  it('[OCURA5] refuses no token, a wrong token, the app\'s own session token and more than 50 ids', async () => {
    let res = await read({ username: who.username, clientIds: [ids.granted] });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    res = await read({ username: who.username, userToken: 'not-' + cuid(), clientIds: [ids.granted] });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    res = await read({ username: who.username, userToken: sessionToken, clientIds: [ids.granted] });
    assert.deepEqual([res.status, res.body.error], [403, 'access_denied'], JSON.stringify(res.body));
    res = await read({ username: who.username, userToken: who.token, clientIds: Array.from({ length: 51 }, (_, i) => 'c' + i) });
    assert.deepEqual([res.status, res.body.error], [400, 'invalid_request'], JSON.stringify(res.body));
  });
});
