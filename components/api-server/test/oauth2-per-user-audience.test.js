/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [OPUE] per-user resource addresses end to end: a registry client lists
 * `https://{username}.example.com/adapter/calendar/api`; an authorization for
 * `https://<name>.example.com/adapter/calendar/api` is accepted on its shape,
 * bound at consent to the signed-in account, then carried as a plain
 * audience (code, refresh, session, introspection, data API, exchange).
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as oauth2 from 'oauth2';
import * as storage from 'oauth2/src/storage.ts';
import { mintSecret } from 'oauth2/src/clientSecret.ts';
import * as storages from 'storages';
import { injectTestConfigSnapshot, withInjectedConfig } from 'test-helpers';
import { getUsersRepository } from 'business/src/users/index.ts';

const REDIRECT_URI = 'https://app.per-user.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const STATE_KEY = 'test-oauth-state-key-' + 'p3rUs3rAdd'.repeat(2);
const TEMPLATE = 'https://{username}.example.com/adapter/calendar/api';
const at = (name) => 'https://' + name + '.example.com/adapter/calendar/api';
const REGION = at('auth-x');
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const OAUTH = { consentUrl: CONSENT_URL, stateKey: STATE_KEY };
const MISMATCH = { error: 'access_denied', error_description: 'the requested resource names another account\'s address', reason: 'audience-account-mismatch' };

const LEVEL_OF = { read: 'read', write: 'contribute' };
const toyExtension = {
  apiVersion: 1,
  name: 'toy-per-user',
  scopeGrammar: {
    parse (scopeString) {
      const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
      const permissions = [];
      for (const t of tokens) {
        const slash = t.indexOf('/');
        const level = LEVEL_OF[t.slice(0, slash)];
        if (slash <= 0 || level == null) return { ok: false, description: 'unknown token ' + t };
        permissions.push({ streamId: t.slice(slash + 1), level });
      }
      return { ok: true, tokens, offer: { permissions, allowUserChoice: true } };
    },
    echo ({ permissions, requestedTokens }) {
      return requestedTokens.filter((t) => {
        const [kind, s] = t.split('/');
        return permissions.some((p) => p.streamId === s && (kind === 'read' || p.level === 'contribute'));
      });
    },
  },
};

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** Run `body` while recording the OAuth audit rows (the debug channel the audit helper writes first). */
async function auditRows (body) {
  const rows = [];
  const saved = process.env.OAUTH_AUDIT_DEBUG;
  const debug = console.debug;
  process.env.OAUTH_AUDIT_DEBUG = '1';
  console.debug = (tag, event, payload) => { if (tag === '[oauth.audit]') rows.push({ event, payload }); };
  try {
    await body();
  } finally {
    console.debug = debug;
    if (saved == null) delete process.env.OAUTH_AUDIT_DEBUG; else process.env.OAUTH_AUDIT_DEBUG = saved;
  }
  return rows;
}

describe('[OPUE] OAuth per-user resource addresses end to end', function () {
  this.timeout(90000);

  let fixtures, restoreConfig, platformDB, tplId, mixId, anyId, rsId, rsSecret;
  const clientIds = [];

  async function register (prefix, extra) {
    const clientId = prefix + '.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, {
      clientId,
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [TEMPLATE],
      subjectType: 'public',
      scope: ['read/a', 'write/a'],
      ...extra,
    });
    clientIds.push(clientId);
    return clientId;
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = injectTestConfigSnapshot({ oauth: OAUTH });
    oauth2.extension.setExtension(toyExtension);
    platformDB = storages.platformDB;
    rsSecret = await mintSecret();
    tplId = await register('PerUser');
    mixId = await register('Mixed', { allowedAudiences: [REGION, TEMPLATE] });
    anyId = await register('AnyAud', { allowedAudiences: [], anyAudience: true });
    rsId = await register('PerUserRs', {
      tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash, canExchange: true, canIntrospect: true,
    });
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of clientIds) {
      try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
    }
    if (fixtures != null) await fixtures.clean();
  });

  async function newUser (username = cuid()) {
    const token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    const s = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id: 'a', name: 'a' });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    return { username, token, userId: user.attrs.id };
  }

  async function authorize (cid, resource, extra = {}) {
    const { verifier, challenge } = pkce();
    const res = await coreRequest.get('/oauth2/authorize').query({
      client_id: cid,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'offline_access read/a',
      ...(resource != null ? { resource } : {}),
      ...extra,
    });
    assert.equal(res.status, 302, res.text);
    const location = new URL(res.headers.location);
    assert.ok(location.href.startsWith(CONSENT_URL), 'to the consent page: ' + location.href);
    return { state: location.searchParams.get('state'), verifier };
  }

  function offer (who, state) {
    return coreRequest.post('/oauth2/authorize/offer').send({ state, username: who.username, userToken: who.token });
  }

  function accept (who, state, shownDigest) {
    return coreRequest.post('/oauth2/authorize/accept')
      .send({ state, username: who.username, userToken: who.token, grantedPermissions: [{ streamId: 'a', level: 'read' }], ...(shownDigest != null ? { shownDigest } : {}) });
  }

  /** Authorization, consent and code exchange; the token response. */
  async function connect (who, cid, resource, { tokenResource, extra } = {}) {
    const { state, verifier } = await authorize(cid, resource, extra);
    const o = await offer(who, state);
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const a = await accept(who, state, o.body.shownDigest);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code',
      code: new URL(a.body.redirectTo).searchParams.get('code'),
      code_verifier: verifier,
      client_id: cid,
      redirect_uri: REDIRECT_URI,
      ...(tokenResource != null ? { resource: tokenResource } : {}),
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    return t.body;
  }

  const basicRs = () => 'Basic ' + Buffer.from(rsId + ':' + rsSecret.plaintext).toString('base64');

  function introspect (token) {
    return coreRequest.post('/oauth2/introspect').type('form').set('Authorization', basicRs()).send({ token });
  }

  function exchange (subjectToken, body = {}) {
    return coreRequest.post('/oauth2/token').type('form').set('Authorization', basicRs())
      .send({ grant_type: TOKEN_EXCHANGE, subject_token: subjectToken, subject_token_type: ACCESS_TOKEN_TYPE, ...body });
  }

  async function accesses (who) {
    const res = await coreRequest.get('/' + who.username + '/accesses').set('Authorization', who.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses;
  }

  async function rowOf (who, token) {
    return (await accesses(who)).find((a) => a.token === token) ?? null;
  }

  async function grantsOf (who, cid) {
    return (await accesses(who)).filter((a) => a.name === 'oauth-grant:' + cid || a.name === 'oauth:' + cid);
  }

  it('[OPUE1] the account\'s own address: consent, code exchange (with and without resource), introspection aud, the session stamp, refresh, the data API flag', async () => {
    const alice = await newUser();
    const mine = at(alice.username);
    const t = await connect(alice, tplId, mine);
    const t2 = await connect(alice, tplId, 'https://' + alice.username.toUpperCase() + '.EXAMPLE.COM/adapter/calendar/api/', { tokenResource: mine });
    const info = await introspect(t.access_token);
    assert.deepEqual([info.status, info.body.active, info.body.aud], [200, true, mine]);
    assert.equal((await introspect(t2.access_token)).body.aud, mine, 'stored in the registered spelling');
    assert.equal((await rowOf(alice, t.access_token)).clientData.oauth.audience, mine);
    const r = await coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: tplId, resource: mine });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await rowOf(alice, r.body.access_token)).clientData.oauth.audience, mine);
    const read = (token) => coreRequest.get('/' + alice.username + '/events').query({ streams: JSON.stringify(['a']) }).set('Authorization', token);
    assert.equal((await read(r.body.access_token)).status, 200);
    await withInjectedConfig({ oauth: { ...OAUTH, audienceBoundSessions: true } }, async () => {
      assert.equal((await read(r.body.access_token)).status, 403);
    });
  });

  it('[OPUE2] another account signs in for alice\'s address: /offer and /accept answer 403 audience-account-mismatch, nothing is written, the audit names no one', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const { state } = await authorize(tplId, at(alice.username));
    let o, a;
    const rows = await auditRows(async () => {
      o = await offer(bob, state);
      a = await accept(bob, state);
    });
    for (const res of [o, a]) {
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.deepEqual(res.body, MISMATCH);
    }
    assert.deepEqual(await grantsOf(bob, tplId), [], 'no grant, no session');
    const refused = rows.filter((x) => x.event === 'oauth.consent.refused');
    assert.equal(refused.length, 2);
    assert.ok(refused.every((x) => x.payload.reason === 'audience-account-mismatch' && x.payload.userId == null));
    const text = JSON.stringify(rows);
    assert.ok(!text.includes(alice.username) && !text.includes(bob.username), 'no username in the audit rows');
  });

  it('[OPUE3] a region-shaped label on a per-user-only row is refused at consent; listed exactly beside the per-user entry, it binds no account', async () => {
    const bob = await newUser();
    const { state } = await authorize(tplId, REGION);
    assert.deepEqual((await accept(bob, state)).body, MISMATCH);
    const t = await connect(bob, mixId, REGION);
    assert.equal((await introspect(t.access_token)).body.aud, REGION);
  });

  it('[OPUE5] an any-audience row: a per-user-shaped value is stored as given and bound to nobody', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const t = await connect(bob, anyId, at(alice.username));
    assert.equal((await introspect(t.access_token)).body.aud, at(alice.username));
  });

  it('[OPUE6] a username change: the chain keeps its address; a new consent at the former address is refused, at the new one accepted', async () => {
    const alice = await newUser();
    const former = alice.username;
    const t = await connect(alice, tplId, at(former));
    const renamed = 'rn' + cuid().slice(-12);
    const repository = await getUsersRepository();
    await repository.changeUsername(alice.userId, former, renamed, 'system');
    const now = { ...alice, username: renamed };
    const r = await coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: tplId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await introspect(r.body.access_token)).body.aud, at(former));
    const { state } = await authorize(tplId, at(former));
    assert.deepEqual((await accept(now, state)).body, MISMATCH);
    const fresh = await connect(now, tplId, at(renamed));
    assert.equal((await introspect(fresh.access_token)).body.aud, at(renamed));
  });

  it('[OPUE8] login_hint binds nothing: alice at her own address with login_hint naming someone else is accepted', async () => {
    const alice = await newUser();
    const t = await connect(alice, tplId, at(alice.username), { extra: { login_hint: 'someone-else' } });
    assert.equal((await introspect(t.access_token)).body.aud, at(alice.username));
  });

  it('[OPUE10] a name the platform answers itself (static entry, hosted site, core id) is no account\'s address, even for an account under that name', async () => {
    for (const kind of ['staticEntry', 'hostedSite', 'coreId']) {
      const name = 'svc-' + kind.toLowerCase() + '-' + cuid().slice(-6);
      const holder = await newUser(name);
      const overrides = kind === 'staticEntry'
        ? { dns: { staticEntries: { [name]: { ip: '127.0.0.1' } } } }
        : kind === 'hostedSite' ? { hostedSites: { [name]: { static: '/tmp' } } } : { core: { id: name } };
      const { state } = await authorize(tplId, at(name));
      await withInjectedConfig(overrides, async () => {
        const o = await offer(holder, state);
        assert.deepEqual([o.status, o.body], [403, MISMATCH], kind + ': ' + JSON.stringify(o.body));
        const a = await accept(holder, state);
        assert.deepEqual([a.status, a.body], [403, MISMATCH], kind + ': ' + JSON.stringify(a.body));
      });
      assert.deepEqual(await grantsOf(holder, tplId), [], kind + ': nothing written');
    }
  });

  it('[OPUX11] the exchange of a per-user token: with subject_token_resource naming the address, the same derived token; naming another, invalid_target', async () => {
    const alice = await newUser();
    const t = await connect(alice, tplId, at(alice.username));
    const x = await exchange(t.access_token);
    assert.equal(x.status, 200, JSON.stringify(x.body));
    const again = await exchange(t.access_token, { subject_token_resource: at(alice.username) + '/' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.access_token, x.body.access_token);
    const elsewhere = await exchange(t.access_token, { subject_token_resource: at('someone-else') });
    assert.deepEqual([elsewhere.status, elsewhere.body], [400, {
      error: 'invalid_target', error_description: 'the subject token was not issued for the resource it was presented at',
    }]);
    const derived = await introspect(x.body.access_token);
    assert.equal(derived.body.aud, undefined, 'the derived token has no audience');
  });
});
