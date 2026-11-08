/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [OPIS] The issuer derived from the request host (`oauth:perUserIssuer`), end
 * to end on a DNS-topology configuration: off, the configured issuer on every
 * host; on, an account's own host (served by this core) is its issuer for the
 * discovery documents, the authorization, the code and refresh tokens, the
 * id_token and client assertions; introspection keeps the configured issuer.
 * The test core is dnsLess at mount: the DNS topology is injected for the
 * suite, the switch is read per request.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as oauth2 from 'oauth2';
import * as storage from 'oauth2/src/storage.ts';
import { mintSecret } from 'oauth2/src/clientSecret.ts';
import { issuerFromConfig } from 'oauth2/src/issuer.ts';
import * as storages from 'storages';
import { injectTestConfigSnapshot, withInjectedConfig } from 'test-helpers';
import { configureTrustedProxies, currentTrustedProxies } from 'middleware/src/clientIp.ts';
import { getPlatform } from 'platform';
import { getConfigUnsafe } from '@pryv/boiler';
import { perUserIssuerResolver } from '../src/routes/oauth2/perUserIssuer.ts';

const DOMAIN = 'opis.example.com';
const REDIRECT_URI = 'https://app.per-user-issuer.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const STATE_KEY = 'test-oauth-state-key-' + 'p3rUs3rIss'.repeat(2);
const SIGNING_KEY_PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const TEMPLATE = 'https://{username}.' + DOMAIN + '/adapter/facade/r4';
const at = (name) => 'https://' + name + '.' + DOMAIN + '/adapter/facade/r4';
const issuerOf = (name) => 'https://' + name + '.' + DOMAIN;
const hostOf = (name) => name + '.' + DOMAIN;
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const OAUTH = { consentUrl: CONSENT_URL, stateKey: STATE_KEY, signingKeys: [{ kid: 'opis-1', privateKeyPem: SIGNING_KEY_PEM }] };
const MISMATCH = { error: 'access_denied', error_description: 'the requested resource names another account\'s address', reason: 'audience-account-mismatch' };

const toyExtension = {
  apiVersion: 1,
  name: 'toy-per-user-issuer',
  scopeGrammar: {
    parse (scopeString) {
      const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
      const permissions = [];
      for (const t of tokens) {
        if (!t.startsWith('read/')) return { ok: false, description: 'unknown token ' + t };
        permissions.push({ streamId: t.slice('read/'.length), level: 'read' });
      }
      return { ok: true, tokens, offer: { permissions } };
    },
    echo: ({ requestedTokens }) => requestedTokens,
  },
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const jwtPayload = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const statePayload = (state) => JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString());

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function makeKey () {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const pub = publicKey.export({ format: 'jwk' });
  return { privateKey, publicJwk: { kty: 'EC', crv: pub.crv, x: pub.x, y: pub.y, kid: 'opis-ec' } };
}

describe('[OPIS] OAuth issuer derived from the request host', function () {
  this.timeout(90000);

  let fixtures, restoreConfig, platformDB, platform, configured, pubId, anyId, pkjId, rsId, rsSecret, ecKey, alice, bob;
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
      scope: ['read/a'],
      ...extra,
    });
    clientIds.push(clientId);
    return clientId;
  }

  /** A user with a personal token and a stream; mapped to this core unless `mapped` is false. */
  async function newUser ({ mapped = true } = {}) {
    const username = 'opis' + cuid().slice(-10).toLowerCase();
    const token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    const s = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id: 'a', name: 'a' });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    if (mapped) await platform.setUserCore(username, platform.coreId);
    return { username, token };
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = injectTestConfigSnapshot({
      oauth: { ...OAUTH, perUserIssuer: true },
      dnsLess: { isActive: false },
      dns: { domain: DOMAIN },
    });
    oauth2.extension.setExtension(toyExtension);
    platformDB = storages.platformDB;
    platform = await getPlatform();
    configured = issuerFromConfig(getConfigUnsafe(true));
    rsSecret = await mintSecret();
    ecKey = makeKey();
    pubId = await register('Pui');
    // No list: any resource, or none.
    anyId = await register('PuiAny', { allowedAudiences: [], anyAudience: true });
    pkjId = await register('PuiKey', {
      tokenEndpointAuthMethod: 'private_key_jwt', jwks: { keys: [ecKey.publicJwk] }, tokenEndpointAuthSigningAlgs: ['ES384'],
    });
    rsId = await register('PuiRs', { tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash, canIntrospect: true });
    alice = await newUser();
    bob = await newUser();
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of clientIds) {
      try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
    }
    if (fixtures != null) await fixtures.clean();
  });

  function discovery (host, path = '/.well-known/oauth-authorization-server') {
    const r = coreRequest.get(path);
    return host != null ? r.set('Host', host) : r;
  }

  async function authorize (host, cid, { resource, scope = 'openid offline_access read/a', extra = {} } = {}) {
    const { verifier, challenge } = pkce();
    const res = await coreRequest.get('/oauth2/authorize').set('Host', host).query({
      client_id: cid,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      ...(resource != null ? { resource } : {}),
      ...extra,
    });
    assert.equal(res.status, 302, res.text);
    const location = new URL(res.headers.location);
    return { location, state: location.searchParams.get('state'), verifier };
  }

  const offer = (host, who, state) => coreRequest.post('/oauth2/authorize/offer').set('Host', host)
    .send({ state, username: who.username, userToken: who.token });
  const accept = (host, who, state) => coreRequest.post('/oauth2/authorize/accept').set('Host', host)
    .send({ state, username: who.username, userToken: who.token, grantedPermissions: [{ streamId: 'a', level: 'read' }] });
  const token = (host, body) => coreRequest.post('/oauth2/token').set('Host', host).type('form').send(body);

  /** Authorization at `host`, consent and code: the code, its verifier and the redirect's `iss`. */
  async function consent (host, who, cid, opts = {}) {
    const a = await authorize(host, cid, opts);
    assert.ok(a.location.href.startsWith(CONSENT_URL), a.location.href);
    const r = await accept(host, who, a.state);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const back = new URL(r.body.redirectTo);
    return { code: back.searchParams.get('code'), iss: back.searchParams.get('iss'), verifier: a.verifier };
  }

  it('[OPIS1] off: the configured issuer on every host, no Vary on the host, the consent hand-off names it', async function () {
    await withInjectedConfig({ oauth: { perUserIssuer: false } }, async () => {
      for (const host of [hostOf(alice.username), hostOf('reg'), null]) {
        const res = await discovery(host);
        assert.equal(res.status, 200, res.text);
        assert.equal(res.body.issuer, configured, String(host));
        assert.doesNotMatch(String(res.headers.vary ?? ''), /\bHost\b/i);
      }
      const a = await authorize(hostOf(alice.username), pubId, { resource: at(alice.username) });
      assert.equal(a.location.searchParams.get('pryvApi'), configured);
      assert.equal(statePayload(a.state).issuer, undefined);
    });
  });

  it('[OPIS2] on: an account\'s host of this core is its issuer (both documents, Vary); a service, core or foreign host, an unmapped name, a port: the configured one', async function () {
    const mine = issuerOf(alice.username);
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const res = await discovery(hostOf(alice.username), path);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.issuer, mine, path);
      assert.equal(res.body.authorization_endpoint, mine + '/oauth2/authorize');
      assert.equal(res.body.token_endpoint, mine + '/oauth2/token');
      assert.equal(res.body.jwks_uri, mine + '/oauth2/jwks');
      assert.match(String(res.headers.vary), /\bHost\b/i);
    }
    const carol = await newUser({ mapped: false });
    const coreId = String(getConfigUnsafe(true).get('core:id') || 'single');
    for (const host of [hostOf('reg'), hostOf(coreId), hostOf(carol.username), alice.username + '.attacker.tld',
      hostOf(alice.username) + ':8443', 'deep.' + hostOf(alice.username), DOMAIN, null]) {
      const res = await discovery(host);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.issuer, configured, String(host));
      // The answer still depends on the host: cached per host.
      assert.match(String(res.headers.vary), /\bHost\b/i);
    }
    // The client-facing host from a trusted proxy counts; from any other peer it does not.
    const forwarded = await coreRequest.get('/.well-known/oauth-authorization-server').set('X-Forwarded-Host', hostOf(alice.username));
    assert.equal(forwarded.body.issuer, mine);
    const savedProxies = currentTrustedProxies();
    configureTrustedProxies(['10.9.8.7']);
    try {
      const untrusted = await coreRequest.get('/.well-known/oauth-authorization-server').set('X-Forwarded-Host', hostOf(alice.username));
      assert.equal(untrusted.body.issuer, configured);
    } finally {
      configureTrustedProxies(savedProxies);
    }
    assert.equal((await discovery(hostOf(alice.username), '/oauth2/jwks')).status, 200);
  });

  it('[OPIS3] /authorize at an account\'s host: the state, pryvApi and iss name its issuer; a resource on another host is refused invalid_target', async function () {
    const mine = issuerOf(alice.username);
    const a = await authorize(hostOf(alice.username), pubId, { resource: at(alice.username) });
    assert.equal(a.location.searchParams.get('pryvApi'), mine);
    assert.equal(statePayload(a.state).issuer, mine);
    const none = await authorize(hostOf(alice.username), anyId);
    assert.equal(statePayload(none.state).issuer, mine);
    for (const resource of [at(bob.username), 'https://' + alice.username + '.other.example/adapter/facade/r4']) {
      const refused = await authorize(hostOf(alice.username), anyId, { resource });
      assert.ok(refused.location.href.startsWith(REDIRECT_URI), refused.location.href);
      assert.equal(refused.location.searchParams.get('error'), 'invalid_target', resource);
      assert.equal(refused.location.searchParams.get('iss'), mine);
    }
    // At the configured host nothing changes.
    const plain = await authorize(hostOf('reg'), pubId, { resource: at(bob.username) });
    assert.equal(plain.location.searchParams.get('pryvApi'), configured);
    assert.equal(statePayload(plain.state).issuer, undefined);
  });

  it('[OPIS4] the consent steps reach the authorization\'s issuer; only the account its host names consents there', async function () {
    const a = await authorize(hostOf(alice.username), pubId, { resource: at(alice.username) });
    for (const res of [await offer(hostOf('reg'), alice, a.state), await accept(hostOf('reg'), alice, a.state),
      await coreRequest.post('/oauth2/authorize/refuse').set('Host', hostOf('reg')).send({ state: a.state })]) {
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.reason, 'issuer-mismatch');
    }
    // A state of the configured issuer is not served at an account's host either.
    const plain = await authorize(hostOf('reg'), pubId, { resource: at(alice.username) });
    assert.equal((await accept(hostOf(alice.username), alice, plain.state)).body.reason, 'issuer-mismatch');
    // Another account at alice's issuer, with or without a resource: refused.
    const noResource = await authorize(hostOf(alice.username), anyId);
    for (const state of [a.state, noResource.state]) {
      assert.deepEqual((await offer(hostOf(alice.username), bob, state)).body, MISMATCH);
      assert.deepEqual((await accept(hostOf(alice.username), bob, state)).body, MISMATCH);
    }
    const refuse = await coreRequest.post('/oauth2/authorize/refuse').set('Host', hostOf(alice.username)).send({ state: a.state });
    assert.equal(refuse.status, 200, JSON.stringify(refuse.body));
    assert.equal(new URL(refuse.body.redirectTo).searchParams.get('iss'), issuerOf(alice.username));
  });

  it('[OPIS5] a code and its refresh chain are redeemed at their issuer only; the id_token names it; introspection keeps the configured issuer', async function () {
    const mine = issuerOf(alice.username);
    const host = hostOf(alice.username);
    // A code presented at the configured host: refused, and used up.
    const first = await consent(host, alice, pubId, { resource: at(alice.username) });
    assert.equal(first.iss, mine);
    const codeGrant = (c) => ({ grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier, client_id: pubId, redirect_uri: REDIRECT_URI });
    const atRegion = await token(hostOf('reg'), codeGrant(first));
    assert.deepEqual([atRegion.status, atRegion.body.error], [400, 'invalid_grant'], JSON.stringify(atRegion.body));
    assert.equal((await token(host, codeGrant(first))).body.error, 'invalid_grant', 'the code is used up');
    // At its issuer: the id_token names it.
    const second = await consent(host, alice, pubId, { resource: at(alice.username), extra: { nonce: 'n-' + cuid() } });
    const t = await token(host, codeGrant(second));
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(jwtPayload(t.body.id_token).iss, mine);
    // The refresh chain: refused at the configured host without being used up, rotated at its issuer, which it keeps.
    const refresh = (h, rt) => token(h, { grant_type: 'refresh_token', refresh_token: rt, client_id: pubId });
    const elsewhere = await refresh(hostOf('reg'), t.body.refresh_token);
    assert.deepEqual([elsewhere.status, elsewhere.body.error], [400, 'invalid_grant'], JSON.stringify(elsewhere.body));
    const rotated = await refresh(host, t.body.refresh_token);
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.equal((await refresh(hostOf('reg'), rotated.body.refresh_token)).body.error, 'invalid_grant');
    assert.equal((await refresh(host, rotated.body.refresh_token)).status, 200);
    // A chain of the configured issuer is not refreshed at an account's host.
    const plain = await consent(hostOf('reg'), alice, pubId, { resource: at(alice.username) });
    assert.equal(plain.iss, configured);
    const pt = await token(hostOf('reg'), codeGrant(plain));
    assert.equal(pt.status, 200, JSON.stringify(pt.body));
    assert.equal(jwtPayload(pt.body.id_token).iss, configured);
    assert.equal((await refresh(host, pt.body.refresh_token)).body.error, 'invalid_grant');
    // Introspection on the account's host: the configured issuer.
    const info = await coreRequest.post('/oauth2/introspect').set('Host', host).type('form')
      .set('Authorization', 'Basic ' + Buffer.from(rsId + ':' + rsSecret.plaintext).toString('base64'))
      .send({ token: rotated.body.access_token });
    assert.equal(info.status, 200, JSON.stringify(info.body));
    assert.equal(info.body.active, true);
    assert.equal(info.body.iss, configured);
  });

  it('[OPIS6] private_key_jwt at a per-user issuer: the assertion names that issuer or its token endpoint, never the configured one', async function () {
    const mine = issuerOf(alice.username);
    const host = hostOf(alice.username);
    const assertion = (aud) => {
      const now = Math.floor(Date.now() / 1000);
      const h = b64url(JSON.stringify({ alg: 'ES384', typ: 'JWT', kid: 'opis-ec' }));
      const p = b64url(JSON.stringify({ iss: pkjId, sub: pkjId, aud, jti: crypto.randomUUID(), iat: now, exp: now + 120 }));
      const sig = crypto.sign('sha384', Buffer.from(h + '.' + p), { key: ecKey.privateKey, dsaEncoding: 'ieee-p1363' });
      return h + '.' + p + '.' + b64url(sig);
    };
    const auth = (aud) => ({ client_id: pkjId, client_assertion_type: ASSERTION_TYPE, client_assertion: assertion(aud) });
    const c = await consent(host, alice, pkjId, { resource: at(alice.username) });
    const t = await token(host, { grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier, redirect_uri: REDIRECT_URI, ...auth(mine + '/oauth2/token') });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    const refresh = (aud) => token(host, { grant_type: 'refresh_token', refresh_token: t.body.refresh_token, ...auth(aud) });
    for (const aud of [configured, configured + '/oauth2/token']) {
      const refused = await refresh(aud);
      assert.deepEqual([refused.status, refused.body.error], [401, 'invalid_client'], aud);
    }
    const ok = await refresh(mine);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it('[OPIS7] an address alias\'s host is the alias\'s issuer: a consent there adopts the alias; one that does not adopt it is refused', async function () {
    // A user with no grant yet (adopting an alias over a grant is a change of subject).
    const dana = await newUser();
    const minted = await coreRequest.post('/' + dana.username + '/account/address-aliases').set('Authorization', dana.token).send({});
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const alias = minted.body.addressAlias.alias;
    const host = hostOf(alias);
    assert.equal((await discovery(host)).body.issuer, issuerOf(alias));
    // No resource: nothing adopts the alias, the app would get the username's address.
    const bare = await authorize(host, anyId);
    assert.deepEqual((await accept(host, dana, bare.state)).body, MISMATCH);
    // The username's own host, without a resource: the account consents there.
    const own = await authorize(hostOf(dana.username), anyId);
    assert.equal((await accept(hostOf(dana.username), dana, own.state)).status, 200);
    // At the alias's address: adopted, its issuer on the code and the id_token.
    const c = await consent(host, dana, pubId, { resource: at(alias) });
    assert.equal(c.iss, issuerOf(alias));
    const t = await token(host, { grant_type: 'authorization_code', code: c.code, code_verifier: c.verifier, client_id: pubId, redirect_uri: REDIRECT_URI });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(jwtPayload(t.body.id_token).iss, issuerOf(alias));
    assert.equal(t.body.apiEndpoint, undefined, 'an aliased grant: no username');
  });

  it('[OPIS9] the host reader: this core\'s accounts only; another core\'s, an unmapped name or a failed lookup keep the configured issuer', async function () {
    const warnings = [];
    const stub = {
      coreId: 'core-a',
      calls: [],
      async getUserCore (name) {
        this.calls.push(name);
        if (name === 'failing') throw new Error('store down');
        return { alice: 'core-a', bobby: 'core-b' }[name] ?? null;
      },
    };
    const of = perUserIssuerResolver(getConfigUnsafe(true), { warn: (m) => warnings.push(m) }, { platform: stub });
    const req = (host, extra = {}) => ({ headers: { host, ...extra }, socket: { remoteAddress: '10.1.2.3' } });
    assert.deepEqual(await of(req(hostOf('alice'))), { issuer: issuerOf('alice'), label: 'alice' });
    assert.deepEqual(await of(req('ALICE.' + DOMAIN.toUpperCase() + '.')), { issuer: issuerOf('alice'), label: 'alice' });
    for (const host of [hostOf('bobby'), hostOf('nobody'), hostOf('failing')]) assert.equal(await of(req(host)), null, host);
    assert.match(warnings.at(-1), /placement lookup failed/);
    const before = stub.calls.length;
    for (const host of [hostOf('alice') + ':443', hostOf('reg'), 'alice.attacker.tld', DOMAIN, '127.0.0.1', undefined]) {
      assert.equal(await of(req(host)), null, String(host));
    }
    // Not a trusted proxy: its X-Forwarded-Host is not read.
    assert.equal(await of(req('127.0.0.1', { 'x-forwarded-host': hostOf('alice') })), null);
    assert.equal(stub.calls.length, before, 'no lookup for a host that names no account');
    // On a dnsLess configuration no host is an account's.
    await withInjectedConfig({ dnsLess: { isActive: true } }, async () => {
      assert.equal(await of(req(hostOf('alice'))), null);
    });
  });
});
