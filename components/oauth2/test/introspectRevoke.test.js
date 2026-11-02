/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [OXI] token introspection (RFC 7662) and [ORVK] token revocation (RFC 7009)
 * at the oauth2 component level, with an in-memory platform store and a toy
 * grammar; the session re-read and deletions are injected.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CLIENT_ASSERTION_TYPE } from '../src/clientAssertion.ts';
import * as extension from '../src/extension.ts';
import * as scopeGrammar from '../src/scopeGrammar.ts';
import { handleIntrospect } from '../src/introspection.ts';
import { handleRevoke } from '../src/revocation.ts';
import { buildDiscoveryDocument } from '../src/wellKnown.ts';
import { persistClient } from '../src/clientRegistry.ts';
import { mintSecret } from '../src/clientSecret.ts';
import { setSessionIndex, setRefresh, getRefresh, getRefreshConsumed, getSessionIndex, hashSecret, setClient } from '../src/storage.ts';

const ISSUER = 'https://core.example.com';
const CORE_ID = 'core-a';
const AUD = 'https://resource.example.com/base';
const USER_ID = 'u-alice';

function toyExtension () {
  return {
    apiVersion: 1,
    name: 'toy-introspect',
    scopeGrammar: {
      parse (scopeString) {
        const tokens = scopeString.split(/\s+/).filter((t) => t !== '');
        return { ok: true, tokens, offer: { permissions: tokens.filter((t) => t.startsWith('read/')).map((t) => ({ streamId: t.slice(5), level: 'read' })) } };
      },
      echo ({ permissions, requestedTokens }) {
        return requestedTokens.filter((t) => t === 'ctx/patient' || permissions.some((p) => 'read/' + p.streamId === t));
      },
    },
    introspectionClaims (ctx) { return { patient: ctx.subject }; },
  };
}

function fakeConfig (overrides = {}) {
  const m = { 'service:api': ISSUER, 'core:id': CORE_ID, ...overrides };
  return { get: (k) => m[k] };
}

function fakePlatform (cores = [CORE_ID]) {
  const state = new Map();
  const kv = new Map();
  return {
    async setAccessState (k, v, exp) { state.set(k, { value: v, expiresAt: exp }); },
    async setAccessStateIfAbsent (k, v, exp) { if (state.has(k)) return false; state.set(k, { value: v, expiresAt: exp }); return true; },
    async getAccessState (k) { return state.get(k) ?? null; },
    async deleteAccessState (k) { state.delete(k); },
    async consumeAccessState (k) { const e = state.get(k); state.delete(k); return e ?? null; },
    async setPlatformKv (k, v) { kv.set(k, v); },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvKeys (p) { return [...kv.keys()].filter((k) => k.startsWith(p)); },
    async listPlatformKvEntries (p) { return [...kv.entries()].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })); },
    async getAllCoreInfos () { return cores.map((id) => ({ id })); },
    _state: state,
  };
}

function fakeRes () {
  return {
    statusCode: 200,
    headers: {},
    raw: '',
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
    end (b) {
      this.raw = b ?? '';
      this.body = String(this.headers['content-type'] ?? '').includes('json') && b ? JSON.parse(b) : null;
    },
  };
}

const basic = (id, secret) => 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');

const REGISTRY_CLIENT = {
  clientId: 'reg-app',
  kind: 'registry',
  redirectUris: ['https://app.example.com/redirect'],
  scope: ['read/a', 'read/b', 'ctx/patient'],
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenEndpointAuthMethod: 'none',
  allowedAudiences: [AUD],
  subjectType: 'public',
};

// As the glue returns it: the stored row without the selfRevoke override.
const SESSION = {
  permissions: [{ streamId: 'a', level: 'read' }, { streamId: 'x', level: 'none' }, { feature: 'webhooks', setting: 'forbidden' }],
  created: 1000.25,
  expires: 9999999999,
  subject: USER_ID,
  apiBase: 'https://alice.example.com/',
};

let rsSecret, appSecret;

async function seeded ({ cores } = {}) {
  const platform = fakePlatform(cores);
  await persistClient(platform, REGISTRY_CLIENT);
  await persistClient(platform, { ...REGISTRY_CLIENT, clientId: 'resource-srv', tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash, canIntrospect: true });
  await persistClient(platform, { ...REGISTRY_CLIENT, clientId: 'no-role', tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash });
  await persistClient(platform, { ...REGISTRY_CLIENT, clientId: 'public-rs', canIntrospect: true });
  await persistClient(platform, { clientId: 'cmc-app', redirectUris: ['https://cmc.example.com/r'], scope: ['pryv:read'], grantTypes: ['authorization_code', 'refresh_token'], clientSecretHash: appSecret.hash });
  await setSessionIndex(platform, 'session-token-1', {
    userId: USER_ID,
    accessId: 'session-1',
    clientId: 'reg-app',
    coreId: CORE_ID,
    expiresAt: Date.now() + 1e6,
    dataGrantAccessId: 'grant-1',
    coreTokens: ['offline_access'],
    grammarTokens: ['read/a', 'read/b', 'ctx/patient'],
    audience: AUD,
    refreshTokenHash: hashSecret('refresh-1'),
  });
  await setRefresh(platform, CORE_ID, 'refresh-1', {
    clientId: 'reg-app',
    userId: USER_ID,
    scope: ['read/a'],
    issuedAt: 0,
    lastUsedAt: 0,
    expiresAt: Date.now() + 1e6,
    absoluteExpiresAt: Date.now() + 2e6,
    dataGrantAccessId: 'grant-1',
    accessId: 'session-1',
  });
  await setSessionIndex(platform, 'cmc-token', { userId: USER_ID, accessId: 'session-2', clientId: 'cmc-app', coreId: CORE_ID, expiresAt: Date.now() + 1e6 });
  return platform;
}

describe('[OXINT] OAuth2: token introspection and revocation', () => {
  before(async () => {
    rsSecret = await mintSecret();
    appSecret = await mintSecret();
  });
  beforeEach(() => {
    extension.setExtension(toyExtension());
    scopeGrammar._resetForTests();
  });
  afterEach(() => extension._resetForTests());

  async function introspect (platform, { auth = basic('resource-srv', rsSecret.plaintext), token = 'session-token-1', session = SESSION, config = fakeConfig(), body = {} } = {}) {
    const res = fakeRes();
    await handleIntrospect({
      config,
      platform,
      introspectAccess: async () => session,
      coreUrlFor: async (id) => 'https://' + id + '.example.com',
    })({ headers: auth != null ? { authorization: auth } : {}, body: { token, ...body } }, res);
    return res;
  }

  it('[OXI01] an active registry session: scope echo, client, subject, audience, api_base, the stream permissions, extension claims', async () => {
    const res = await introspect(await seeded());
    assert.equal(res.statusCode, 200, res.raw);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.body, {
      patient: USER_ID,
      active: true,
      scope: 'offline_access read/a ctx/patient',
      client_id: 'reg-app',
      exp: 9999999999,
      iat: 1000,
      sub: USER_ID,
      api_base: 'https://alice.example.com/',
      permissions: [{ streamId: 'a', level: 'read' }, { streamId: 'x', level: 'none' }],
      iss: ISSUER,
      token_type: 'Bearer',
      aud: AUD,
    });
    // The core owns api_base and permissions: an extension cannot set them.
    for (const key of ['api_base', 'permissions']) {
      extension.setExtension({ ...toyExtension(), introspectionClaims: () => ({ [key]: 'x' }) });
      await assert.rejects(extension.runHook('introspectionClaims', { scopeTokens: [] }), new RegExp('reserved key.*' + key));
    }
  });

  it('[OXI02] unknown token, dead session, client revoked after the session, client suspended or gone: inactive', async () => {
    let platform = await seeded();
    assert.deepEqual((await introspect(platform, { token: 'nope' })).body, { active: false });
    assert.deepEqual((await introspect(platform, { session: null })).body, { active: false });
    await platform.setPlatformKv('oauth-client-revoked/reg-app', JSON.stringify({ revokedAt: Date.now() }));
    assert.deepEqual((await introspect(platform)).body, { active: false });
    platform = await seeded();
    await setClient(platform, { ...REGISTRY_CLIENT, status: 'suspended', updatedAt: Date.now() });
    assert.deepEqual((await introspect(platform)).body, { active: false });
    await platform.deletePlatformKv('oauth-client/reg-app');
    assert.deepEqual((await introspect(platform)).body, { active: false });
  });

  it('[OXI03] callers: public, without the role, suspended, wrong secret, unknown or none are refused alike (401)', async () => {
    const platform = await seeded();
    await persistClient(platform, { ...REGISTRY_CLIENT, clientId: 'susp-rs', tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash, canIntrospect: true, status: 'suspended' });
    const cases = [
      basic('public-rs', 'x'), basic('no-role', rsSecret.plaintext), basic('susp-rs', rsSecret.plaintext),
      basic('resource-srv', 'wrong'), basic('nobody', 'x'), null,
    ];
    for (const auth of cases) {
      const res = await introspect(platform, { auth });
      assert.equal(res.statusCode, 401, String(auth));
      assert.deepEqual(res.body, { error: 'invalid_client', error_description: 'client authentication failed' });
    }
    // client_secret_post works too.
    const post = await introspect(platform, { auth: null, body: { client_id: 'resource-srv', client_secret: rsSecret.plaintext } });
    assert.equal(post.statusCode, 200);
    assert.equal(post.body.active, true);
  });

  it('[OXI04] a session indexed by another core answers 421 with that core\'s URL', async () => {
    const res = await introspect(await seeded(), { config: fakeConfig({ 'core:id': 'core-b' }) });
    assert.equal(res.statusCode, 421);
    assert.deepEqual(res.body, { error: 'wrong_core', coreUrl: 'https://core-a.example.com' });
  });

  it('[OXI05] an app-account session: no permissions member, no scope member; a missing token is invalid_request', async () => {
    const platform = await seeded();
    const res = await introspect(platform, { token: 'cmc-token' });
    assert.equal(res.body.active, true);
    assert.equal(res.body.client_id, 'cmc-app');
    assert.equal(res.body.permissions, undefined);
    assert.ok(!Object.hasOwn(res.body, 'scope'), JSON.stringify(res.body));
    const missing = await introspect(platform, { token: '' });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.body.error, 'invalid_request');
  });

  it('[OXI06] the discovery document advertises the endpoints that are mounted', () => {
    const plain = buildDiscoveryDocument({ issuer: ISSUER, scopesSupported: [] });
    assert.equal(plain.introspection_endpoint, undefined);
    assert.equal(plain.revocation_endpoint, undefined);
    const full = buildDiscoveryDocument({ issuer: ISSUER, scopesSupported: [], introspection: true, revocation: true });
    assert.equal(full.introspection_endpoint, ISSUER + '/oauth2/introspect');
    assert.equal(full.revocation_endpoint, ISSUER + '/oauth2/revoke');
    assert.ok(!full.introspection_endpoint_auth_methods_supported.includes('none'));
    assert.ok(full.revocation_endpoint_auth_methods_supported.includes('none'));
    // A secret in the form body is accepted ([OXI03]), and advertised.
    for (const key of ['token_endpoint_auth_methods_supported', 'introspection_endpoint_auth_methods_supported', 'revocation_endpoint_auth_methods_supported']) {
      assert.ok(full[key].includes('client_secret_post'), key);
    }
  });

  async function revoke (platform, { auth = null, clientId = 'reg-app', token, hint, config = fakeConfig(), deps = {}, body = {} } = {}) {
    const res = fakeRes();
    const calls = { sessions: [] };
    await handleRevoke({
      config,
      platform,
      revokeSession: async (p) => { calls.sessions.push(p); return true; },
      coreUrlFor: async (id) => 'https://' + id + '.example.com',
      ...deps,
    })({
      headers: auth != null ? { authorization: auth } : {},
      body: { token, ...(auth == null ? { client_id: clientId } : {}), ...(hint != null ? { token_type_hint: hint } : {}), ...body },
    }, res);
    return { res, calls };
  }

  it('[ORVK1] an access token: its session is deleted (which ends its chain), 200 with no body', async () => {
    const platform = await seeded();
    const { res, calls } = await revoke(platform, { token: 'session-token-1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.raw, '');
    assert.deepEqual(calls.sessions, [{ userId: USER_ID, accessId: 'session-1', clientId: 'reg-app' }]);
  });

  it('[ORVK2] a refresh token: ended (revoked marker), and the session it backs deleted; no chain collapse exists to call; a replay finds nothing', async () => {
    const platform = await seeded();
    const { res, calls } = await revoke(platform, { token: 'refresh-1', hint: 'refresh_token' });
    assert.equal(res.statusCode, 200);
    assert.equal(await getRefresh(platform, CORE_ID, 'refresh-1'), null);
    assert.equal((await getRefreshConsumed(platform, CORE_ID, 'refresh-1')).revoked, true);
    assert.deepEqual(calls.sessions, [{ userId: USER_ID, accessId: 'session-1', clientId: 'reg-app' }]);
    const again = await revoke(platform, { token: 'refresh-1' });
    assert.equal(again.res.statusCode, 200);
    assert.deepEqual(again.calls, { sessions: [] });
    // A refresh token issued before refresh rows named their session ends alone.
    await setRefresh(platform, CORE_ID, 'refresh-legacy', {
      clientId: 'reg-app', userId: USER_ID, scope: [], issuedAt: 0, lastUsedAt: 0, expiresAt: Date.now() + 1e6, absoluteExpiresAt: Date.now() + 2e6,
    });
    const legacy = await revoke(platform, { token: 'refresh-legacy', hint: 'refresh_token' });
    assert.equal(legacy.res.statusCode, 200);
    assert.deepEqual(legacy.calls, { sessions: [] });
    assert.equal((await getRefreshConsumed(platform, CORE_ID, 'refresh-legacy')).revoked, true);
    // A failing session deletion still answers 200: the token is ended.
    const platform2 = await seeded();
    const failing = await revoke(platform2, { token: 'refresh-1', hint: 'refresh_token', deps: { revokeSession: async () => { throw new Error('down'); } } });
    assert.equal(failing.res.statusCode, 200);
    assert.equal(await getRefresh(platform2, CORE_ID, 'refresh-1'), null);
  });

  it('[ORVK3] an unknown token, or another client\'s, answers 200 and touches nothing', async () => {
    const platform = await seeded();
    for (const token of ['unknown', 'session-token-1', 'refresh-1']) {
      const { res, calls } = await revoke(platform, { auth: basic('cmc-app', appSecret.plaintext), token });
      assert.equal(res.statusCode, 200, token);
      assert.deepEqual(calls, { sessions: [] }, token);
    }
    assert.ok(await getRefresh(platform, CORE_ID, 'refresh-1') != null);
    assert.ok(await getSessionIndex(platform, 'session-token-1') != null);
  });

  it('[ORVK4] a token living on another core answers 421 with that core\'s URL', async () => {
    const platform = await seeded({ cores: [CORE_ID, 'core-b'] });
    const onB = fakeConfig({ 'core:id': 'core-b' });
    const access = await revoke(platform, { token: 'session-token-1', config: onB });
    assert.equal(access.res.statusCode, 421);
    assert.deepEqual(access.res.body, { error: 'wrong_core', coreUrl: 'https://core-a.example.com' });
    const refresh = await revoke(platform, { token: 'refresh-1', config: onB, hint: 'refresh_token' });
    assert.equal(refresh.res.statusCode, 421);
    assert.deepEqual(refresh.calls, { sessions: [] });
    assert.ok(await getRefresh(platform, CORE_ID, 'refresh-1') != null);
  });

  it('[ORVK5] client authentication: a confidential client needs its secret; unknown client or missing token refused', async () => {
    const platform = await seeded();
    const wrong = await revoke(platform, { auth: basic('cmc-app', 'wrong'), token: 'x' });
    assert.equal(wrong.res.statusCode, 401);
    assert.equal(wrong.res.body.error, 'invalid_client');
    const noSecret = await revoke(platform, { clientId: 'cmc-app', token: 'x' });
    assert.equal(noSecret.res.statusCode, 401);
    const unknown = await revoke(platform, { clientId: 'nobody', token: 'x' });
    assert.equal(unknown.res.statusCode, 401);
    const missing = await revoke(platform, { token: '' });
    assert.equal(missing.res.statusCode, 400);
    assert.equal(missing.res.body.error, 'invalid_request');
  });

  it('[ORVK6] an access token whose session is already gone still ends what its index row names', async () => {
    const platform = await seeded();
    const { res } = await revoke(platform, { token: 'session-token-1', deps: { revokeSession: async () => false } });
    assert.equal(res.statusCode, 200);
    assert.equal(await getSessionIndex(platform, 'session-token-1'), null);
    assert.equal(await getRefresh(platform, CORE_ID, 'refresh-1'), null);
    assert.equal((await getRefreshConsumed(platform, CORE_ID, 'refresh-1')).revoked, true);
  });

  describe('[OXPKA] a private_key_jwt caller named by its assertion alone (no client_id)', () => {
    const UNIFORM = { error: 'invalid_client', error_description: 'client authentication failed' };
    let keyPair, publicJwk;
    before(async () => {
      keyPair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const jwk = await crypto.webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
      publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    });
    async function assertion (aud, over = {}) {
      const nowSec = Math.floor(Date.now() / 1000);
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const input = b64({ alg: 'ES256', typ: 'JWT' }) + '.' + b64({ iss: 'key-rs', sub: 'key-rs', aud, jti: crypto.randomUUID(), exp: nowSec + 120, iat: nowSec, ...over });
      const sig = await crypto.webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, Buffer.from(input, 'utf8'));
      return input + '.' + Buffer.from(sig).toString('base64url');
    }
    async function withKeyClient () {
      const platform = await seeded();
      await persistClient(platform, { ...REGISTRY_CLIENT, clientId: 'key-rs', tokenEndpointAuthMethod: 'private_key_jwt', jwks: { keys: [publicJwk] }, canIntrospect: true });
      await setSessionIndex(platform, 'key-rs-token', { userId: USER_ID, accessId: 'session-3', clientId: 'key-rs', coreId: CORE_ID, expiresAt: Date.now() + 1e6 });
      return platform;
    }
    const assertionBody = (a) => ({ client_assertion: a, client_assertion_type: CLIENT_ASSERTION_TYPE });

    it('[OXIA1] introspection authenticates the caller from the assertion; a malformed or unknown one is refused alike', async () => {
      const platform = await withKeyClient();
      const ok = await introspect(platform, { auth: null, body: assertionBody(await assertion(ISSUER + '/oauth2/introspect')) });
      assert.equal(ok.statusCode, 200, ok.raw);
      assert.equal(ok.body.active, true);
      const bads = [
        'not-a-jwt',
        await assertion(ISSUER + '/oauth2/introspect', { iss: 'nobody', sub: 'nobody' }),
        await assertion(ISSUER + '/oauth2/introspect', { sub: 'other' }),
        // A secret-only caller allowed to introspect, named by iss: no key set to verify against.
        await assertion(ISSUER + '/oauth2/introspect', { iss: 'resource-srv', sub: 'resource-srv' }),
      ];
      for (const bad of bads) {
        const res = await introspect(platform, { auth: null, body: assertionBody(bad) });
        assert.equal(res.statusCode, 401);
        assert.deepEqual(res.body, UNIFORM);
      }
      // A body client_id other than the assertion's iss.
      const mismatch = await introspect(platform, { auth: null, body: { client_id: 'resource-srv', ...assertionBody(await assertion(ISSUER + '/oauth2/introspect')) } });
      assert.equal(mismatch.statusCode, 401);
      assert.deepEqual(mismatch.body, UNIFORM);
    });

    it('[ORVA1] revocation authenticates the caller from the assertion; a mismatching client_id or unknown iss is refused', async () => {
      const platform = await withKeyClient();
      const { res, calls } = await revoke(platform, { clientId: '', token: 'key-rs-token', body: assertionBody(await assertion(ISSUER + '/oauth2/revoke')) });
      assert.equal(res.statusCode, 200, res.raw);
      assert.deepEqual(calls.sessions, [{ userId: USER_ID, accessId: 'session-3', clientId: 'key-rs' }]);
      const mismatch = await revoke(platform, { clientId: 'reg-app', token: 'x', body: assertionBody(await assertion(ISSUER + '/oauth2/revoke')) });
      assert.equal(mismatch.res.statusCode, 401);
      assert.deepEqual(mismatch.res.body, UNIFORM);
      const unknown = await revoke(platform, { clientId: '', token: 'x', body: assertionBody(await assertion(ISSUER + '/oauth2/revoke', { iss: 'nobody', sub: 'nobody' })) });
      assert.equal(unknown.res.statusCode, 401);
      assert.deepEqual(unknown.res.body, UNIFORM);
    });
  });
});
