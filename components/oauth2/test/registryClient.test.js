/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OXREG] OAuth2 — registry clients and the OAuth extension.
 *
 * A registry client has no app account: an operator-installed extension
 * parses its whole scope string into a consent offer, and may add fields to
 * the token response, the id_token and the introspection answer. Exercised
 * end to end through the route handlers (authorize → offer → accept → token
 * → introspect) with a toy grammar and an in-memory platform store.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const extension = require('../src/extension.ts');
const scopeGrammar = require('../src/scopeGrammar.ts');
const signingKeys = require('../src/signingKeys.ts');
const { handleAuthorize } = require('../src/routes/authorize.ts');
const { handleOffer } = require('../src/routes/offer.ts');
const { handleAccept } = require('../src/routes/accept.ts');
const { handleToken } = require('../src/routes/token.ts');
const { handleIntrospect } = require('../src/introspection.ts');
const { verifyState } = require('../src/signedState.ts');
const { persistClient } = require('../src/clientRegistry.ts');
const { hashSecret, setRefresh } = require('../src/storage.ts');
const { mintSecret } = require('../src/clientSecret.ts');

const ADMIN_KEY = 'admin-key-for-tests';
const ISSUER = 'https://core.example.com';
const CONSENT_URL = 'https://consent.example.com/authorize';
const CORE_ID = 'core-a';
const AUD = 'https://resource.example.com/base';
const REDIRECT = 'http://192.168.1.10:8080/app/redirect';
const ALIAS = 'grant-alias-1';

const RSA_PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });

// --- Toy grammar: tokens map to stream permissions through a table. ---------

const TABLE = {
  'data/a.read': [['a', 'read']],
  'data/b.read': [['b', 'read']],
  'data/*.read': [['a', 'read'], ['b', 'read']],
  'cat=http://x.example|lab.read': [['lab', 'read']],
  'data/a.write': [['a', 'contribute']],
  // Shapes a careless grammar could produce; the core refuses them.
  'acct/language.write': [[':_system:language', 'contribute']],
  'acct/email.write': [[':system:email', 'contribute']],
  'acct/email.read': [[':system:email', 'read']],
  'acct/email.local': [[':local::system:email', 'contribute']],
  'acct/email.store': [[':account::system:email', 'contribute']],
  'acct/field.store': [[':account:email', 'read']],
  'acct/root.read': [[':_system:account', 'read']],
  'emails.read': [[':_emails:', 'read']],
  'all.read': [['*', 'read']],
  'local-root.read': [[':local:', 'read']],
  'data/a.manage': [['a', 'manage']],
};
const CONTEXT = ['ctx/patient', 'who', 'pseudo'];
const COVERS = { read: ['read', 'contribute', 'manage'], contribute: ['contribute', 'manage'] };

let lastCtx = {};
let hookOverride = null;

function toyExtension () {
  return {
    apiVersion: 1,
    name: 'toy',
    scopeGrammar: {
      parse (scopeString) {
        const tokens = [...new Set(scopeString.split(/\s+/).filter((t) => t !== ''))];
        const levels = new Map();
        for (const t of tokens) {
          if (CONTEXT.includes(t)) continue;
          const perms = TABLE[t];
          if (perms == null) return { ok: false, description: 'unknown token ' + t };
          for (const [s, l] of perms) {
            if (levels.get(s) !== 'contribute') levels.set(s, l);
          }
        }
        const permissions = [...levels.entries()].sort().map(([streamId, level]) => ({ streamId, level }));
        return { ok: true, tokens, offer: { permissions, ...(tokens.includes('pseudo') ? { randomAlias: true } : {}) } };
      },
      echo ({ permissions, requestedTokens }) {
        return requestedTokens.filter((t) => CONTEXT.includes(t) ||
          (TABLE[t] ?? []).every(([s, l]) => permissions.some((p) => p.streamId === s && COVERS[l].includes(p.level))));
      },
      supported () { return Object.keys(TABLE).concat(CONTEXT); },
    },
    tokenResponse (ctx) {
      lastCtx.tokenResponse = ctx;
      if (hookOverride != null) return hookOverride(ctx);
      return ctx.scopeTokens.includes('ctx/patient') ? { patient: ctx.subject } : {};
    },
    idTokenClaims (ctx) {
      lastCtx.idTokenClaims = ctx;
      return ctx.scopeTokens.includes('who') ? { who: 'P/' + ctx.subject } : {};
    },
    introspectionClaims (ctx) {
      lastCtx.introspectionClaims = ctx;
      return { patient: ctx.subject };
    },
    claimsSupported: ['who'],
  };
}

// --- Fakes ------------------------------------------------------------------

function fakeConfig (overrides = {}) {
  const m = {
    'service:api': ISSUER,
    'auth:adminAccessKey': ADMIN_KEY,
    'oauth:consentUrl': CONSENT_URL,
    'core:id': CORE_ID,
    'oauth:signingKeys': [{ kid: 'k1', alg: 'RS256', privateKeyPem: RSA_PEM }],
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

const REGISTRY_CLIENT = {
  clientId: 'reg-app',
  kind: 'registry',
  redirectUris: [REDIRECT],
  scope: ['data/*.read', 'cat=http://x.example|lab.read', 'ctx/patient', 'who'],
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenEndpointAuthMethod: 'none',
  allowedAudiences: [AUD],
  tokenResponseExtras: { banner: true },
  clientName: 'Registry app',
};

let RS_SECRET = null;
let RS_SECRET_HASH = null;

async function seed (platform, extra = {}) {
  if (RS_SECRET == null) ({ plaintext: RS_SECRET, hash: RS_SECRET_HASH } = await mintSecret());
  await persistClient(platform, { ...REGISTRY_CLIENT, ...extra });
  await persistClient(platform, {
    clientId: 'resource-srv',
    kind: 'registry',
    redirectUris: ['https://resource.example.com/unused'],
    scope: ['data/a.read'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethod: 'client_secret_basic',
    clientSecretHash: RS_SECRET_HASH,
    canIntrospect: true,
  });
}

const VERIFIER = 'v'.repeat(50);
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url');

function authorizeQuery (overrides = {}) {
  return {
    client_id: 'reg-app',
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-state',
    scope: 'openid offline_access data/*.read ctx/patient who',
    aud: AUD,
    nonce: 'n-1',
    ...overrides,
  };
}

/** Run /authorize; returns { res, state (signed), location }. */
async function authorize (deps, query) {
  const res = fakeRes();
  await handleAuthorize(deps)({ method: 'GET', query }, res);
  const location = res.headers.location ?? '';
  const signed = location.startsWith(CONSENT_URL) ? new URL(location).searchParams.get('state') : null;
  return { res, signed, location };
}

/** createAccess fake: records its input, returns a session minted under one grant. */
function fakeCreateAccess (calls) {
  return async (params) => {
    calls.push(params);
    return {
      accessId: 'session-' + calls.length,
      accessToken: 'session-token-' + calls.length,
      apiEndpoint: 'https://alice.example.com/',
      dataGrantAccessId: 'grant-1',
      permissions: params.grantedPermissions,
    };
  };
}

async function accept (deps, signed, grantedPermissions) {
  const res = fakeRes();
  await handleAccept(deps)({ body: { state: signed, username: 'alice', userToken: 'personal', grantedPermissions } }, res);
  return res;
}

function tokenDeps (platform, config, more = {}) {
  return {
    config,
    platform,
    resolveUsername: async (id) => (id === 'u-alice' ? 'alice' : null),
    resolveAccess: async ({ accessId }) => ({ accessToken: 'session-token-' + accessId.split('-')[1], apiEndpoint: 'https://alice.example.com/' }),
    resolveGrantSubject: async () => ({ subject: ALIAS, aliased: true }),
    revokeAccessLocal: async () => {},
    ...more,
  };
}

async function exchange (deps, code) {
  const res = fakeRes();
  await handleToken(deps)({
    headers: {},
    body: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'reg-app', redirect_uri: REDIRECT },
  }, res);
  return res;
}

/** Full flow up to the token response. */
async function flow ({ platform, config, query = {}, keep = null, more = {} }) {
  const deps = { config, platform };
  const a = await authorize(deps, authorizeQuery(query));
  assert.ok(a.signed, 'authorize did not redirect to consent: ' + a.location + ' ' + a.res.raw);
  const offerRes = fakeRes();
  await handleOffer(deps)({ body: { state: a.signed } }, offerRes);
  assert.equal(offerRes.statusCode, 200, offerRes.raw);
  const calls = [];
  const granted = keep == null ? offerRes.body.offer.permissions : offerRes.body.offer.permissions.filter(keep);
  const acc = await accept({ ...deps, resolveUser: async () => ({ userId: 'u-alice', username: 'alice' }), createAccess: fakeCreateAccess(calls) },
    a.signed, granted);
  assert.equal(acc.statusCode, 200, acc.raw);
  const code = new URL(acc.body.redirectTo).searchParams.get('code');
  const tok = await exchange(tokenDeps(platform, config, more), code);
  return { authorize: a, offer: offerRes.body, calls, accept: acc, token: tok };
}

/** A valid ES256 DPoP proof for POST http://core.example.com/oauth2/token. */
async function dpopProof () {
  const subtle = crypto.webcrypto.subtle;
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  const h = Buffer.from(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ jti: crypto.randomUUID(), htm: 'POST', htu: 'http://core.example.com/oauth2/token', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.from(h + '.' + p));
  return h + '.' + p + '.' + Buffer.from(sig).toString('base64url');
}

function decodeJwt (jwt) {
  const [h, p, s] = jwt.split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')), input: h + '.' + p, sig: s };
}

describe('[OXREG] OAuth2 — registry clients and the OAuth extension', () => {
  beforeEach(() => {
    extension.setExtension(toyExtension());
    scopeGrammar._resetForTests();
    signingKeys._resetForTests();
    lastCtx = {};
    hookOverride = null;
  });
  afterEach(() => {
    extension._resetForTests();
  });

  describe('[OXEXT] extension contract', () => {
    it('[OXE01] a valid factory is accepted and receives the host version and options', () => {
      let host;
      const ext = extension.createExtension((h) => { host = h; return toyExtension(); }, { options: { x: 1 } });
      assert.equal(ext.name, 'toy');
      assert.equal(host.apiVersion, 1);
      assert.deepEqual(host.options, { x: 1 });
    });
    it('[OXE02] contract violations are refused with a precise message', () => {
      assert.throws(() => extension.createExtension({}, {}), /factory function/);
      assert.throws(() => extension.createExtension(() => { throw new Error('boom'); }, {}), /factory failed: boom/);
      assert.throws(() => extension.createExtension(() => ({ ...toyExtension(), apiVersion: 2 }), {}), /apiVersion 2 not supported/);
      assert.throws(() => extension.createExtension(() => ({ ...toyExtension(), scopeGrammar: { echo () {} } }), {}), /parse must be a function/);
      assert.throws(() => extension.createExtension(() => ({ ...toyExtension(), tokenResponse: 3 }), {}), /tokenResponse must be a function/);
      assert.throws(() => extension.createExtension(() => ({ ...toyExtension(), claimsSupported: [1] }), {}), /claimsSupported/);
    });
    it('[OXE03] a hook setting a key the core owns is refused', async () => {
      hookOverride = () => ({ access_token: 'x' });
      await assert.rejects(extension.runHook('tokenResponse', { scopeTokens: [] }), /reserved key/);
    });
  });

  describe('[OXSCP] whole-scope grammar', () => {
    const client = { ...REGISTRY_CLIENT, updatedAt: 1 };
    it('[OXS01] colon-bearing tokens parse; core tokens are stripped before the grammar', () => {
      const r = scopeGrammar.resolveRequestedScope(client, 'openid cat=http://x.example|lab.read offline_access', { oidcEnabled: true });
      assert.equal(r.ok, true, r.description);
      assert.deepEqual(r.coreTokens, ['openid', 'offline_access']);
      assert.deepEqual(r.grammarTokens, ['cat=http://x.example|lab.read']);
      assert.deepEqual(r.offer.permissions, [{ streamId: 'lab', level: 'read' }]);
    });
    it('[OXS02] a narrower request is accepted; a wider level or an unknown stream is refused', () => {
      assert.equal(scopeGrammar.resolveRequestedScope(client, 'data/a.read', { oidcEnabled: true }).ok, true);
      const wider = scopeGrammar.resolveRequestedScope(client, 'data/a.write', { oidcEnabled: true });
      assert.equal(wider.ok, false);
      assert.match(wider.description, /maximum scope set/);
      assert.equal(scopeGrammar.resolveRequestedScope(client, 'nope', { oidcEnabled: true }).ok, false);
    });
    it('[OXS03] openid without a signing key is refused; offline_access without the refresh grant is dropped', () => {
      assert.match(scopeGrammar.resolveRequestedScope(client, 'openid data/a.read', { oidcEnabled: false }).description, /openid/);
      const r = scopeGrammar.resolveRequestedScope({ ...client, grantTypes: ['authorization_code'] }, 'offline_access data/a.read', { oidcEnabled: true });
      assert.deepEqual(r.coreTokens, []);
    });
    it('[OXS04] no grammar installed: refused', () => {
      extension._resetForTests();
      assert.match(scopeGrammar.resolveRequestedScope(client, 'data/a.read', { oidcEnabled: true }).description, /no scope grammar/);
    });
    it('[OXS05] a grammar that throws is reported as an invalid scope, not a crash', () => {
      extension.setExtension({ ...toyExtension(), scopeGrammar: { ...toyExtension().scopeGrammar, parse () { throw new Error('x'); } } });
      assert.equal(scopeGrammar.resolveRequestedScope(client, 'data/a.read', { oidcEnabled: true }).ok, false);
    });
    it('[OXS06] account and system streams are refused whatever the grammar answers, in any spelling', () => {
      for (const token of ['acct/language.write', 'acct/email.write', 'acct/email.read', 'acct/email.local',
        'acct/email.store', 'acct/field.store', 'acct/root.read', 'emails.read']) {
        const r = scopeGrammar.resolveRequestedScope(client, 'data/a.read ' + token, { oidcEnabled: true });
        assert.equal(r.ok, false, token);
        assert.match(r.description, /account or system stream/, token + ': ' + r.description);
      }
    });
    it('[OXS07] a permission on every stream (*), in any spelling, is refused', () => {
      for (const token of ['all.read', 'local-root.read']) {
        const r = scopeGrammar.resolveRequestedScope(client, token, { oidcEnabled: true });
        assert.equal(r.ok, false, token);
        assert.match(r.description, /every stream/, token + ': ' + r.description);
      }
    });
    it('[OXS08] level manage is refused', () => {
      const r = scopeGrammar.resolveRequestedScope(client, 'data/a.manage', { oidcEnabled: true });
      assert.equal(r.ok, false);
      assert.match(r.description, /manage/);
    });
    it('[OXS09] the same rules hold on the registered maximum set; feature permissions pass', () => {
      const wide = { ...client, clientId: 'wide-app', scope: [...client.scope, 'acct/email.write'] };
      const r = scopeGrammar.resolveRequestedScope(wide, 'data/a.read', { oidcEnabled: true });
      assert.equal(r.ok, false);
      assert.match(r.description, /registered scope.*account or system stream/);
      // Positive control: an ordinary stream plus a feature permission.
      const toy = toyExtension();
      extension.setExtension({
        ...toy,
        scopeGrammar: {
          ...toy.scopeGrammar,
          parse (s, ctx) {
            const out = toy.scopeGrammar.parse(s, ctx);
            if (out.ok) out.offer.permissions.push({ feature: 'selfRevoke', setting: 'forbidden' });
            return out;
          },
        },
      });
      const ok = scopeGrammar.resolveRequestedScope(client, 'data/a.read', { oidcEnabled: true });
      assert.equal(ok.ok, true, ok.description);
      assert.deepEqual(ok.offer.permissions, [{ streamId: 'a', level: 'read' }, { feature: 'selfRevoke', setting: 'forbidden' }]);
    });
  });

  describe('[OXAUT] /authorize', () => {
    it('[OXA01] the state carries the offer by reference only, bounded in size', async () => {
      const platform = fakePlatform(); await seed(platform);
      const { signed } = await authorize({ config: fakeConfig(), platform }, authorizeQuery());
      const v = verifyState(ADMIN_KEY, signed);
      assert.equal(v.ok, true);
      assert.equal(v.payload.offer, undefined);
      assert.equal(v.payload.offerRef.kind, 'synthesised');
      assert.equal(v.payload.nonce, 'n-1');
      assert.equal(v.payload.audience, AUD);
      assert.ok(signed.length < 1500, 'state length ' + signed.length);
    });
    it('[OXA02] an http redirect URI that is not loopback is accepted when registered exactly', async () => {
      const platform = fakePlatform(); await seed(platform);
      const { signed } = await authorize({ config: fakeConfig(), platform }, authorizeQuery());
      assert.ok(signed);
    });
    it('[OXA03] aud: missing or foreign refused, trailing slash tolerated', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      for (const aud of [undefined, 'https://other.example.com/base']) {
        const { res } = await authorize(deps, authorizeQuery({ aud }));
        assert.match(res.headers.location, /^http:\/\/192\.168\.1\.10:8080\/app\/redirect\?error=invalid_request/);
      }
      const { signed } = await authorize(deps, authorizeQuery({ aud: AUD + '/' }));
      assert.equal(verifyState(ADMIN_KEY, signed).payload.audience, AUD);
    });
    it('[OXA04] a suspended client is refused', async () => {
      const platform = fakePlatform(); await seed(platform, { status: 'suspended' });
      const { res } = await authorize({ config: fakeConfig(), platform }, authorizeQuery());
      assert.match(res.headers.location, /error=access_denied/);
    });
    it('[OXA05] POST with a form body works like GET; JSON and repeated parameters are refused', async () => {
      const platform = fakePlatform(); await seed(platform);
      const handler = handleAuthorize({ config: fakeConfig(), platform });
      const ok = fakeRes();
      await handler({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: authorizeQuery() }, ok);
      assert.equal(ok.statusCode, 302);
      assert.ok(ok.headers.location.startsWith(CONSENT_URL));
      const json = fakeRes();
      await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: authorizeQuery() }, json);
      assert.equal(json.statusCode, 400);
      const twice = fakeRes();
      await handler({ method: 'GET', query: authorizeQuery({ redirect_uri: [REDIRECT, 'https://evil.example/'] }) }, twice);
      assert.equal(twice.statusCode, 400);
      assert.match(twice.raw, /redirect_uri/);
    });
    it('[OXA06] app-account clients still need exactly one cmc: token', async () => {
      const platform = fakePlatform(); await seed(platform);
      await platform.setPlatformKv('oauth-client/cmc-app', JSON.stringify({
        clientId: 'cmc-app',
        redirectUris: [REDIRECT],
        scope: ['cmc:a'],
        grantTypes: ['authorization_code'],
        cmcOffers: { a: { capabilityUrl: 'https://t@x.example/' } },
      }));
      const { res } = await authorize({ config: fakeConfig(), platform }, authorizeQuery({ client_id: 'cmc-app', aud: undefined, scope: 'data/a.read' }));
      assert.match(res.headers.location, /error=invalid_scope/);
    });
  });

  describe('[OXOFR] offer endpoint and /accept', () => {
    it('[OXO01] the offer endpoint returns the client display and the re-derived offer', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      const { signed } = await authorize(deps, authorizeQuery());
      const res = fakeRes();
      await handleOffer(deps)({ body: { state: signed } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.body.client.clientName, 'Registry app');
      assert.deepEqual(res.body.offer.permissions, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]);
    });
    it('[OXO02] a client updated between /authorize and /accept invalidates the state', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      const { signed } = await authorize(deps, authorizeQuery());
      await new Promise((resolve) => setTimeout(resolve, 5));
      await persistClient(platform, { ...REGISTRY_CLIENT, clientName: 'renamed' });
      const res = await accept({ ...deps, resolveUser: async () => ({ userId: 'u-alice', username: 'alice' }), createAccess: fakeCreateAccess([]) },
        signed, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error_description, /changed/);
    });
    it('[OXO03] /accept mints from the synthesised offer, without CMC material', async () => {
      const platform = fakePlatform(); await seed(platform);
      const { calls } = await flow({ platform, config: fakeConfig() });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].offer, { kind: 'synthesised', permissions: [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }], randomAlias: false });
    });
    it('[OXO05] the app asks for a pseudonym through its scope: the offer and the mint carry randomAlias', async () => {
      const platform = fakePlatform(); await seed(platform);
      await persistClient(platform, { ...REGISTRY_CLIENT, scope: [...REGISTRY_CLIENT.scope, 'pseudo'] });
      const { calls, offer } = await flow({ platform, config: fakeConfig(), query: { scope: 'data/a.read pseudo' } });
      assert.equal(offer.offer.randomAlias, true);
      assert.equal(calls[0].offer.randomAlias, true);
    });
    it('[OXO06] a pairwise client always gets an aliased grant, pseudonym asked or not; public by default', async () => {
      const platform = fakePlatform(); await seed(platform, { subjectType: 'pairwise' });
      const { calls, offer } = await flow({ platform, config: fakeConfig(), query: { scope: 'data/a.read' } });
      assert.equal(offer.offer.randomAlias, true);
      assert.equal(calls[0].offer.randomAlias, true);
      const client = { ...REGISTRY_CLIENT, updatedAt: 1 };
      assert.equal(scopeGrammar.resolveRequestedScope(client, 'data/a.read', { oidcEnabled: true }).offer.randomAlias, false);
      assert.equal(scopeGrammar.resolveRequestedScope({ ...client, subjectType: 'public' }, 'data/a.read', { oidcEnabled: true }).offer.randomAlias, false);
    });
    it('[OXO04] a grant wider than the offer is refused (all or nothing by default)', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      const { signed } = await authorize(deps, authorizeQuery({ scope: 'data/a.read' }));
      const res = await accept({ ...deps, resolveUser: async () => ({ userId: 'u-alice', username: 'alice' }), createAccess: fakeCreateAccess([]) },
        signed, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]);
      assert.equal(res.statusCode, 400);
    });
  });

  describe('[OXTOK] token response', () => {
    it('[OXT01] scope echo, extras, hook fields, id_token; no apiEndpoint', async () => {
      const platform = fakePlatform(); await seed(platform);
      const { token } = await flow({ platform, config: fakeConfig() });
      assert.equal(token.statusCode, 200, token.raw);
      const b = token.body;
      assert.deepEqual(b.scope.split(' ').sort(), ['ctx/patient', 'data/*.read', 'offline_access', 'openid', 'who']);
      assert.equal(b.banner, true);
      assert.equal(b.patient, ALIAS);
      assert.equal(b.apiEndpoint, undefined);
      assert.equal(typeof b.refresh_token, 'string');
      const jwt = decodeJwt(b.id_token);
      assert.deepEqual(jwt.header, { alg: 'RS256', kid: 'k1', typ: 'JWT' });
      assert.equal(jwt.payload.iss, ISSUER);
      assert.equal(jwt.payload.sub, ALIAS);
      assert.equal(jwt.payload.aud, 'reg-app');
      assert.equal(jwt.payload.nonce, 'n-1');
      assert.equal(jwt.payload.who, 'P/' + ALIAS);
      const pub = crypto.createPublicKey(crypto.createPrivateKey(RSA_PEM));
      assert.ok(crypto.verify('sha256', Buffer.from(jwt.input), pub, Buffer.from(jwt.sig, 'base64url')));
    });
    it('[OXT02] hooks receive the GRANTED tokens: a token whose permissions were unticked is absent', async () => {
      const platform = fakePlatform(); await seed(platform);
      // The offer allows no user choice by default: grant the whole offer for
      // 'data/a.read data/b.read', then narrow through an offer that allows it.
      extension.setExtension({
        ...toyExtension(),
        scopeGrammar: {
          ...toyExtension().scopeGrammar,
          parse (s, ctx) { const r = toyExtension().scopeGrammar.parse(s, ctx); if (r.ok) r.offer.allowUserChoice = true; return r; },
        },
      });
      const { token } = await flow({
        platform,
        config: fakeConfig(),
        query: { scope: 'openid data/a.read data/b.read ctx/patient' },
        keep: (p) => p.streamId === 'a',
      });
      assert.equal(token.statusCode, 200, token.raw);
      const expected = ['ctx/patient', 'data/a.read', 'openid'];
      assert.deepEqual(token.body.scope.split(' ').sort(), expected);
      assert.deepEqual([...lastCtx.tokenResponse.scopeTokens].sort(), expected);
      assert.deepEqual([...lastCtx.idTokenClaims.scopeTokens].sort(), expected);
      assert.deepEqual(lastCtx.tokenResponse.permissions, [{ streamId: 'a', level: 'read' }]);
      assert.equal(lastCtx.tokenResponse.client.clientSecretHash, undefined);
    });
    it('[OXT03] no refresh token without offline_access; no id_token without openid', async () => {
      const platform = fakePlatform(); await seed(platform);
      const { token } = await flow({ platform, config: fakeConfig(), query: { scope: 'data/a.read' } });
      assert.equal(token.statusCode, 200, token.raw);
      assert.equal(token.body.refresh_token, undefined);
      assert.equal(token.body.id_token, undefined);
      assert.equal([...platform._state.keys()].some((k) => k.startsWith('oauth-rt/')), false);
    });
    it('[OXT04] a hook setting a reserved key answers 500, leaves no refresh row and removes the session', async () => {
      const platform = fakePlatform(); await seed(platform);
      hookOverride = () => ({ scope: 'everything' });
      const revoked = [];
      const { token } = await flow({ platform, config: fakeConfig(), more: { revokeAccessLocal: async (p) => { revoked.push(p.accessId); } } });
      assert.equal(token.statusCode, 500);
      assert.equal(token.body.error, 'server_error');
      assert.equal([...platform._state.keys()].some((k) => k.startsWith('oauth-rt/')), false);
      assert.deepEqual(revoked, ['session-1']);
    });
    it('[OXT05] openid without a subject is a server error, never a fallback to the user', async () => {
      const platform = fakePlatform(); await seed(platform);
      const { token } = await flow({ platform, config: fakeConfig(), more: { resolveGrantSubject: async () => null } });
      assert.equal(token.statusCode, 500);
    });
    it('[OXT08] without a pseudonym the subject is the user id, never the username, and apiEndpoint is sent', async () => {
      const platform = fakePlatform(); await seed(platform);
      const { token } = await flow({ platform, config: fakeConfig(), more: { resolveGrantSubject: async ({ userId }) => ({ subject: userId, aliased: false }) } });
      assert.equal(token.statusCode, 200, token.raw);
      assert.equal(token.body.apiEndpoint, 'https://alice.example.com/');
      assert.equal(token.body.patient, 'u-alice');
      assert.equal(decodeJwt(token.body.id_token).payload.sub, 'u-alice');
    });
    it('[OXT09] a registry client presenting a DPoP proof is refused before its code is consumed', async () => {
      const platform = fakePlatform(); await seed(platform);
      const config = fakeConfig();
      const deps = { config, platform };
      const a = await authorize(deps, authorizeQuery({ scope: 'data/a.read' }));
      const offerRes = fakeRes();
      await handleOffer(deps)({ body: { state: a.signed } }, offerRes);
      const acc = await accept({ ...deps, resolveUser: async () => ({ userId: 'u-alice', username: 'alice' }), createAccess: fakeCreateAccess([]) },
        a.signed, offerRes.body.offer.permissions);
      const code = new URL(acc.body.redirectTo).searchParams.get('code');
      const body = { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'reg-app', redirect_uri: REDIRECT };
      // A VALID proof, and the binding wired: only the client kind refuses it.
      const proof = await dpopProof();
      const bound = [];
      const deps2 = tokenDeps(platform, config, { bindAccessDpop: async (p) => { bound.push(p); } });
      const refused = fakeRes();
      await handleToken(deps2)({ headers: { host: 'core.example.com', dpop: proof }, originalUrl: '/oauth2/token', body }, refused);
      assert.equal(refused.statusCode, 400, refused.raw);
      assert.equal(refused.body.error, 'invalid_request');
      assert.match(refused.body.error_description, /DPoP/);
      assert.deepEqual(bound, []);
      // The code is still there: the same exchange without a proof succeeds.
      const ok = await exchange(tokenDeps(platform, config), code);
      assert.equal(ok.statusCode, 200, ok.raw);
      // The refresh grant is refused the same way, before the row is touched.
      const rt = fakeRes();
      await handleToken(deps2)({ headers: { host: 'core.example.com', dpop: await dpopProof() }, originalUrl: '/oauth2/token', body: { grant_type: 'refresh_token', refresh_token: 'RT-none', client_id: 'reg-app' } }, rt);
      assert.equal(rt.statusCode, 400, rt.raw);
      assert.equal(rt.body.error, 'invalid_request');
    });
    it('[OXT06] refresh: the echo follows the effective (narrowed) permissions', async () => {
      const platform = fakePlatform(); await seed(platform);
      const now = Date.now();
      await setRefresh(platform, CORE_ID, 'RT-X', {
        clientId: 'reg-app',
        userId: 'u-alice',
        scope: ['data/*.read'],
        issuedAt: now,
        lastUsedAt: now,
        expiresAt: now + 1e6,
        absoluteExpiresAt: now + 2e6,
        dataGrantAccessId: 'grant-1',
        permissions: [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }],
        kind: 'registry',
        coreTokens: ['offline_access'],
        grammarTokens: ['data/a.read', 'data/b.read', 'ctx/patient'],
      });
      const res = fakeRes();
      await handleToken(tokenDeps(platform, fakeConfig(), {
        mintRefreshedAccess: async () => ({
          accessId: 'session-9',
          accessToken: 'tok-9',
          apiEndpoint: 'https://alice.example.com/',
          permissions: [{ streamId: 'b', level: 'read' }],
          subject: ALIAS,
          aliased: true,
        }),
      }))({ headers: {}, body: { grant_type: 'refresh_token', refresh_token: 'RT-X', client_id: 'reg-app' } }, res);
      assert.equal(res.statusCode, 200, res.raw);
      assert.deepEqual(res.body.scope.split(' ').sort(), ['ctx/patient', 'data/b.read', 'offline_access']);
      assert.equal(res.body.patient, ALIAS);
      assert.equal(res.body.id_token, undefined);
      assert.equal(res.body.apiEndpoint, undefined);
    });
    it('[OXT07] a suspended client cannot exchange its code', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      const { signed } = await authorize(deps, authorizeQuery());
      const acc = await accept({ ...deps, resolveUser: async () => ({ userId: 'u-alice', username: 'alice' }), createAccess: fakeCreateAccess([]) },
        signed, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]);
      await persistClient(platform, { ...REGISTRY_CLIENT, status: 'suspended' });
      const tok = await exchange(tokenDeps(platform, fakeConfig()), new URL(acc.body.redirectTo).searchParams.get('code'));
      assert.equal(tok.statusCode, 400);
      assert.equal(tok.body.error, 'unauthorized_client');
    });
  });

  describe('[OXINT] introspection', () => {
    const basic = (id, secret) => 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');
    const SESSION = { permissions: [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }, { feature: 'selfRevoke', setting: 'allowed' }], created: 1000, expires: 9999999999, subject: ALIAS };
    async function introspect (platform, { auth = basic('resource-srv', RS_SECRET), token = 'session-token-1', session = SESSION, config = fakeConfig() } = {}) {
      const res = fakeRes();
      await handleIntrospect({
        config,
        platform,
        introspectAccess: async () => session,
        coreUrlFor: async (id) => 'https://' + id + '.example.com',
      })({ headers: { authorization: auth }, body: { token } }, res);
      return res;
    }
    async function seeded () {
      const platform = fakePlatform(); await seed(platform);
      await flow({ platform, config: fakeConfig() });
      return platform;
    }
    it('[OXI01] an active session: scope echo, client, subject, audience, extension claims', async () => {
      const res = await introspect(await seeded());
      assert.equal(res.statusCode, 200, res.raw);
      const b = res.body;
      assert.equal(b.active, true);
      assert.deepEqual(b.scope.split(' ').sort(), ['ctx/patient', 'data/*.read', 'offline_access', 'openid', 'who']);
      assert.equal(b.client_id, 'reg-app');
      assert.equal(b.sub, ALIAS);
      assert.equal(b.patient, ALIAS);
      assert.equal(b.aud, AUD);
      assert.equal(b.iss, ISSUER);
      assert.equal(b.token_type, 'Bearer');
    });
    it('[OXI02] unknown token, dead session, revoked client: inactive', async () => {
      const platform = await seeded();
      assert.deepEqual((await introspect(platform, { token: 'nope' })).body, { active: false });
      assert.deepEqual((await introspect(platform, { session: null })).body, { active: false });
      await platform.setPlatformKv('oauth-client-revoked/reg-app', JSON.stringify({ clientId: 'reg-app', revokedAt: Date.now() }));
      assert.deepEqual((await introspect(platform)).body, { active: false });
    });
    it('[OXI03] callers: public, not allowed, or wrong secret are refused alike', async () => {
      const platform = await seeded();
      for (const auth of [basic('reg-app', 'x'), basic('resource-srv', 'wrong'), null]) {
        const res = await introspect(platform, { auth });
        assert.equal(res.statusCode, 401);
        assert.equal(res.body.error, 'invalid_client');
      }
    });
    it('[OXI04] a session indexed by another core answers 421 with that core\'s URL', async () => {
      const res = await introspect(await seeded(), { config: fakeConfig({ 'core:id': 'core-b' }) });
      assert.equal(res.statusCode, 421);
      assert.deepEqual(res.body, { error: 'wrong_core', coreUrl: 'https://core-a.example.com' });
    });
    it('[OXI05] the index row holds no token and no username', async () => {
      const platform = await seeded();
      const row = platform._state.get('oauth-at/' + hashSecret('session-token-1'));
      assert.ok(row != null);
      const json = JSON.stringify(row.value);
      assert.ok(!json.includes('session-token-1'));
      assert.ok(!json.includes('"alice"'));
      assert.ok(!json.includes(ALIAS));
    });
  });

  describe('[OXKEY] signing keys', () => {
    it('[OXK01] the JWK Set carries public members only', () => {
      const set = signingKeys.publicJwkSet(signingKeys.loadSigningKeys(fakeConfig()));
      assert.equal(set.keys.length, 1);
      assert.deepEqual(Object.keys(set.keys[0]).sort(), ['alg', 'e', 'kid', 'kty', 'n', 'use']);
    });
    it('[OXK02] a bad key entry fails loudly', () => {
      const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
      const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
      for (const [entry, re] of [
        [{ alg: 'RS256', privateKeyPem: RSA_PEM }, /kid is required/],
        [{ kid: 'a', alg: 'ES256', privateKeyPem: RSA_PEM }, /RS256/],
        [{ kid: 'a', alg: 'RS256', privateKeyPem: ec }, /RSA key/],
        [{ kid: 'a', alg: 'RS256', privateKeyPem: small }, /at least 2048/],
        [{ kid: 'a', alg: 'RS256', privateKeyPem: 'garbage' }, /cannot be read/],
      ]) {
        assert.throws(() => signingKeys.loadSigningKeys(fakeConfig({ 'oauth:signingKeys': [entry] })), re);
      }
    });
  });

  describe('[OXREGW] registry client registration', () => {
    it('[OXW01] registry rows refuse app-account material and need an auth method', async () => {
      const platform = fakePlatform();
      await assert.rejects(persistClient(platform, { ...REGISTRY_CLIENT, accountUserId: 'u' }), /accountUserId/);
      await assert.rejects(persistClient(platform, { ...REGISTRY_CLIENT, cmcOffers: { a: { capabilityUrl: 'https://t@x/' } } }), /cmcOffers/);
      await assert.rejects(persistClient(platform, { ...REGISTRY_CLIENT, tokenEndpointAuthMethod: undefined }), /tokenEndpointAuthMethod/);
      await assert.rejects(persistClient(platform, { ...REGISTRY_CLIENT, allowedAudiences: ['http://x.example/'] }), /https/);
      await assert.rejects(persistClient(platform, { ...REGISTRY_CLIENT, grantTypes: ['client_credentials'] }), /client_credentials/);
      await assert.rejects(persistClient(platform, { ...REGISTRY_CLIENT, dpopBoundAccessTokens: true }), /DPoP/);
      await assert.rejects(persistClient(platform, { ...REGISTRY_CLIENT, subjectType: 'per-user' }), /subjectType/);
      await persistClient(platform, { ...REGISTRY_CLIENT, subjectType: 'pairwise' });
    });
  });
});
