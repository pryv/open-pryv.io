/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ORI] OAuth2: RFC 8707 resource indicators. `resource` is a synonym of
 * `aud` at /oauth2/authorize, every audience refusal answers
 * `invalid_target`, an unlisted resource is validated then stored and
 * answered as introspection `aud`, and /oauth2/token checks a `resource`
 * against the authorization's one. Exercised through the route handlers with
 * a toy grammar and an in-memory platform store.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as extension from '../src/extension.ts';
import * as scopeGrammar from '../src/scopeGrammar.ts';
import * as signingKeys from '../src/signingKeys.ts';
import { _resetForTests as resetOfferRoute, handleOffer } from '../src/routes/offer.ts';
import { handleAuthorize } from '../src/routes/authorize.ts';
import { handleAccept } from '../src/routes/accept.ts';
import { handleToken } from '../src/routes/token.ts';
import { handleIntrospect } from '../src/introspection.ts';
import { verifyState } from '../src/signedState.ts';
import { persistClient } from '../src/clientRegistry.ts';
import { mintSecret } from '../src/clientSecret.ts';
import { clearOfferCache } from '../src/offerResolver.ts';
import { setRefresh, getRefresh } from '../src/storage.ts';
import { buildDiscoveryDocument, buildOpenIdConfiguration } from '../src/wellKnown.ts';
import { isValidResource, MAX_RESOURCE_BYTES } from '../src/resourceIndicator.ts';

const ADMIN_KEY = 'admin-key-for-tests';
const ISSUER = 'https://core.example.com';
const CONSENT_URL = 'https://consent.example.com/authorize';
const CORE_ID = 'core-a';
const AUD = 'https://resource.example.com/base';
const OTHER = 'https://other.example.com/base';
const REDIRECT = 'https://app.example.com/redirect';
const USER_ID = 'u-alice';
const VERIFIER = 'v'.repeat(50);
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url');

// --- Toy grammar: `read/<stream>` grants read on that stream. --------------

let lastCtx = {};

function toyExtension () {
  return {
    apiVersion: 1,
    name: 'toy-resource',
    scopeGrammar: {
      parse (scopeString) {
        const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
        if (tokens.some((t) => !t.startsWith('read/'))) return { ok: false, description: 'unknown token' };
        return { ok: true, tokens, offer: { permissions: tokens.map((t) => ({ streamId: t.slice(5), level: 'read' })) } };
      },
      echo ({ permissions, requestedTokens }) {
        return requestedTokens.filter((t) => permissions.some((p) => 'read/' + p.streamId === t));
      },
    },
    tokenResponse (ctx) { lastCtx.tokenResponse = ctx; return {}; },
    idTokenClaims (ctx) { lastCtx.idTokenClaims = ctx; return {}; },
    introspectionClaims (ctx) { lastCtx.introspectionClaims = ctx; return {}; },
  };
}

// --- Fakes ------------------------------------------------------------------

function fakeConfig (overrides = {}) {
  const m = {
    'service:api': ISSUER,
    'auth:adminAccessKey': ADMIN_KEY,
    'oauth:consentUrl': CONSENT_URL,
    'core:id': CORE_ID,
    ...overrides,
  };
  return { get: (k) => m[k] };
}

function fakePlatform () {
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
    async getAllCoreInfos () { return [{ id: CORE_ID }]; },
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

const REGISTRY_CLIENT = {
  clientId: 'reg-app',
  kind: 'registry',
  redirectUris: [REDIRECT],
  scope: ['read/a', 'read/b'],
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenEndpointAuthMethod: 'none',
  allowedAudiences: [AUD],
  clientName: 'Registry app',
  subjectType: 'public',
};

const CAP_URL = 'https://CapTok@cmc.example.com/';
const CMC_CLIENT = {
  clientId: 'cmc-app',
  redirectUris: [REDIRECT],
  scope: ['cmc:study'],
  grantTypes: ['authorization_code', 'refresh_token'],
  cmcOffers: { study: { capabilityUrl: CAP_URL } },
};

let rsSecret;

async function seeded (extra = {}) {
  const platform = fakePlatform();
  await persistClient(platform, { ...REGISTRY_CLIENT, ...extra });
  await persistClient(platform, {
    ...REGISTRY_CLIENT,
    clientId: 'resource-srv',
    tokenEndpointAuthMethod: 'client_secret_basic',
    clientSecretHash: rsSecret.hash,
    canIntrospect: true,
  });
  await platform.setPlatformKv('oauth-client/cmc-app', JSON.stringify(CMC_CLIENT));
  return platform;
}

const ANY = { allowedAudiences: [], anyAudience: true };

function authorizeQuery (overrides = {}) {
  const q = {
    client_id: 'reg-app',
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-state',
    scope: 'offline_access read/a',
    ...overrides,
  };
  for (const k of Object.keys(q)) if (q[k] === undefined) delete q[k];
  return q;
}

function offerFetch () {
  return async () => ({
    status: 200,
    json: async () => ({
      events: [{
        id: 'ev-offer',
        type: 'consent/request-cmc',
        content: {
          capabilityId: 'cap-1',
          request: { title: { en: 'Study' }, consent: { en: 'I agree.' }, permissions: [{ streamId: 'a', level: 'read' }] },
        },
      }],
    }),
  });
}

/** Run /authorize (GET, or POST with a form body); returns { res, signed, error }. */
async function authorize (platform, query, { method = 'GET', config = fakeConfig() } = {}) {
  const res = fakeRes();
  const req = method === 'POST'
    ? { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: query }
    : { method, query };
  await handleAuthorize({ config, platform, offerFetch: offerFetch() })(req, res);
  const location = res.headers.location ?? '';
  const signed = location.startsWith(CONSENT_URL) ? new URL(location).searchParams.get('state') : null;
  let error = null;
  if (location.startsWith(REDIRECT)) {
    const u = new URL(location);
    error = { error: u.searchParams.get('error'), description: u.searchParams.get('error_description') };
  }
  return { res, signed, error };
}

function stateAudience (signed) {
  const v = verifyState(ADMIN_KEY, signed);
  assert.equal(v.ok, true);
  return v.payload.audience;
}

function fakeCreateAccess (calls) {
  return async (params) => {
    calls.push(params);
    return {
      accessId: 'session-' + calls.length,
      accessToken: 'session-token-' + calls.length,
      apiEndpoint: 'https://session-token-' + calls.length + '@alice.example.com/',
      dataGrantAccessId: 'grant-1',
      permissions: params.grantedPermissions,
    };
  };
}

/** /authorize → /offer → /accept; returns the code. */
async function codeFor (platform, query, config = fakeConfig()) {
  const a = await authorize(platform, authorizeQuery(query), { config });
  assert.ok(a.signed, 'authorize did not reach consent: ' + JSON.stringify(a.error) + ' ' + a.res.raw);
  const deps = { config, platform };
  // A registry client's offer is re-derived by /offer; an app-account
  // client's travels in the state (the fake capability's one entry).
  let granted = [{ streamId: 'a', level: 'read' }];
  if (query.client_id == null) {
    const offerRes = fakeRes();
    await handleOffer(deps)({ body: { state: a.signed } }, offerRes);
    assert.equal(offerRes.statusCode, 200, offerRes.raw);
    granted = offerRes.body.offer.permissions;
  }
  const acc = fakeRes();
  await handleAccept({
    ...deps,
    resolveUser: async () => ({ userId: USER_ID, username: 'alice' }),
    createAccess: fakeCreateAccess([]),
  })({ body: { state: a.signed, username: 'alice', userToken: 'personal', grantedPermissions: granted } }, acc);
  assert.equal(acc.statusCode, 200, acc.raw);
  return new URL(acc.body.redirectTo).searchParams.get('code');
}

function tokenDeps (platform, config, more = {}) {
  return {
    config,
    platform,
    resolveUsername: async (id) => (id === USER_ID ? 'alice' : null),
    resolveAccess: async ({ accessId }) => ({ accessToken: 'session-token-' + accessId.split('-')[1], apiEndpoint: 'https://alice.example.com/' }),
    resolveGrantSubject: async ({ userId }) => ({ subject: userId, aliased: false }),
    revokeAccessLocal: async () => {},
    ...more,
  };
}

async function exchange (platform, code, extra = {}, { config = fakeConfig(), clientId = 'reg-app', more = {} } = {}) {
  const res = fakeRes();
  await handleToken(tokenDeps(platform, config, more))({
    headers: {},
    body: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT, ...extra },
  }, res);
  return res;
}

const SESSION = {
  permissions: [{ streamId: 'a', level: 'read' }],
  created: 1000,
  expires: 9999999999,
  subject: USER_ID,
};

async function introspect (platform, token) {
  const res = fakeRes();
  const auth = 'Basic ' + Buffer.from('resource-srv:' + rsSecret.plaintext).toString('base64');
  await handleIntrospect({
    config: fakeConfig(),
    platform,
    introspectAccess: async () => SESSION,
  })({ headers: { authorization: auth }, body: { token } }, res);
  assert.equal(res.statusCode, 200, res.raw);
  return res.body;
}

async function seedRefresh (platform, token, extra = {}) {
  const now = Date.now();
  await setRefresh(platform, CORE_ID, token, {
    clientId: 'reg-app',
    userId: USER_ID,
    scope: ['read/a'],
    issuedAt: now,
    lastUsedAt: now,
    expiresAt: now + 1e6,
    absoluteExpiresAt: now + 2e6,
    dataGrantAccessId: 'grant-1',
    permissions: [{ streamId: 'a', level: 'read' }],
    kind: 'registry',
    coreTokens: ['offline_access'],
    grammarTokens: ['read/a'],
    audience: AUD,
    ...extra,
  });
}

let mints = 0;
const mint = async () => {
  mints++;
  return {
    accessId: 'session-r' + mints,
    accessToken: 'tok-r' + mints,
    apiEndpoint: 'https://tok-r' + mints + '@alice.example.com/',
    permissions: [{ streamId: 'a', level: 'read' }],
    subject: USER_ID,
    aliased: false,
  };
};

async function refresh (platform, token, extra = {}) {
  const res = fakeRes();
  await handleToken(tokenDeps(platform, fakeConfig(), { mintRefreshedAccess: mint }))({
    headers: {}, body: { grant_type: 'refresh_token', refresh_token: token, client_id: 'reg-app', ...extra },
  }, res);
  return res;
}

describe('[ORI] OAuth2: RFC 8707 resource indicators', () => {
  before(async () => { rsSecret = await mintSecret(); });
  beforeEach(() => {
    extension.setExtension(toyExtension());
    scopeGrammar._resetForTests();
    resetOfferRoute();
    clearOfferCache();
    signingKeys._resetForTests();
    lastCtx = {};
  });
  afterEach(() => {
    extension._resetForTests();
    signingKeys._resetForTests();
  });

  it('[ORI01] GET resource naming a listed audience: consent, state and introspection carry the registered spelling', async () => {
    const platform = await seeded();
    const a = await authorize(platform, authorizeQuery({ resource: AUD + '/' }));
    assert.equal(stateAudience(a.signed), AUD);
    const code = await codeFor(platform, { resource: AUD + '/' });
    const tok = await exchange(platform, code);
    assert.equal(tok.statusCode, 200, tok.raw);
    assert.equal(tok.body.aud, undefined, 'the token response carries no aud');
    assert.equal((await introspect(platform, tok.body.access_token)).aud, AUD);
  });

  it('[ORI02] POST form: resource accepted, aud still accepted', async () => {
    const platform = await seeded();
    const r = await authorize(platform, authorizeQuery({ resource: AUD }), { method: 'POST' });
    assert.equal(stateAudience(r.signed), AUD);
    const a = await authorize(platform, authorizeQuery({ aud: AUD }), { method: 'POST' });
    assert.equal(stateAudience(a.signed), AUD);
  });

  it('[ORI03] aud and resource together: the same resource is one value, two different ones are invalid_request', async () => {
    const platform = await seeded();
    const same = await authorize(platform, authorizeQuery({ aud: AUD, resource: AUD + '/' }));
    assert.equal(stateAudience(same.signed), AUD);
    const diff = await authorize(platform, authorizeQuery({ aud: AUD, resource: OTHER }));
    assert.deepEqual(diff.error, { error: 'invalid_request', description: 'aud and resource name different resources' });
    // The same rule on a client without a list.
    const any = await seeded(ANY);
    const anyDiff = await authorize(any, authorizeQuery({ aud: AUD, resource: OTHER }));
    assert.equal(anyDiff.error.error, 'invalid_request');
  });

  it('[ORI04] listed client: missing or unregistered resource is invalid_target, with no list in the description', async () => {
    const platform = await seeded();
    const missing = await authorize(platform, authorizeQuery());
    assert.deepEqual(missing.error, { error: 'invalid_target', description: 'aud or resource is required for this client' });
    for (const [name, value] of [['resource', OTHER], ['aud', OTHER], ['resource', 'not a url'], ['resource', AUD + '#frag']]) {
      const r = await authorize(platform, authorizeQuery({ [name]: value }));
      assert.deepEqual(r.error, { error: 'invalid_target', description: name + ' is not a resource this client may access' }, name + '=' + value);
      assert.ok(!r.error.description.includes(AUD));
    }
  });

  it('[ORI05] a repeated resource is refused before any redirect', async () => {
    const platform = await seeded();
    const r = await authorize(platform, authorizeQuery({ resource: [AUD, AUD] }));
    assert.equal(r.res.statusCode, 400);
    assert.equal(r.res.headers.location, undefined);
    assert.match(r.res.raw, /given more than once: resource/);
  });

  it('[ORI06] client registered for any audience: a valid resource is stored and answered as aud, a malformed one is invalid_target', async () => {
    const platform = await seeded(ANY);
    const code = await codeFor(platform, { resource: OTHER });
    const tok = await exchange(platform, code);
    assert.equal(tok.statusCode, 200, tok.raw);
    assert.equal((await introspect(platform, tok.body.access_token)).aud, OTHER);
    // Loopback http (local development) is accepted, stored as given.
    for (const local of ['http://localhost:3000/mcp', 'http://127.0.0.1:8080/', 'http://[::1]/x']) {
      assert.equal(stateAudience((await authorize(platform, authorizeQuery({ resource: local }))).signed), local);
    }
    const tooLong = 'https://r.example.com/' + 'x'.repeat(MAX_RESOURCE_BYTES - 'https://r.example.com/'.length + 1);
    assert.equal(Buffer.byteLength(tooLong), MAX_RESOURCE_BYTES + 1);
    assert.equal(isValidResource(tooLong.slice(0, -1)), true);
    for (const bad of [OTHER + '#frag', OTHER + '#', 'http://resource.example.com/', 'http://192.168.1.10/', 'urn:example:x',
      '/relative', 'https:other.example.com', 'https://', 'https://exa mple.com/', tooLong]) {
      for (const name of ['resource', 'aud']) {
        const r = await authorize(platform, authorizeQuery({ [name]: bad }));
        assert.equal(r.error?.error, 'invalid_target', name + '=' + bad + ' ' + JSON.stringify(r.error));
        assert.match(r.error.description, new RegExp('^' + name + ' must be an absolute https URL'));
      }
    }
    // Absent: no audience, no aud in introspection (as before).
    const none = await codeFor(platform, {});
    const tokNone = await exchange(platform, none);
    assert.equal((await introspect(platform, tokNone.body.access_token)).aud, undefined);
  });

  it('[ORI07] client without an audience list (app account): same rule, stored and answered as aud', async () => {
    const platform = await seeded();
    const q = { client_id: 'cmc-app', scope: 'cmc:study' };
    const ok = await authorize(platform, authorizeQuery({ ...q, resource: 'http://localhost:9000/' }));
    assert.equal(stateAudience(ok.signed), 'http://localhost:9000/');
    for (const bad of [OTHER + '#f', 'http://resource.example.com/']) {
      const r = await authorize(platform, authorizeQuery({ ...q, resource: bad }));
      assert.equal(r.error?.error, 'invalid_target', bad);
    }
    const code = await codeFor(platform, { ...q, aud: OTHER });
    const tok = await exchange(platform, code, { resource: OTHER }, { clientId: 'cmc-app' });
    assert.equal(tok.statusCode, 200, tok.raw);
    assert.equal((await introspect(platform, tok.body.access_token)).aud, OTHER);
    const none = await codeFor(platform, q);
    const tokNone = await exchange(platform, none, {}, { clientId: 'cmc-app' });
    assert.equal((await introspect(platform, tokNone.body.access_token)).aud, undefined);
  });

  it('[ORI08] /token code grant: the same resource passes, another one consumes the code and revokes the access', async () => {
    const platform = await seeded();
    const ok = await exchange(platform, await codeFor(platform, { aud: AUD }), { resource: AUD + '/' });
    assert.equal(ok.statusCode, 200, ok.raw);
    // Absent: the code's audience applies.
    const absent = await exchange(platform, await codeFor(platform, { aud: AUD }));
    assert.equal((await introspect(platform, absent.body.access_token)).aud, AUD);

    const revoked = [];
    const more = { revokeAccessLocal: async (p) => { revoked.push(p.accessId); } };
    const code = await codeFor(platform, { resource: AUD });
    const bad = await exchange(platform, code, { resource: OTHER }, { more });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(bad.body, { error: 'invalid_target', error_description: 'resource is not the resource this authorization was granted for' });
    assert.deepEqual(revoked, ['session-1']);
    const again = await exchange(platform, code, { resource: AUD });
    assert.equal(again.body.error, 'invalid_grant');

    // A repeated resource at /token is refused the same way.
    const twice = await exchange(platform, await codeFor(platform, { aud: AUD }), { resource: [AUD, AUD] });
    assert.deepEqual(twice.body, { error: 'invalid_target', error_description: 'one resource per request' });

    // A code issued without an audience takes no resource.
    const any = await seeded(ANY);
    const noAud = await exchange(any, await codeFor(any, {}), { resource: AUD });
    assert.equal(noAud.body.error, 'invalid_target');
  });

  it('[ORI09] /token refresh grant: the same resource rotates, another one is refused and leaves the chain intact; client_credentials ignores it', async () => {
    const platform = await seeded();
    await seedRefresh(platform, 'RT-1');
    const bad = await refresh(platform, 'RT-1', { resource: OTHER });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.error, 'invalid_target');
    assert.ok(await getRefresh(platform, CORE_ID, 'RT-1'), 'the refused token is still live');
    const ok = await refresh(platform, 'RT-1', { resource: AUD + '/' });
    assert.equal(ok.statusCode, 200, ok.raw);
    assert.equal(lastCtx.tokenResponse.audience, AUD);
    const next = await getRefresh(platform, CORE_ID, ok.body.refresh_token);
    assert.equal(next.audience, AUD);
    assert.equal((await refresh(platform, ok.body.refresh_token)).statusCode, 200);

    // A chain without audience takes no resource.
    await seedRefresh(platform, 'RT-2', { audience: undefined });
    assert.equal((await refresh(platform, 'RT-2', { resource: AUD })).body.error, 'invalid_target');
    assert.ok(await getRefresh(platform, CORE_ID, 'RT-2'));

    // client_credentials: the resource is not looked at.
    const cc = await mintSecret();
    await platform.setPlatformKv('oauth-client/svc', JSON.stringify({
      clientId: 'svc', redirectUris: ['x'], scope: ['pryv:read'], grantTypes: ['client_credentials'], accountUserId: USER_ID, clientSecretHash: cc.hash,
    }));
    const res = fakeRes();
    await handleToken(tokenDeps(platform, fakeConfig(), {
      mintClientAccess: async () => ({ accessId: 'cc-1', accessToken: 'cc-tok', apiEndpoint: 'https://alice.example.com/' }),
      resolveAccountUserId: async () => USER_ID,
    }))({
      headers: { authorization: 'Basic ' + Buffer.from('svc:' + cc.plaintext).toString('base64') },
      body: { grant_type: 'client_credentials', resource: OTHER },
    }, res);
    assert.equal(res.statusCode, 200, res.raw);
  });

  it('[ORI10] response hooks receive the audience; the id_token aud stays the client id', async () => {
    const pem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const config = fakeConfig({ 'oauth:signingKeys': [{ kid: 'k1', privateKeyPem: pem }] });
    const platform = await seeded();
    const code = await codeFor(platform, { scope: 'openid read/a', nonce: 'n-1', resource: AUD }, config);
    const tok = await exchange(platform, code, {}, { config });
    assert.equal(tok.statusCode, 200, tok.raw);
    assert.equal(lastCtx.tokenResponse.audience, AUD);
    assert.equal(lastCtx.idTokenClaims.audience, AUD);
    const idToken = JSON.parse(Buffer.from(tok.body.id_token.split('.')[1], 'base64url').toString());
    assert.equal(idToken.aud, 'reg-app');
    await introspect(platform, tok.body.access_token);
    assert.equal(lastCtx.introspectionClaims.audience, AUD);

    // No audience named: the field is absent.
    const any = await seeded(ANY);
    lastCtx = {};
    const tokNone = await exchange(any, await codeFor(any, { scope: 'openid read/a' }, config), {}, { config });
    assert.equal(tokNone.statusCode, 200, tokNone.raw);
    assert.equal('audience' in lastCtx.tokenResponse, false);
    assert.equal('audience' in lastCtx.idTokenClaims, false);
    await introspect(any, tokNone.body.access_token);
    assert.equal('audience' in lastCtx.introspectionClaims, false);
  });

  it('[ORI11] discovery documents advertise nothing new', () => {
    const cfg = { issuer: ISSUER, scopesSupported: [], oidc: true, introspection: true, revocation: true };
    for (const doc of [buildDiscoveryDocument(cfg), buildOpenIdConfiguration(cfg)]) {
      assert.deepEqual(Object.keys(doc).filter((k) => /resource|audience|target/.test(k)), []);
    }
  });
});
