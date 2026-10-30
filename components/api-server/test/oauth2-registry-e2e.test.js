/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OREG] OAuth 2.0 registry clients end to end: a client registered by the
 * operator (no app account) whose scope grammar comes from an OAuth extension.
 *
 *   GET  /oauth2/authorize        → consent redirect, offer by reference
 *   POST /oauth2/authorize/offer  → the re-derived offer for the consent UI
 *   POST /oauth2/authorize/accept → durable data-grant (no expiry) + session
 *   POST /oauth2/token            → scope echo, subject = the user's id, apiEndpoint
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const oauth2 = require('oauth2');
const storage = require('oauth2/src/storage.ts');

const REDIRECT_URI = 'https://app.registry.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const AUD = 'https://resource.test/base';
const PSEUDONYM_REFUSED = 'pseudonymous subjects are not available on this core';

// Toy grammar: `read/<s>` reads one stream, `write/<s>` contributes to it,
// `add/<s>` may only create in it; `ctx/user` is a context token;
// `ctx/pseudo` asks for a pseudonym.
const LEVEL_OF = { read: 'read', write: 'contribute', add: 'create-only' };
const toyExtension = {
  apiVersion: 1,
  name: 'toy-e2e',
  scopeGrammar: {
    parse (scopeString) {
      const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
      const permissions = [];
      for (const t of tokens) {
        if (t === 'ctx/user' || t === 'ctx/pseudo') continue;
        const slash = t.indexOf('/');
        const level = LEVEL_OF[t.slice(0, slash)];
        // A careless grammar: any stream id the token names, account fields included.
        if (slash <= 0 || level == null) return { ok: false, description: 'unknown token ' + t };
        permissions.push({ streamId: t.slice(slash + 1), level });
      }
      return { ok: true, tokens, offer: { permissions, randomAlias: tokens.includes('ctx/pseudo') } };
    },
    echo ({ permissions, requestedTokens }) {
      return requestedTokens.filter((t) => t === 'ctx/user' ||
        permissions.some((p) => (p.level === 'read' || p.level === 'contribute') && 'read/' + p.streamId === t) ||
        permissions.some((p) => p.level === 'contribute' && 'write/' + p.streamId === t) ||
        permissions.some((p) => (p.level === 'create-only' || p.level === 'contribute') && 'add/' + p.streamId === t));
    },
  },
  tokenResponse: (ctx) => (ctx.scopeTokens.includes('ctx/user') ? { user: ctx.subject } : {}),
};

/** The access id without its version serial. */
function baseOf (accessId) {
  return String(accessId).split(':')[0];
}

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

describe('[OREG] OAuth 2.0 registry clients (extension grammar, no app account)', function () {
  this.timeout(60000);

  let username, personalToken, fixtures, restoreConfig, clientId, wideClientId, writerClientId, pairwiseClientId, userId, platformDB;

  async function registry (id, extra) {
    await oauth2.persistClient(platformDB, {
      clientId: id,
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [AUD],
      subjectType: 'public',
      ...extra,
    });
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = require('test-helpers').injectTestConfigSnapshot({ oauth: { consentUrl: CONSENT_URL } });
    oauth2.extension.setExtension(toyExtension);
    platformDB = require('storages').platformDB;

    username = cuid();
    personalToken = cuid();
    const user = await fixtures.user(username);
    userId = user.attrs.id;
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);
    for (const id of ['health', 'diary']) {
      const res = await coreRequest.post('/' + username + '/streams').set('Authorization', personalToken).send({ id, name: id });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    const ev = await coreRequest.post('/' + username + '/events').set('Authorization', personalToken)
      .send({ streamIds: ['health'], type: 'note/txt', content: 'h1' });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));

    clientId = 'Reg.' + cuid().slice(-10);
    await registry(clientId, {
      scope: ['read/health', 'read/diary', 'write/diary', 'add/diary', 'ctx/user', 'ctx/pseudo'],
      grantTypes: ['authorization_code', 'refresh_token'],
      clientName: 'Registry e2e',
    });
    // A client whose registered scope reaches account fields (a careless
    // grammar or registration): the core must refuse it whatever the grammar says.
    wideClientId = 'Wide.' + cuid().slice(-10);
    await registry(wideClientId, { scope: ['write/:_system:language', 'write/:system:email', 'write/diary'] });
    writerClientId = 'Wr.' + cuid().slice(-10);
    await registry(writerClientId, { scope: ['write/diary'] });
    pairwiseClientId = 'Pw.' + cuid().slice(-10);
    await registry(pairwiseClientId, { scope: ['read/health', 'ctx/user'], subjectType: 'pairwise' });
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of [clientId, wideClientId, writerClientId, pairwiseClientId]) {
      if (id != null) { try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ } }
    }
    if (fixtures != null) await fixtures.clean();
  });

  function authorize (scope, cid = clientId, challenge = 'x'.repeat(43)) {
    return coreRequest.get('/oauth2/authorize').query({
      client_id: cid,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      aud: AUD,
    });
  }

  /** Authorize + offer + accept; returns the accept answer (not asserted). */
  async function consent (scope, cid = clientId, who = { username, token: personalToken }) {
    const { verifier, challenge } = pkce();
    const authRes = await authorize(scope, cid, challenge);
    assert.equal(authRes.status, 302, JSON.stringify(authRes.body) + authRes.text);
    const loc = authRes.headers.location;
    assert.ok(loc.startsWith(CONSENT_URL + '?state='), 'unexpected redirect: ' + loc);
    const signedState = new URL(loc).searchParams.get('state');
    const offerRes = await coreRequest.post('/oauth2/authorize/offer').send({ state: signedState });
    assert.equal(offerRes.status, 200, JSON.stringify(offerRes.body));
    const acceptRes = await coreRequest.post('/oauth2/authorize/accept').send({
      state: signedState, username: who.username, userToken: who.token, grantedPermissions: offerRes.body.offer.permissions,
    });
    return { verifier, offer: offerRes.body, accept: acceptRes };
  }

  function exchange (code, verifier, cid = clientId) {
    return coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: cid, redirect_uri: REDIRECT_URI,
    });
  }

  async function runFlow (scope = 'offline_access read/health ctx/user', cid = clientId, who) {
    const c = await consent(scope, cid, who);
    assert.equal(c.accept.status, 200, JSON.stringify(c.accept.body));
    const code = new URL(c.accept.body.redirectTo).searchParams.get('code');
    const tokenRes = await exchange(code, c.verifier, cid);
    assert.equal(tokenRes.status, 200, JSON.stringify(tokenRes.body));
    return { offer: c.offer, token: tokenRes.body };
  }

  function refresh (refreshToken) {
    return coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  }

  function accessPath (id) {
    return '/' + username + '/accesses/' + encodeURIComponent(id);
  }

  async function grants (cid = clientId) {
    const res = await coreRequest.get('/' + username + '/accesses').set('Authorization', personalToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses.filter((a) => a.name === 'oauth-grant:' + cid);
  }

  let first, second;

  it('[OREG1] the full flow mints a data-grant without alias nor expiry, and a session that reads; the subject is the user id', async () => {
    first = await runFlow();
    const b = first.token;
    assert.deepEqual(b.scope.split(' ').sort(), ['ctx/user', 'offline_access', 'read/health']);
    assert.equal(typeof b.refresh_token, 'string');
    // Fixture users have id === username; [OREG10] covers a registered account.
    assert.equal(b.user, userId);
    assert.ok(typeof b.apiEndpoint === 'string' && b.apiEndpoint.includes(username), 'apiEndpoint: ' + b.apiEndpoint);
    assert.equal(b.id_token, undefined);
    const list = await grants();
    assert.equal(list.length, 1);
    const grant = list[0];
    assert.equal(grant.alias ?? null, null);
    assert.equal(grant.expires ?? null, null);
    assert.deepEqual(grant.permissions, [{ streamId: 'health', level: 'read' }]);

    const read = await coreRequest.get('/' + username + '/events').set('Authorization', b.access_token);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.ok(read.body.events.length > 0 && read.body.events.every((e) => e.streamIds.includes('health')));

    // The session index row: user, client and core, never the token or the username.
    const row = await storage.getSessionIndex(platformDB, b.access_token);
    assert.equal(row.clientId, clientId);
    assert.equal(row.userId, userId);
    assert.equal(row.audience, AUD);
    assert.equal(JSON.stringify(row).includes(b.access_token), false);
  });

  it('[OREG2] re-authorization reuses the same grant and joins the new stream into it', async () => {
    const [before] = await grants();
    second = await runFlow('offline_access read/health read/diary');
    const list = await grants();
    assert.equal(list.length, 1);
    // Same access (a serial suffix marks the new version).
    assert.equal(baseOf(list[0].id), baseOf(before.id));
    assert.deepEqual(list[0].permissions.map((p) => p.streamId + ':' + p.level).sort(), ['diary:read', 'health:read']);
    assert.deepEqual(second.token.scope.split(' ').sort(), ['offline_access', 'read/diary', 'read/health']);
  });

  it('[OREG3] the owner narrows the grant: the refreshed scope narrows with it', async () => {
    const [grant] = await grants();
    const upd = await coreRequest.put(accessPath(grant.id)).set('Authorization', personalToken)
      .send({ permissions: [{ streamId: 'health', level: 'read' }] });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    const res = await refresh(second.token.refresh_token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.scope.split(' ').sort(), ['offline_access', 'read/health']);
    const diary = await coreRequest.get('/' + username + '/events').query({ streams: JSON.stringify(['diary']) }).set('Authorization', res.body.access_token);
    assert.equal(diary.status, 403, JSON.stringify(diary.body));
    second.token.refresh_token = res.body.refresh_token;
  });

  it('[OREG4] withdrawing the grant ends the sessions and the refresh chains', async () => {
    const [grant] = await grants();
    const del = await coreRequest.delete(accessPath(grant.id)).set('Authorization', personalToken);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const read = await coreRequest.get('/' + username + '/events').set('Authorization', first.token.access_token);
    assert.equal(read.status, 403);
    const res = await refresh(second.token.refresh_token);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, 'invalid_grant');
  });

  it('[OREG5] a re-consent at a wider level on a granted stream leaves one entry at that level', async () => {
    await runFlow('read/diary');
    await runFlow('write/diary');
    const list = await grants();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].permissions, [{ streamId: 'diary', level: 'contribute' }]);
  });

  it('[OREG6] read then create-only on one stream: 400 invalid_scope at /accept, the grant is unchanged', async () => {
    const [grant] = await grants();
    assert.equal((await coreRequest.delete(accessPath(grant.id)).set('Authorization', personalToken)).status, 200);
    await runFlow('read/diary');
    const [before] = await grants();
    const c = await consent('add/diary');
    assert.equal(c.accept.status, 400, JSON.stringify(c.accept.body));
    assert.equal(c.accept.body.error, 'invalid_scope');
    const [after] = await grants();
    assert.equal(after.id, before.id, 'no new version');
    assert.deepEqual(after.permissions, [{ streamId: 'diary', level: 'read' }]);
  });

  it('[OREG7] a grammar offering account fields is refused at /authorize; no grant, the account is untouched', async () => {
    const before = await coreRequest.get('/' + username + '/account').set('Authorization', personalToken);
    for (const scope of ['write/:_system:language', 'write/:system:email', 'write/:local::system:email write/diary']) {
      const res = await authorize(scope, wideClientId);
      assert.equal(res.status, 302, res.text);
      const loc = new URL(res.headers.location);
      assert.equal(loc.origin + loc.pathname, REDIRECT_URI, scope + ': ' + res.headers.location);
      assert.equal(loc.searchParams.get('error'), 'invalid_scope', scope);
      assert.match(loc.searchParams.get('error_description'), /account or system stream/, scope);
    }
    assert.equal((await grants(wideClientId)).length, 0);
    const after = await coreRequest.get('/' + username + '/account').set('Authorization', personalToken);
    assert.deepEqual(after.body.account, before.body.account);
  });

  it('[OREG8] positive control: an ordinary stream at contribute still goes through', async () => {
    const r = await runFlow('write/diary', writerClientId);
    const ev = await coreRequest.post('/' + username + '/events').set('Authorization', r.token.access_token)
      .send({ streamIds: ['diary'], type: 'note/txt', content: 'from the app' });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
  });

  it('[OREG9] pseudonymous subjects are refused at /authorize: a pseudonym request, a pairwise client', async () => {
    const before = await grants();
    for (const [scope, cid] of [['read/health ctx/pseudo', clientId], ['read/health ctx/user', pairwiseClientId]]) {
      const res = await authorize(scope, cid);
      assert.equal(res.status, 302, res.text);
      const loc = new URL(res.headers.location);
      assert.equal(loc.origin + loc.pathname, REDIRECT_URI);
      assert.equal(loc.searchParams.get('error'), 'invalid_scope');
      assert.equal(loc.searchParams.get('error_description'), PSEUDONYM_REFUSED);
    }
    assert.deepEqual(await grants(), before);
    assert.equal((await grants(pairwiseClientId)).length, 0);
  });

  it('[OREG10] a registered account: the subject is its internal id, distinct from the username', async () => {
    const name = 'oreg' + cuid().toLowerCase().slice(1, 12);
    const reg = await coreRequest.post('/users').send({
      appId: 'pryv-test',
      username: name,
      password: 'oreg-passw0rd',
      email: name + '@oreg.example.com',
      insurancenumber: String(Math.floor(Math.random() * 90000) + 10000),
      language: 'en',
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const { getUsersRepository } = require('business/src/users/index.ts');
    const usersRepository = await getUsersRepository();
    const id = await usersRepository.getUserIdForUsername(name);
    try {
      assert.notEqual(id, name);
      const login = await coreRequest.post('/' + name + '/auth/login').set('Origin', 'http://test.pryv.local')
        .send({ username: name, password: 'oreg-passw0rd', appId: 'pryv-test' });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      const st = await coreRequest.post('/' + name + '/streams').set('Authorization', login.body.token).send({ id: 'health', name: 'health' });
      assert.equal(st.status, 201, JSON.stringify(st.body));
      const r = await runFlow('read/health ctx/user', clientId, { username: name, token: login.body.token });
      assert.equal(r.token.user, id);
      assert.ok(r.token.apiEndpoint.includes(name), r.token.apiEndpoint);
    } finally {
      await usersRepository.deleteOne(id, name);
    }
  });

  it('[OREG11] the grant withdrawn between consent and code exchange: 400 invalid_grant, the session is gone', async () => {
    const c = await consent('read/health ctx/user');
    assert.equal(c.accept.status, 200, JSON.stringify(c.accept.body));
    const [grant] = await grants();
    const del = await coreRequest.delete(accessPath(grant.id)).set('Authorization', personalToken);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const code = new URL(c.accept.body.redirectTo).searchParams.get('code');
    const res = await exchange(code, c.verifier);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, 'invalid_grant');
    const sessions = (await coreRequest.get('/' + username + '/accesses').set('Authorization', personalToken))
      .body.accesses.filter((a) => a.name === 'oauth:' + clientId);
    assert.deepEqual(sessions, []);
  });
});

describe('[OREGB] OAuth extension loading at boot', function () {
  it('[OREGB1] a configured extension that cannot be loaded fails the mount', function () {
    const mountOAuth2 = require('../src/routes/oauth2.ts').default;
    const values = {
      'customExtensions:oauthExtension': '/nonexistent/oauth-extension.js',
      'customExtensions:defaultFolder': '/nonexistent',
    };
    const app = { config: { get: (k) => values[k] }, storageLayer: {}, api: {} };
    assert.throws(() => mountOAuth2({ get () {}, post () {} }, app), /Cannot load function module/);
  });
});
