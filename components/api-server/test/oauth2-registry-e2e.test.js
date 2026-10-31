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
 *   POST /oauth2/token            → scope echo, subject = the user's id, apiEndpoint,
 *                                   id_token when openid was granted
 *   GET  /.well-known/openid-configuration, /oauth2/jwks
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
const SIGNING_KEY_PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const STATE_KEY = 'e2e-state-key-'.repeat(3);

/** The payload of a JWT, after checking its RS256 signature against the core's published JWK Set. */
async function verifiedIdToken (jwt) {
  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert.deepEqual(header, { alg: 'RS256', kid: 'e2e-1', typ: 'JWT' });
  const jwks = await coreRequest.get('/oauth2/jwks');
  assert.equal(jwks.status, 200, jwks.text);
  const jwk = jwks.body.keys.find((k) => k.kid === header.kid);
  assert.ok(jwk, 'kid not published');
  const ok = crypto.verify('sha256', Buffer.from(h + '.' + p),
    { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(s, 'base64url'));
  assert.ok(ok, 'id_token signature');
  return JSON.parse(Buffer.from(p, 'base64url').toString());
}

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

// Two-level grammar: `cat/<group>.read` reads every stream of a group,
// `read/<s>` one stream, `write/<s>` contributes to it; `ctx/user` is a
// context token. Its echo names the largest groups the permissions fully
// read, then one `read/<s>` per readable stream no echoed group covers
// (tokens the client may never have requested), so it never understates.
const GROUPS = { 'cat/all': ['health', 'diary', 'notes'], 'cat/vitals': ['health'] };
let twoLevelEchoOverride = null;
const twoLevelExtension = {
  apiVersion: 1,
  name: 'two-level-e2e',
  scopeGrammar: {
    parse (scopeString) {
      const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
      const levels = new Map();
      for (const t of tokens) {
        if (t === 'ctx/user') continue;
        const group = GROUPS[t.replace(/\.read$/, '')];
        const entries = t.endsWith('.read') && group != null
          ? group.map((s) => [s, 'read'])
          : t.startsWith('read/') ? [[t.slice(5), 'read']] : t.startsWith('write/') ? [[t.slice(6), 'contribute']] : null;
        if (entries == null) return { ok: false, description: 'unknown token ' + t };
        for (const [s, l] of entries) if (levels.get(s) !== 'contribute') levels.set(s, l);
      }
      const permissions = [...levels.entries()].map(([streamId, level]) => ({ streamId, level }));
      return { ok: true, tokens, offer: { permissions, allowUserChoice: true } };
    },
    echo (ctx) {
      if (twoLevelEchoOverride != null) return twoLevelEchoOverride(ctx);
      const { permissions, requestedTokens } = ctx;
      const readable = permissions.filter((p) => p.level === 'read' || p.level === 'contribute').map((p) => p.streamId);
      const out = [];
      const named = new Set();
      for (const [g, streams] of Object.entries(GROUPS)) {
        if (streams.every((s) => readable.includes(s)) && streams.some((s) => !named.has(s))) {
          out.push(g + '.read');
          for (const s of streams) named.add(s);
        }
      }
      for (const s of readable) if (!named.has(s)) out.push('read/' + s);
      if (requestedTokens.includes('ctx/user')) out.push('ctx/user');
      return out;
    },
  },
};

/** What a registry grant forbids unless the client row allows it. */
const DEFAULT_FORBIDS = [{ feature: 'webhooks', setting: 'forbidden' }, { feature: 'secretSharing', setting: 'forbidden' }];

/** The stream entries of a permission set, as sorted `id:level`. */
function streamsOf (permissions) {
  return permissions.filter((p) => p.streamId != null).map((p) => p.streamId + ':' + p.level).sort();
}

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

  let username, personalToken, fixtures, restoreConfig, clientId, wideClientId, writerClientId, pairwiseClientId, twoLevelClientId, userId, platformDB;

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
    restoreConfig = require('test-helpers').injectTestConfigSnapshot({
      oauth: { consentUrl: CONSENT_URL, stateKey: STATE_KEY, signingKeys: [{ kid: 'e2e-1', privateKeyPem: SIGNING_KEY_PEM }] },
    });
    oauth2.extension.setExtension(toyExtension);
    platformDB = require('storages').platformDB;

    username = cuid();
    personalToken = cuid();
    const user = await fixtures.user(username);
    userId = user.attrs.id;
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);
    for (const id of ['health', 'diary', 'notes']) {
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
    // Registered with the two-level grammar's vocabulary.
    twoLevelClientId = 'Two.' + cuid().slice(-10);
    await registry(twoLevelClientId, {
      scope: ['cat/all.read', 'ctx/user'],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of [clientId, wideClientId, writerClientId, pairwiseClientId, twoLevelClientId]) {
      if (id != null) { try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ } }
    }
    if (fixtures != null) await fixtures.clean();
  });

  function authorize (scope, cid = clientId, challenge = 'x'.repeat(43), extra = {}) {
    return coreRequest.get('/oauth2/authorize').query({
      client_id: cid,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      aud: AUD,
      ...extra,
    });
  }

  /** Authorize + offer + accept; returns the accept answer (not asserted). */
  // `opts.keep`: filter on the offered permissions (default: keep all);
  // `opts.extra`: more /authorize query parameters (e.g. `nonce`).
  async function consent (scope, cid = clientId, who = { username, token: personalToken }, { keep = null, extra = {} } = {}) {
    const { verifier, challenge } = pkce();
    const authRes = await authorize(scope, cid, challenge, extra);
    assert.equal(authRes.status, 302, JSON.stringify(authRes.body) + authRes.text);
    const loc = authRes.headers.location;
    assert.ok(loc.startsWith(CONSENT_URL + '?state='), 'unexpected redirect: ' + loc);
    const signedState = new URL(loc).searchParams.get('state');
    const offerRes = await coreRequest.post('/oauth2/authorize/offer').send({ state: signedState });
    assert.equal(offerRes.status, 200, JSON.stringify(offerRes.body));
    const offered = offerRes.body.offer.permissions;
    const acceptRes = await coreRequest.post('/oauth2/authorize/accept').send({
      state: signedState, username: who.username, userToken: who.token, grantedPermissions: keep == null ? offered : offered.filter(keep),
    });
    return { verifier, offer: offerRes.body, accept: acceptRes };
  }

  function exchange (code, verifier, cid = clientId) {
    return coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: cid, redirect_uri: REDIRECT_URI,
    });
  }

  async function runFlow (scope = 'offline_access read/health ctx/user', cid = clientId, who, opts = {}) {
    const c = await consent(scope, cid, who, opts);
    assert.equal(c.accept.status, 200, JSON.stringify(c.accept.body));
    const code = new URL(c.accept.body.redirectTo).searchParams.get('code');
    const tokenRes = await exchange(code, c.verifier, cid);
    assert.equal(tokenRes.status, 200, JSON.stringify(tokenRes.body));
    return { offer: c.offer, token: tokenRes.body };
  }

  function refresh (refreshToken, cid = clientId) {
    return coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cid });
  }

  async function sessionsOf (cid) {
    const res = await coreRequest.get('/' + username + '/accesses').set('Authorization', personalToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses.filter((a) => a.name === 'oauth:' + cid);
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

  it('[OREG1] the full flow mints a data-grant without alias nor expiry, and a session that reads; the subject is the user id, in the id_token too', async () => {
    const before = Math.floor(Date.now() / 1000);
    first = await runFlow('openid offline_access read/health ctx/user', clientId, undefined, { extra: { nonce: 'nonce-' + cuid() } });
    const b = first.token;
    assert.deepEqual(b.scope.split(' ').sort(), ['ctx/user', 'offline_access', 'openid', 'read/health']);
    assert.equal(typeof b.refresh_token, 'string');
    // Fixture users have id === username; [OREG10] covers a registered account.
    assert.equal(b.user, userId);
    assert.ok(typeof b.apiEndpoint === 'string' && b.apiEndpoint.includes(username), 'apiEndpoint: ' + b.apiEndpoint);
    const idToken = await verifiedIdToken(b.id_token);
    assert.equal(idToken.sub, userId);
    assert.equal(idToken.aud, clientId);
    assert.equal(idToken.azp, clientId);
    assert.match(idToken.nonce, /^nonce-/);
    assert.equal(idToken.exp - idToken.iat, 300);
    assert.ok(idToken.iat >= before, 'iat');
    // auth_time: the sign-in of the personal token, never after the consent.
    assert.ok(Number.isInteger(idToken.auth_time) && idToken.auth_time <= idToken.iat, 'auth_time ' + idToken.auth_time);
    const discovery = await coreRequest.get('/.well-known/openid-configuration');
    assert.equal(idToken.iss, discovery.body.issuer);
    const list = await grants();
    assert.equal(list.length, 1);
    const grant = list[0];
    assert.equal(grant.alias ?? null, null);
    assert.equal(grant.expires ?? null, null);
    assert.deepEqual(grant.permissions, [{ streamId: 'health', level: 'read' }, ...DEFAULT_FORBIDS]);

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
    assert.deepEqual(streamsOf(list[0].permissions), ['diary:read', 'health:read']);
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

  it('[OREG5] a re-consent at a wider level on a granted stream leaves one entry at that level; the id_token subject is stable', async () => {
    const r1 = await runFlow('openid read/diary');
    const r2 = await runFlow('openid write/diary');
    const list = await grants();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].permissions, [{ streamId: 'diary', level: 'contribute' }, ...DEFAULT_FORBIDS]);
    assert.equal((await verifiedIdToken(r1.token.id_token)).sub, userId);
    assert.equal((await verifiedIdToken(r2.token.id_token)).sub, userId);
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
    assert.deepEqual(after.permissions, [{ streamId: 'diary', level: 'read' }, ...DEFAULT_FORBIDS]);
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

  it('[OREG12] the grant is stamped with its client by the server; the owner cannot change that stamp', async () => {
    const [grant] = await grants();
    assert.deepEqual(grant.clientData?.oauth, { grantOf: clientId });
    for (const clientData of [{ oauth: { grantOf: 'someone-else' } }, { oauth: null }, null]) {
      const res = await coreRequest.put(accessPath(grant.id)).set('Authorization', personalToken).send({ clientData });
      assert.equal(res.status, 403, JSON.stringify(clientData) + ': ' + JSON.stringify(res.body));
    }
    const [after] = await grants();
    assert.deepEqual(after.clientData?.oauth, { grantOf: clientId });
    // Sessions are minted by the system, linked to the grant.
    const sessions = (await coreRequest.get('/' + username + '/accesses').set('Authorization', personalToken))
      .body.accesses.filter((a) => a.name === 'oauth:' + clientId);
    assert.ok(sessions.length > 0);
    for (const s of sessions) {
      assert.equal(s.createdBy, 'system');
      assert.equal(s.clientData?.oauth?.dataGrantId, baseOf(grant.id));
    }
  });

  it('[OREG9] pseudonymous subjects are refused at /authorize: a pseudonym request, a pairwise client', async () => {
    const before = await grants();
    for (const [scope, cid] of [['read/health ctx/pseudo', clientId], ['openid read/health ctx/pseudo', clientId],
      ['read/health ctx/user', pairwiseClientId], ['openid read/health ctx/user', pairwiseClientId]]) {
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

  it('[OREG10] a registered account: the subject is its internal id, distinct from the username; auth_time stays at the first sign-in across a second login', async () => {
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
      assert.ok(r.token.apiEndpoint.includes(name), r.token.apiEndpoint);
      const idToken = await verifiedIdToken(r.token.id_token);
      assert.equal(idToken.sub, id);
      assert.notEqual(idToken.sub, name);
      assert.equal(Object.hasOwn(idToken, 'nonce'), false);
      // auth_time is the creation of the personal access (its first sign-in).
      assert.ok(Math.abs(idToken.auth_time - Math.floor(Date.now() / 1000)) < 120, 'auth_time ' + idToken.auth_time);
      assert.ok(!JSON.stringify(idToken).includes(name), 'the username is in no claim');

      // A later sign-in to the same app keeps that access (and its creation
      // time): auth_time is a lower bound, unchanged by the second login.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const relogin = await coreRequest.post('/' + name + '/auth/login').set('Origin', 'http://test.pryv.local')
        .send({ username: name, password: 'oreg-passw0rd', appId: 'pryv-test' });
      assert.equal(relogin.status, 200, JSON.stringify(relogin.body));
      const again = await runFlow('openid read/health ctx/user', clientId, { username: name, token: relogin.body.token });
      const idToken2 = await verifiedIdToken(again.token.id_token);
      assert.equal(idToken2.auth_time, idToken.auth_time);
      assert.ok(idToken2.iat > idToken2.auth_time, 'the second consent comes after the first sign-in');
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

  it('[OREG13] partial consent: the scope names the narrowed and per-stream tokens the session holds (unrequested), at the exchange and at refresh; sent back, it re-derives the same offer', async () => {
    oauth2.extension.setExtension(twoLevelExtension);
    try {
      const r = await runFlow('offline_access cat/all.read ctx/user', twoLevelClientId, undefined, { keep: (p) => p.streamId !== 'notes' });
      assert.deepEqual(r.token.scope.split(' ').sort(), ['cat/vitals.read', 'ctx/user', 'offline_access', 'read/diary']);
      const info = await coreRequest.get('/' + username + '/access-info').set('Authorization', r.token.access_token);
      assert.equal(info.status, 200, JSON.stringify(info.body));
      // The data streams the session holds (access-info adds the session's own audit stream and the account mask).
      const held = streamsOf(info.body.permissions.filter((p) => !String(p.streamId ?? '').startsWith(':')));
      assert.deepEqual(held, ['diary:read', 'health:read']);

      const res = await refresh(r.token.refresh_token, twoLevelClientId);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.scope.split(' ').sort(), r.token.scope.split(' ').sort());

      // Round trip: the answered scope, sent back to /authorize, offers what the session holds.
      const authRes = await authorize(res.body.scope, twoLevelClientId);
      assert.equal(authRes.status, 302, authRes.text);
      const signedState = new URL(authRes.headers.location).searchParams.get('state');
      assert.ok(signedState, 'not sent to consent: ' + authRes.headers.location);
      const offerRes = await coreRequest.post('/oauth2/authorize/offer').send({ state: signedState });
      assert.equal(offerRes.status, 200, JSON.stringify(offerRes.body));
      assert.deepEqual(streamsOf(offerRes.body.offer.permissions), held);
    } finally {
      oauth2.extension.setExtension(toyExtension);
    }
  });

  it('[OREG14] an echo claiming a stream or a level the session does not hold: 500 at the exchange (session removed) and at refresh; the refresh token works again once the grammar is fixed', async () => {
    oauth2.extension.setExtension(twoLevelExtension);
    try {
      const good = await runFlow('offline_access cat/all.read ctx/user', twoLevelClientId);
      for (const beyond of [['cat/all.read', 'read/elsewhere'], ['cat/all.read', 'write/diary']]) {
        twoLevelEchoOverride = () => beyond;
        // Code exchange: refused, the session minted at /accept is removed.
        const before = (await sessionsOf(twoLevelClientId)).map((s) => s.id).sort();
        const c = await consent('offline_access cat/all.read ctx/user', twoLevelClientId);
        assert.equal(c.accept.status, 200, JSON.stringify(c.accept.body));
        const code = new URL(c.accept.body.redirectTo).searchParams.get('code');
        const tok = await exchange(code, c.verifier, twoLevelClientId);
        assert.equal(tok.status, 500, JSON.stringify(tok.body));
        assert.equal(tok.body.error, 'server_error');
        assert.equal(tok.body.error_description, 'failed to build the token response');
        assert.deepEqual((await sessionsOf(twoLevelClientId)).map((s) => s.id).sort(), before);
        // Refresh: refused, nothing burned.
        const rt = await refresh(good.token.refresh_token, twoLevelClientId);
        assert.equal(rt.status, 500, JSON.stringify(rt.body));
        assert.equal(rt.body.error, 'server_error');
        assert.deepEqual((await sessionsOf(twoLevelClientId)).map((s) => s.id).sort(), before);
      }
      twoLevelEchoOverride = null;
      const fixed = await refresh(good.token.refresh_token, twoLevelClientId);
      assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
      assert.deepEqual(fixed.body.scope.split(' ').sort(), ['cat/all.read', 'ctx/user', 'offline_access']);
    } finally {
      twoLevelEchoOverride = null;
      oauth2.extension.setExtension(toyExtension);
    }
  });

  it('[OREG15] OpenID Connect: discovery and JWK Set published; a refresh answers no id_token; a nonce is accepted once', async () => {
    const conf = await coreRequest.get('/.well-known/openid-configuration');
    assert.equal(conf.status, 200, conf.text);
    // Pseudonymous subjects are not served yet: only `public` is advertised.
    assert.deepEqual(conf.body.subject_types_supported, ['public']);
    assert.deepEqual(conf.body.id_token_signing_alg_values_supported, ['RS256']);
    assert.equal(conf.body.jwks_uri, conf.body.issuer + '/oauth2/jwks');
    assert.ok(conf.body.scopes_supported.includes('openid'));
    const jwks = await coreRequest.get('/oauth2/jwks');
    assert.deepEqual(jwks.body.keys.map((k) => Object.keys(k).sort()), [['alg', 'e', 'kid', 'kty', 'n', 'use']]);

    const nonce = 'once-' + cuid();
    const r = await runFlow('openid offline_access read/health', clientId, undefined, { extra: { nonce } });
    assert.equal((await verifiedIdToken(r.token.id_token)).nonce, nonce);
    const refreshed = await refresh(r.token.refresh_token);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.ok(refreshed.body.scope.split(' ').includes('openid'));
    assert.equal(refreshed.body.id_token, undefined);
    // The same nonce again: refused before the consent screen.
    const again = await authorize('openid read/health', clientId, 'x'.repeat(43), { nonce });
    const loc = new URL(again.headers.location);
    assert.equal(loc.origin + loc.pathname, REDIRECT_URI);
    assert.equal(loc.searchParams.get('error'), 'invalid_request');
    assert.equal(loc.searchParams.get('error_description'), 'nonce already used');
  });

  it('[OREG16] with oauth.stateKey set, a consent state signed with the admin key is refused', async () => {
    const authRes = await authorize('read/health');
    const signed = new URL(authRes.headers.location).searchParams.get('state');
    const { verifyState, signState } = require('oauth2/src/signedState.ts');
    const payload = verifyState(STATE_KEY, signed).payload;
    assert.ok(payload != null, 'the state is keyed on oauth.stateKey');
    const config = require('@pryv/boiler').getConfigUnsafe(true);
    const forged = signState(config.get('auth:adminAccessKey'), payload);
    const res = await coreRequest.post('/oauth2/authorize/offer').send({ state: forged });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error_description, 'signed state bad_signature');
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
