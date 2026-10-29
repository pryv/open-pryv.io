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
 *   POST /oauth2/authorize/accept → durable data-grant (alias, no expiry) + session
 *   POST /oauth2/token            → scope echo, id_token (sub = grant alias), no apiEndpoint
 *   POST /oauth2/introspect       → active while the grant lives
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const oauth2 = require('oauth2');
const storage = require('oauth2/src/storage.ts');
const { mintSecret } = require('oauth2/src/clientSecret.ts');
const { ApiEndpoint } = require('utils');

const REDIRECT_URI = 'http://192.168.1.10:8080/app/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const AUD = 'https://resource.test/base';
const RSA_PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });

// Toy grammar: `read/<streamId>` reads one stream; `ctx/user` is a context
// token; `ctx/pseudo` asks for a pseudonym (the grant's alias) instead of the user id.
const toyExtension = {
  apiVersion: 1,
  name: 'toy-e2e',
  scopeGrammar: {
    parse (scopeString) {
      const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
      const permissions = [];
      for (const t of tokens) {
        if (t === 'ctx/user' || t === 'ctx/pseudo') continue;
        // `write/<streamId>`: contribute on any stream the token names, account
        // fields included (a careless grammar the core must not trust).
        if (t.startsWith('write/')) { permissions.push({ streamId: t.slice('write/'.length), level: 'contribute' }); continue; }
        if (!t.startsWith('read/')) return { ok: false, description: 'unknown token ' + t };
        permissions.push({ streamId: t.slice('read/'.length), level: 'read' });
      }
      return { ok: true, tokens, offer: { permissions, randomAlias: tokens.includes('ctx/pseudo') } };
    },
    echo ({ permissions, requestedTokens }) {
      return requestedTokens.filter((t) => t === 'ctx/user' || t === 'ctx/pseudo' ||
        permissions.some((p) => 'read/' + p.streamId === t));
    },
  },
  tokenResponse: (ctx) => (ctx.scopeTokens.includes('ctx/user') ? { user: ctx.subject } : {}),
  introspectionClaims: (ctx) => ({ user: ctx.subject }),
};

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

describe('[OREG] OAuth 2.0 registry clients (extension grammar, no app account)', function () {
  this.timeout(60000);

  let username, personalToken, fixtures, restoreConfig, clientId, rsClientId, rsSecret, wideClientId, writerClientId, pairwiseClientId, userId;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = require('test-helpers').injectTestConfigSnapshot({
      oauth: { consentUrl: CONSENT_URL, signingKeys: [{ kid: 'e2e', alg: 'RS256', privateKeyPem: RSA_PEM }] },
    });
    oauth2.extension.setExtension(toyExtension);

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

    const platformDB = require('storages').platformDB;
    clientId = 'Reg.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, {
      clientId,
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      scope: ['read/health', 'read/diary', 'ctx/user', 'ctx/pseudo'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [AUD],
      clientName: 'Registry e2e',
    });
    rsClientId = 'Rs.' + cuid().slice(-10);
    const secret = await mintSecret();
    rsSecret = secret.plaintext;
    await oauth2.persistClient(platformDB, {
      clientId: rsClientId,
      kind: 'registry',
      redirectUris: ['https://resource.test/unused'],
      scope: ['read/health'],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'client_secret_basic',
      clientSecretHash: secret.hash,
      canIntrospect: true,
    });
    // A client whose registered scope reaches account fields (a careless
    // grammar or registration): the core must refuse it whatever the grammar says.
    wideClientId = 'Wide.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, {
      clientId: wideClientId,
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      scope: ['write/:_system:language', 'write/:system:email', 'write/diary'],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [AUD],
    });
    writerClientId = 'Wr.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, {
      clientId: writerClientId,
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      scope: ['write/diary'],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [AUD],
    });
    pairwiseClientId = 'Pw.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, {
      clientId: pairwiseClientId,
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      scope: ['read/health', 'ctx/user'],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [AUD],
      subjectType: 'pairwise',
    });
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    const platformDB = require('storages').platformDB;
    for (const id of [clientId, rsClientId, wideClientId, writerClientId, pairwiseClientId]) {
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
      nonce: 'nonce-1',
    });
  }

  async function runFlow (scope = 'openid read/health ctx/user ctx/pseudo', cid = clientId, who = { username, token: personalToken }) {
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
    assert.equal(acceptRes.status, 200, JSON.stringify(acceptRes.body));
    const code = new URL(acceptRes.body.redirectTo).searchParams.get('code');

    const tokenRes = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: cid, redirect_uri: REDIRECT_URI,
    });
    assert.equal(tokenRes.status, 200, JSON.stringify(tokenRes.body));
    return { offer: offerRes.body, token: tokenRes.body };
  }

  async function grants () {
    const res = await coreRequest.get('/' + username + '/accesses').set('Authorization', personalToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses.filter((a) => a.name === 'oauth-grant:' + clientId);
  }

  function introspect (token) {
    return coreRequest.post('/oauth2/introspect').type('form')
      .set('Authorization', 'Basic ' + Buffer.from(rsClientId + ':' + rsSecret).toString('base64'))
      .send({ token });
  }

  let first;

  it('[OREG1] the full flow mints a data-grant with an alias and no expiry, and a session that reads', async () => {
    first = await runFlow();
    const b = first.token;
    assert.deepEqual(b.scope.split(' ').sort(), ['ctx/pseudo', 'ctx/user', 'openid', 'read/health']);
    assert.equal(b.apiEndpoint, undefined);
    assert.equal(b.refresh_token, undefined, 'no offline_access requested');
    const list = await grants();
    assert.equal(list.length, 1);
    const grant = list[0];
    assert.equal(typeof grant.alias, 'string');
    assert.equal(grant.expires ?? null, null);
    assert.deepEqual(grant.permissions, [{ streamId: 'health', level: 'read' }]);
    assert.equal(b.user, grant.alias);
    const idToken = JSON.parse(Buffer.from(b.id_token.split('.')[1], 'base64url'));
    assert.equal(idToken.sub, grant.alias);
    assert.notEqual(idToken.sub, username);
    assert.equal(idToken.nonce, 'nonce-1');
    assert.equal(idToken.aud, clientId);

    const read = await coreRequest.get('/' + username + '/events').set('Authorization', b.access_token);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.ok(read.body.events.every((e) => e.streamIds.includes('health')));
  });

  it('[OREG2] re-authorization reuses and widens the same grant and keeps its alias', async () => {
    const again = await runFlow('read/health read/diary ctx/pseudo');
    const list = await grants();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].permissions.map((p) => p.streamId).sort(), ['diary', 'health']);
    const sub = JSON.parse(Buffer.from(first.token.id_token.split('.')[1], 'base64url')).sub;
    assert.equal(list[0].alias, sub);
    assert.deepEqual(again.token.scope.split(' ').sort(), ['ctx/pseudo', 'read/diary', 'read/health']);
  });

  it('[OREG3] introspection: active with the grant alias, then inactive once the grant is withdrawn', async () => {
    const active = await introspect(first.token.access_token);
    assert.equal(active.status, 200, JSON.stringify(active.body));
    assert.equal(active.body.active, true);
    assert.equal(active.body.client_id, clientId);
    assert.equal(active.body.aud, AUD);
    const [grant] = await grants();
    assert.equal(active.body.sub, grant.alias);
    assert.equal(active.body.user, grant.alias);
    // Aliased grant: the API base is built on the alias, never the username, and carries no token.
    assert.equal(active.body.api_base, ApiEndpoint.build(grant.alias));
    assert.ok(!active.body.api_base.includes(username) && !active.body.api_base.includes('@'), active.body.api_base);
    assert.equal(first.token.api_base, undefined);

    const del = await coreRequest.delete('/' + username + '/accesses/' + grant.id).set('Authorization', personalToken);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const after = await introspect(first.token.access_token);
    assert.deepEqual(after.body, { active: false });
    const read = await coreRequest.get('/' + username + '/events').set('Authorization', first.token.access_token);
    assert.equal(read.status, 403);
  });

  let plain;

  it('[OREG5] without a pseudonym the subject is the user id (never the username); apiEndpoint is sent', async () => {
    plain = await runFlow('openid read/health ctx/user');
    const b = plain.token;
    const [grant] = await grants();
    assert.equal(grant.alias ?? null, null);
    // Fixture users have id === username; [OREG10] covers a registered account.
    assert.equal(b.user, userId);
    assert.equal(JSON.parse(Buffer.from(b.id_token.split('.')[1], 'base64url')).sub, userId);
    assert.ok(typeof b.apiEndpoint === 'string' && b.apiEndpoint.includes(username), 'apiEndpoint: ' + b.apiEndpoint);
    const intro = await introspect(b.access_token);
    assert.equal(intro.body.sub, userId);
    // Not aliased: the API base is the apiEndpoint without its token.
    assert.equal(intro.body.api_base, ApiEndpoint.build(username));
    assert.equal(intro.body.api_base, b.apiEndpoint.replace(/\/\/[^@/]+@/, '//'));
    assert.equal(b.api_base, undefined);
  });

  it('[OREG6] switching to a pseudonym withdraws the old grant (its sessions die) and makes an aliased one', async () => {
    const [before] = await grants();
    await runFlow('read/health ctx/pseudo');
    const list = await grants();
    assert.equal(list.length, 1);
    assert.notEqual(list[0].id, before.id);
    assert.equal(typeof list[0].alias, 'string');
    const read = await coreRequest.get('/' + username + '/events').set('Authorization', plain.token.access_token);
    assert.equal(read.status, 403);
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
    const acc = await coreRequest.get('/' + username + '/accesses').set('Authorization', personalToken);
    assert.equal(acc.body.accesses.some((a) => a.name === 'oauth-grant:' + wideClientId), false);
    const after = await coreRequest.get('/' + username + '/account').set('Authorization', personalToken);
    assert.deepEqual(after.body.account, before.body.account);
  });

  it('[OREG8] positive control: an ordinary stream at contribute still goes through', async () => {
    const r = await runFlow('write/diary', writerClientId);
    const ev = await coreRequest.post('/' + username + '/events').set('Authorization', r.token.access_token)
      .send({ streamIds: ['diary'], type: 'note/txt', content: 'from the app' });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
  });

  it('[OREG9] a pairwise client gets an aliased grant without asking for a pseudonym', async () => {
    const r = await runFlow('openid read/health ctx/user', pairwiseClientId);
    const res = await coreRequest.get('/' + username + '/accesses').set('Authorization', personalToken);
    const grant = res.body.accesses.find((a) => a.name === 'oauth-grant:' + pairwiseClientId);
    assert.equal(typeof grant.alias, 'string');
    assert.equal(r.offer.offer.randomAlias, true);
    assert.equal(r.token.user, grant.alias);
    assert.equal(JSON.parse(Buffer.from(r.token.id_token.split('.')[1], 'base64url')).sub, grant.alias);
    assert.equal(r.token.apiEndpoint, undefined);
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
      const r = await runFlow('openid read/health ctx/user', clientId, { username: name, token: login.body.token });
      assert.equal(r.token.user, id);
      assert.equal(JSON.parse(Buffer.from(r.token.id_token.split('.')[1], 'base64url')).sub, id);
      assert.ok(r.token.apiEndpoint.includes(name), r.token.apiEndpoint);
      assert.equal((await introspect(r.token.access_token)).body.sub, id);
    } finally {
      await usersRepository.deleteOne(id, name);
    }
  });

  it('[OREG4] a public client cannot introspect', async () => {
    const res = await coreRequest.post('/oauth2/introspect').type('form')
      .send({ token: 'x', client_id: clientId });
    assert.equal(res.status, 401);
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
