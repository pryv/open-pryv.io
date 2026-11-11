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
import { isDeepStrictEqual } from 'node:util';
import * as oauth2 from 'oauth2';
import * as storage from 'oauth2/src/storage.ts';
import { mintSecret } from 'oauth2/src/clientSecret.ts';
import * as storages from 'storages';
import { injectTestConfigSnapshot, withInjectedConfig } from 'test-helpers';
import { getUsersRepository } from 'business/src/users/index.ts';
import { getPlatform } from 'platform';

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
const HELD = { error: 'access_denied', error_description: 'the requested address is one of this account\'s address aliases, already used by another app', reason: 'address-alias-held' };

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
    // The chain made at the former address keeps exchanging (the account still holds the name).
    for (const body of [{}, { subject_token_resource: at(former) }]) {
      const x = await exchange(r.body.access_token, body);
      assert.equal(x.status, 200, JSON.stringify(x.body));
      const read = await coreRequest.get('/' + renamed + '/events').query({ streams: JSON.stringify(['a']) }).set('Authorization', x.body.access_token);
      assert.equal(read.status, 200, JSON.stringify(read.body));
    }
    // Signing in with the former name binds the current one (the canonical name is compared).
    const viaFormer = await connect({ ...alice, username: former }, tplId, at(renamed));
    assert.equal((await introspect(viaFormer.access_token)).body.aud, at(renamed));
    const { state: stale } = await authorize(tplId, at(former));
    assert.deepEqual((await accept({ ...alice, username: former }, stale)).body, MISMATCH);
  });

  it('[OPUE15] an access alias the account holds is no former username: a session whose audience names it is not exchanged', async () => {
    const alice = await newUser();
    const t = await connect(alice, tplId, at(alice.username));
    const minted = await coreRequest.post('/' + alice.username + '/accesses').set('Authorization', alice.token)
      .send({ name: 'opue15 aliased', type: 'shared', randomAlias: true, permissions: [{ streamId: 'a', level: 'read' }] });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const alias = minted.body.access.alias;
    const row = await storage.getSessionIndex(platformDB, t.access_token);
    // A row written otherwise than by a consent: its audience names the alias.
    await storage.setSessionIndex(platformDB, t.access_token, { ...row, audience: at(alias) });
    let x;
    const rows = await auditRows(async () => { x = await exchange(t.access_token); });
    assert.deepEqual([x.status, x.body.error], [400, 'invalid_grant'], JSON.stringify(x.body));
    assert.ok(rows.some((r) => r.event === 'oauth.token.exchange_refused' && r.payload.reason === 'audience-account-mismatch'), JSON.stringify(rows));
    // Control: the same session at the account's own address is exchanged.
    await storage.setSessionIndex(platformDB, t.access_token, row);
    const ok = await exchange(t.access_token);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it('[OPUE8] login_hint binds nothing: alice at her own address with login_hint naming someone else is accepted', async () => {
    const alice = await newUser();
    const t = await connect(alice, tplId, at(alice.username), { extra: { login_hint: 'someone-else' } });
    assert.equal((await introspect(t.access_token)).body.aud, at(alice.username));
  });

  it('[OPUE10] a name the platform answers itself (static entry, hosted site, core id) is no account\'s address, even for an account under that name', async () => {
    // The configured names are read once at boot: a name added after it reaches the predicate
    // through the platform's names (refreshed here, as after a /reg/records change or on its timer).
    const platform = await getPlatform();
    const coreId = String(platform.coreId);
    for (const kind of ['staticEntry', 'hostedSite', 'coreId']) {
      const name = kind === 'coreId' ? coreId : 'svc-' + kind.toLowerCase() + '-' + cuid().slice(-6);
      const holder = await newUser(name);
      const overrides = kind === 'staticEntry'
        ? { dns: { staticEntries: { [name]: { ip: '127.0.0.1' } } } }
        : kind === 'hostedSite' ? { hostedSites: { [name]: { static: '/tmp' } } } : {};
      const { state } = await authorize(tplId, at(name));
      try {
        await withInjectedConfig(overrides, async () => {
          await platform.refreshPlatformNames();
          const o = await offer(holder, state);
          assert.deepEqual([o.status, o.body], [403, MISMATCH], kind + ': ' + JSON.stringify(o.body));
          const a = await accept(holder, state);
          assert.deepEqual([a.status, a.body], [403, MISMATCH], kind + ': ' + JSON.stringify(a.body));
        });
      } finally {
        await platform.refreshPlatformNames();
      }
      assert.deepEqual(await grantsOf(holder, tplId), [], kind + ': nothing written');
    }
  });

  it('[OPUE13] the client\'s list no longer holds the authorization\'s audience (a per-user entry or an exact one removed meanwhile): refused at /offer and /accept, nothing written', async () => {
    const alice = await newUser();
    const notListed = [400, 'invalid_target', 'audience-not-listed'];
    for (const [before, after, resource, expected] of [
      [[TEMPLATE], [REGION], at(alice.username), notListed],
      [[REGION], ['https://rs.example.com/other'], REGION, notListed],
      // The exact entry removed, the per-user one kept: the region address now reads as a label, and binds no account.
      [[REGION, TEMPLATE], [TEMPLATE], REGION, [403, 'access_denied', 'audience-account-mismatch']],
    ]) {
      // Through the registry: the new client version already ends the flow (the consent is pinned to it).
      const edited = await register('Edited', { allowedAudiences: before });
      const pinned = await authorize(edited, resource);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await oauth2.persistClient(platformDB, { ...(await storage.getClient(platformDB, edited)), allowedAudiences: after });
      const restart = await accept(alice, pinned.state);
      assert.deepEqual([restart.status, restart.body.error], [400, 'invalid_request'], JSON.stringify(restart.body));
      // A row whose list changed under the same version (a write outside the registry): the binding's own check.
      const cid = await register('Narrowed', { allowedAudiences: before });
      const { state } = await authorize(cid, resource);
      const row = await storage.getClient(platformDB, cid);
      await storage.setClient(platformDB, { ...row, allowedAudiences: after });
      let o, a;
      const rows = await auditRows(async () => {
        o = await offer(alice, state);
        a = await accept(alice, state);
      });
      for (const res of [o, a]) {
        assert.deepEqual([res.status, res.body.error, res.body.reason], expected, JSON.stringify(res.body));
      }
      const refused = rows.filter((x) => x.event === 'oauth.consent.refused');
      assert.equal(refused.length, 2);
      assert.ok(refused.every((x) => x.payload.reason === expected[2]));
      assert.ok(!JSON.stringify(rows).includes(alice.username), 'no username in the audit rows');
      assert.deepEqual(await grantsOf(alice, cid), [], 'no grant, no session');
      assert.deepEqual(await grantsOf(alice, edited), [], 'no grant, no session');
    }
  });

  async function mintAddressAlias (who) {
    const res = await coreRequest.post('/' + who.username + '/account/address-aliases').set('Authorization', who.token).send({});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.addressAlias.alias;
  }

  async function addressAliasesOf (who) {
    const res = await coreRequest.get('/' + who.username + '/account/address-aliases').set('Authorization', who.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.addressAliases;
  }

  const registryGrantOf = async (who, cid) => (await accesses(who)).find((a) => a.name === 'oauth-grant:' + cid) ?? null;

  it('[OPUE9] an unheld address alias: the consent adopts it (a public client too), the grant and its sessions carry it, the token works at that address; another client, another account\'s alias: refused', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const alias = await mintAddressAlias(alice);
    const { state, verifier } = await authorize(tplId, at(alias));
    const o = await offer(alice, state);
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.equal(o.body.addressAlias, alias);
    assert.equal(o.body.offer.randomAlias, true, 'the app sees a pseudonym');
    const a = await accept(alice, state, o.body.shownDigest);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code: new URL(a.body.redirectTo).searchParams.get('code'), code_verifier: verifier, client_id: tplId, redirect_uri: REDIRECT_URI,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    const grant = await registryGrantOf(alice, tplId);
    assert.equal(grant.alias, alias, 'the grant adopted the address alias');
    assert.equal((await rowOf(alice, t.body.access_token)).alias, alias, 'its session carries it');
    const info = await introspect(t.body.access_token);
    assert.deepEqual([info.body.active, info.body.aud, info.body.sub], [true, at(alias), alias]);
    assert.ok(info.body.api_base.includes(alias) && !info.body.api_base.includes(alice.username), info.body.api_base);
    const read = (name) => coreRequest.get('/' + name + '/events').query({ streams: JSON.stringify(['a']) }).set('Authorization', t.body.access_token);
    assert.equal((await read(alias)).status, 200, 'usable at its address');
    assert.notEqual((await read(alice.username)).status, 200, 'never at the username');
    const listed = (await addressAliasesOf(alice)).find((x) => x.alias === alias);
    assert.deepEqual(listed.heldBy, { accessId: grant.id, clientId: tplId });

    // A re-authorization of the same client at the same address joins its grant.
    const again = await connect(alice, tplId, at(alias));
    assert.equal((await introspect(again.access_token)).body.aud, at(alias));
    assert.equal((await registryGrantOf(alice, tplId)).id, grant.id, 'the same grant');

    // Held by this grant: another client's consent at that address is refused (told to the owner as held); so is bob's alias for alice.
    const other = await register('PerUserOther');
    const { state: s2 } = await authorize(other, at(alias));
    assert.deepEqual([(await offer(alice, s2)).status, (await accept(alice, s2)).body], [403, HELD]);
    const bobs = await mintAddressAlias(bob);
    const { state: s3 } = await authorize(other, at(bobs));
    assert.deepEqual([(await offer(alice, s3)).status, (await accept(alice, s3)).body], [403, MISMATCH]);
    assert.equal(await registryGrantOf(alice, other), null, 'nothing written');
    assert.ok((await addressAliasesOf(bob)).every((x) => x.heldBy === null), 'bob\'s alias is untouched');
  });

  it('[OPUE22] the owner consents at an address alias another app\'s grant holds: 403 address-alias-held, audited so, nothing written; another account there still gets the shared mismatch', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const alias = await mintAddressAlias(alice);
    await connect(alice, tplId, at(alias));
    const other = await register('PerUserHeld');
    const { state } = await authorize(other, at(alias));
    let o, a;
    const rows = await auditRows(async () => {
      o = await offer(alice, state);
      a = await accept(alice, state);
    });
    for (const res of [o, a]) assert.deepEqual([res.status, res.body], [403, HELD]);
    const refused = rows.filter((x) => x.event === 'oauth.consent.refused');
    assert.equal(refused.length, 2);
    assert.ok(refused.every((x) => x.payload.reason === 'address-alias-held' && x.payload.userId == null));
    assert.ok(!JSON.stringify(rows).includes(alias), 'no alias in the audit rows');
    assert.equal(await registryGrantOf(alice, other), null, 'nothing written');
    // No oracle: for bob, alice's held alias is just another account's address.
    const { state: s2 } = await authorize(other, at(alias));
    assert.deepEqual([(await offer(bob, s2)).body, (await accept(bob, s2)).body], [MISMATCH, MISMATCH]);
  });

  it('[OPUE16] a consent at an address alias over a grant without it is a change of subject: unacknowledged, refused; acknowledged, the grant is replaced (the alias it held, if any, released)', async () => {
    const alice = await newUser();
    const first = await connect(alice, tplId, at(alice.username));
    const alias = await mintAddressAlias(alice);
    const { state } = await authorize(tplId, at(alias));
    const o = await offer(alice, state);
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.deepEqual(o.body.subjectChange, { from: 'account', to: 'pseudonym' });
    const refused = await accept(alice, state, o.body.shownDigest);
    assert.deepEqual([refused.status, refused.body.reason], [400, 'subject-change-unacknowledged'], JSON.stringify(refused.body));
    const ok = await coreRequest.post('/oauth2/authorize/accept')
      .send({ state, username: alice.username, userToken: alice.token, grantedPermissions: [{ streamId: 'a', level: 'read' }], shownDigest: o.body.shownDigest, acknowledgeSubjectChange: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await registryGrantOf(alice, tplId)).alias, alias);
    assert.equal((await introspect(first.access_token)).body.active, false, 'the old grant\'s session ended');

    // From one address alias to another: a change of subject too.
    const second = await mintAddressAlias(alice);
    const { state: s2 } = await authorize(tplId, at(second));
    const o2 = await offer(alice, s2);
    assert.deepEqual(o2.body.subjectChange, { from: 'pseudonym', to: 'pseudonym' });
    const ok2 = await coreRequest.post('/oauth2/authorize/accept')
      .send({ state: s2, username: alice.username, userToken: alice.token, grantedPermissions: [{ streamId: 'a', level: 'read' }], shownDigest: o2.body.shownDigest, acknowledgeSubjectChange: true });
    assert.equal(ok2.status, 200, JSON.stringify(ok2.body));
    assert.equal((await registryGrantOf(alice, tplId)).alias, second);
    assert.deepEqual((await addressAliasesOf(alice)).map((x) => x.alias), [second], 'the replaced grant\'s alias is released with it');
  });

  it('[OPUE17] two clients\' consents at the same unheld address alias at once: one grant adopts it, the other consent is refused', async () => {
    const alice = await newUser();
    const alias = await mintAddressAlias(alice);
    const first = await register('PerUserRace');
    const second = await register('PerUserRace');
    const flows = [];
    for (const cid of [first, second]) {
      const { state } = await authorize(cid, at(alias));
      const o = await offer(alice, state);
      assert.equal(o.status, 200, JSON.stringify(o.body));
      flows.push({ cid, state, shownDigest: o.body.shownDigest });
    }
    const answers = await Promise.all(flows.map((f) => accept(alice, f.state, f.shownDigest)));
    assert.deepEqual(answers.map((a) => a.status).sort(), [200, 403], JSON.stringify(answers.map((a) => a.body)));
    // The loser reads the alias held (the winner's grant was written before its
    // check) or loses the write race: either refusal, nothing written.
    const refusal = answers.find((a) => a.status === 403).body;
    assert.ok(isDeepStrictEqual(refusal, MISMATCH) || isDeepStrictEqual(refusal, HELD), JSON.stringify(refusal));
    const holders = (await accesses(alice)).filter((a) => a.alias === alias && a.name.startsWith('oauth-grant:'));
    assert.equal(holders.length, 1, 'one grant holds it');
    assert.equal(holders[0].name, 'oauth-grant:' + flows[answers.findIndex((a) => a.status === 200)].cid);
  });

  it('[OPUE18] an access that took the same address alias while the grant was being written (earlier than it) keeps it: the new grant is withdrawn, the consent refused', async () => {
    const alice = await newUser();
    const alias = await mintAddressAlias(alice);
    const { getStorageLayer } = await import('storage');
    const accessesStorage = (await getStorageLayer()).accesses;
    const insertOne = accessesStorage.insertOne;
    // The rival lands between the adoption's check and its own write.
    accessesStorage.insertOne = function (user, params, cb) {
      if (params?.alias !== alias) return insertOne.call(this, user, params, cb);
      accessesStorage.insertOne = insertOne;
      const rival = { ...params, id: cuid(), token: cuid(), name: 'opue18 rival', deviceName: 'opue18', created: params.created - 10 };
      insertOne.call(this, user, rival, (err) => {
        if (err != null) return cb(err);
        insertOne.call(this, user, params, cb);
      });
    };
    try {
      const { state } = await authorize(tplId, at(alias));
      const o = await offer(alice, state);
      assert.equal(o.status, 200, JSON.stringify(o.body));
      const a = await accept(alice, state, o.body.shownDigest);
      assert.deepEqual([a.status, a.body], [403, MISMATCH]);
    } finally {
      accessesStorage.insertOne = insertOne;
    }
    assert.equal(await registryGrantOf(alice, tplId), null, 'the new grant is withdrawn');
    const holders = (await accesses(alice)).filter((x) => x.alias === alias);
    assert.deepEqual(holders.map((x) => x.name), ['opue18 rival'], 'the earlier holder keeps the alias');
  });

  it('[OPAL4] deleting an address alias withdraws the grant that holds it and releases the name; withdrawing the grant releases it too', async () => {
    const alice = await newUser();
    const platform = await getPlatform();
    const alias = await mintAddressAlias(alice);
    const t = await connect(alice, tplId, at(alias));
    const grant = await registryGrantOf(alice, tplId);
    const del = await coreRequest.delete('/' + alice.username + '/account/address-aliases/' + alias).set('Authorization', alice.token);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.addressAliasDeletion.alias, alias);
    assert.ok(del.body.relatedDeletions.some((d) => d.id === grant.id), JSON.stringify(del.body));
    assert.equal(await registryGrantOf(alice, tplId), null, 'the grant is gone');
    assert.equal((await introspect(t.access_token)).body.active, false);
    const r = await coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: tplId });
    assert.equal(r.status, 400, 'the refresh chain ended: ' + JSON.stringify(r.body));
    assert.deepEqual(await addressAliasesOf(alice), []);
    assert.equal(await platform.getUserCore(alias), null, 'the name routes nowhere');

    // The owner withdrawing the grant (accesses.delete) releases its address alias.
    const other = await mintAddressAlias(alice);
    await connect(alice, tplId, at(other));
    const held = await registryGrantOf(alice, tplId);
    const withdrawn = await coreRequest.delete('/' + alice.username + '/accesses/' + held.id).set('Authorization', alice.token);
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.deepEqual(await addressAliasesOf(alice), []);

    // The budget counts adopted aliases too: with one held among 10, the 11th is refused.
    const bob = await newUser();
    await connect(bob, tplId, at(await mintAddressAlias(bob)));
    for (let i = 0; i < 9; i++) await mintAddressAlias(bob);
    const eleventh = await coreRequest.post('/' + bob.username + '/account/address-aliases').set('Authorization', bob.token).send({});
    assert.deepEqual([eleventh.status, eleventh.body.error?.id, eleventh.body.error?.data?.addressAliasesLimit], [400, 'invalid-operation', 10], JSON.stringify(eleventh.body));
    const bobs = await addressAliasesOf(bob);
    assert.deepEqual([bobs.length, bobs.filter((x) => x.heldBy != null).length], [10, 1]);
  });

  /** The acknowledged consent of a change of subject. */
  function acknowledged (who, state, shownDigest) {
    return coreRequest.post('/oauth2/authorize/accept')
      .send({ state, username: who.username, userToken: who.token, grantedPermissions: [{ streamId: 'a', level: 'read' }], shownDigest, acknowledgeSubjectChange: true });
  }

  /** The code exchange of an accepted consent: the token response. */
  async function codeToken (cid, accepted, verifier) {
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code: new URL(accepted.body.redirectTo).searchParams.get('code'), code_verifier: verifier, client_id: cid, redirect_uri: REDIRECT_URI,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    return t.body;
  }

  const readAt = (name, token) => coreRequest.get('/' + name + '/events').query({ streams: JSON.stringify(['a']) }).set('Authorization', token);
  const baseOf = (id) => String(id).split(':')[0];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it('[OPUE19] a consent at the username over a grant that adopted an address alias is a change of subject: the grant is replaced, the address alias released, the token used at its api_base', async () => {
    for (const [subjectType, to] of [['pairwise', 'pseudonym'], ['public', 'account']]) {
      const alice = await newUser();
      const cid = await register('PerUserAt', { subjectType });
      const alias = await mintAddressAlias(alice);
      const first = await connect(alice, cid, at(alias));
      const { state, verifier } = await authorize(cid, at(alice.username));
      const o = await offer(alice, state);
      assert.equal(o.status, 200, JSON.stringify(o.body));
      assert.deepEqual(o.body.subjectChange, { from: 'pseudonym', to }, subjectType);
      assert.equal(o.body.addressAlias, undefined, 'nothing adopted at the username');
      const refused = await accept(alice, state, o.body.shownDigest);
      assert.deepEqual([refused.status, refused.body.reason], [400, 'subject-change-unacknowledged'], JSON.stringify(refused.body));
      const ok = await acknowledged(alice, state, o.body.shownDigest);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const t = await codeToken(cid, ok, verifier);
      const grant = await registryGrantOf(alice, cid);
      if (to === 'pseudonym') assert.match(grant.alias, /^r-[a-z0-9]{8}$/, 'a new minted alias');
      else assert.equal(grant.alias ?? null, null, 'no alias');
      assert.equal((await introspect(first.access_token)).body.active, false, subjectType + ': the replaced grant\'s session ended');
      assert.deepEqual(await addressAliasesOf(alice), [], subjectType + ': the address alias is released with the replaced grant');
      const info = await introspect(t.access_token);
      assert.deepEqual([info.body.active, info.body.aud], [true, at(alice.username)]);
      const usableAt = to === 'pseudonym' ? grant.alias : alice.username;
      assert.equal(info.body.sub === alias, false, 'the address alias is no subject any more');
      assert.ok(info.body.api_base.includes(usableAt) && !info.body.api_base.includes(alias), info.body.api_base);
      assert.equal((await readAt(usableAt, t.access_token)).status, 200, subjectType + ': usable at its api_base');
    }
  });

  it('[OPUE21] a grant that expired, or that predates its client\'s revoke (a client deleted and registered again): the next consent at its address alias adopts it again', async () => {
    storage._setRevokeClockMarginForTests(0);
    try {
      for (const stale of ['expired', 're-registered']) {
        const alice = await newUser();
        const cid = await register('PerUserStale');
        const alias = await mintAddressAlias(alice);
        const first = await connect(alice, cid, at(alias));
        const old = await registryGrantOf(alice, cid);
        if (stale === 'expired') {
          const u = await coreRequest.put('/' + alice.username + '/accesses/' + encodeURIComponent(old.id)).set('Authorization', alice.token).send({ expireAfter: 0 });
          assert.equal(u.status, 200, JSON.stringify(u.body));
          await sleep(1100);
        } else {
          await sleep(1100);
          const row = await storage.getClient(platformDB, cid);
          await oauth2.removeClient(platformDB, cid);
          await oauth2.persistClient(platformDB, { ...row, updatedAt: Date.now() });
          await sleep(1100);
        }
        const o = await offer(alice, (await authorize(cid, at(alias))).state);
        assert.deepEqual([o.status, o.body.addressAlias, o.body.subjectChange], [200, alias, null], stale + ': ' + JSON.stringify(o.body));
        const again = await connect(alice, cid, at(alias));
        const grant = await registryGrantOf(alice, cid);
        assert.notEqual(baseOf(grant.id), baseOf(old.id), stale + ': a fresh grant');
        assert.equal(grant.alias, alias, stale + ': it adopted the same address alias');
        const info = await introspect(again.access_token);
        assert.deepEqual([info.body.active, info.body.aud, info.body.sub], [true, at(alias), alias], stale);
        assert.equal((await introspect(first.access_token)).body.active, false, stale + ': the stale grant\'s session is gone');
        assert.equal((await readAt(alias, again.access_token)).status, 200);
        const listed = (await addressAliasesOf(alice)).find((x) => x.alias === alias);
        assert.deepEqual(listed.heldBy, { accessId: grant.id, clientId: cid }, stale);
      }
    } finally {
      storage._setRevokeClockMarginForTests(null);
    }
  });

  it('[OPAL5] the owner deletes an address alias while a consent adopts it: the grant written after the release withdraws itself, the consent is refused, the name stays released', async () => {
    const alice = await newUser();
    const platform = await getPlatform();
    const alias = await mintAddressAlias(alice);
    const { getStorageLayer } = await import('storage');
    const accessesStorage = (await getStorageLayer()).accesses;
    const insertOne = accessesStorage.insertOne;
    let deletion = null;
    // The deletion runs between the adoption's check and its write.
    accessesStorage.insertOne = function (user, params, cb) {
      if (params?.alias !== alias) return insertOne.call(this, user, params, cb);
      accessesStorage.insertOne = insertOne;
      coreRequest.delete('/' + alice.username + '/account/address-aliases/' + alias).set('Authorization', alice.token)
        .then((res) => { deletion = res; insertOne.call(this, user, params, cb); }, cb);
    };
    try {
      const { state } = await authorize(tplId, at(alias));
      const o = await offer(alice, state);
      assert.equal(o.status, 200, JSON.stringify(o.body));
      const a = await accept(alice, state, o.body.shownDigest);
      assert.deepEqual([a.status, a.body], [403, MISMATCH]);
    } finally {
      accessesStorage.insertOne = insertOne;
    }
    assert.equal(deletion?.status, 200, JSON.stringify(deletion?.body));
    assert.deepEqual(deletion.body.relatedDeletions, [], 'nothing held it when the deletion ran');
    assert.equal(await registryGrantOf(alice, tplId), null, 'the grant withdrew itself');
    assert.ok(!(await accesses(alice)).some((x) => x.alias === alias), 'no access carries the name');
    assert.deepEqual(await addressAliasesOf(alice), []);
    assert.equal(await platform.getUserCore(alias), null, 'the name routes nowhere');
  });

  it('[OPUX5] the exchange accepts the address alias its grant adopted; a session whose audience names another of the account\'s address aliases is not exchanged', async () => {
    const alice = await newUser();
    const alias = await mintAddressAlias(alice);
    const t = await connect(alice, tplId, at(alias));
    for (const body of [{}, { subject_token_resource: at(alias) }]) {
      const x = await exchange(t.access_token, body);
      assert.equal(x.status, 200, JSON.stringify(x.body));
    }
    const unheld = await mintAddressAlias(alice);
    const row = await storage.getSessionIndex(platformDB, t.access_token);
    await storage.setSessionIndex(platformDB, t.access_token, { ...row, audience: at(unheld) });
    let x;
    const rows = await auditRows(async () => { x = await exchange(t.access_token); });
    assert.deepEqual([x.status, x.body.error], [400, 'invalid_grant'], JSON.stringify(x.body));
    assert.ok(rows.some((r) => r.event === 'oauth.token.exchange_refused' && r.payload.reason === 'audience-account-mismatch'), JSON.stringify(rows));
    await storage.setSessionIndex(platformDB, t.access_token, row);
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
