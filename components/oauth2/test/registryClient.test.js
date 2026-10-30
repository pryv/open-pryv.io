/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OXREG] OAuth2: registry clients and the OAuth extension.
 *
 * A registry client has no app account: an operator-installed extension
 * parses its whole scope string into a consent offer, and may add fields to
 * the token response. Exercised end to end through the route handlers
 * (authorize → offer → accept → token → refresh) with a toy grammar and an
 * in-memory platform store.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const extension = require('../src/extension.ts');
const scopeGrammar = require('../src/scopeGrammar.ts');
const offerRoute = require('../src/routes/offer.ts');
const { handleAuthorize } = require('../src/routes/authorize.ts');
const { handleOffer } = require('../src/routes/offer.ts');
const { handleAccept } = require('../src/routes/accept.ts');
const { handleToken } = require('../src/routes/token.ts');
const { verifyState } = require('../src/signedState.ts');
const { persistClient } = require('../src/clientRegistry.ts');
const { hashSecret, setRefresh, setClient } = require('../src/storage.ts');
const { checkRegistryClients } = require('../src/registryBootCheck.ts');
const { decodeBasicAuth } = require('../src/clientAuth.ts');
const oauth2 = require('../src/index.ts');

const ADMIN_KEY = 'admin-key-for-tests';
const ISSUER = 'https://core.example.com';
const CONSENT_URL = 'https://consent.example.com/authorize';
const CORE_ID = 'core-a';
const AUD = 'https://resource.example.com/base';
const REDIRECT = 'https://app.example.com/redirect';
const INSECURE_REDIRECT = 'http://192.168.1.10:8080/app/redirect';
const USER_ID = 'u-alice';

// --- Toy grammar: tokens map to stream permissions through a table. ---------

const TABLE = {
  'data/a.read': [['a', 'read']],
  'data/b.read': [['b', 'read']],
  'data/*.read': [['a', 'read'], ['b', 'read']],
  'cat=http://x.example|lab.read': [['lab', 'read']],
  'data/a.write': [['a', 'contribute']],
  'data/a.add': [['a', 'create-only']],
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
  'dup.local': [['a', 'read'], [':local:a', 'read']],
};
const CONTEXT = ['ctx/patient', 'who', 'pseudo'];
const COVERS = { read: ['read', 'contribute', 'manage'], contribute: ['contribute', 'manage'], 'create-only': ['create-only', 'contribute', 'manage'] };

let lastCtx = {};
let hookOverride = null;
let parseCalls = 0;

function toyExtension () {
  return {
    apiVersion: 1,
    name: 'toy',
    scopeGrammar: {
      parse (scopeString, ctx) {
        if (ctx?.purpose === 'request') parseCalls++;
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
  };
}

/** The toy grammar with its `parse` answer post-processed. */
function toyWith (mapOffer) {
  const toy = toyExtension();
  return {
    ...toy,
    scopeGrammar: {
      ...toy.scopeGrammar,
      parse (s, ctx) {
        const out = toy.scopeGrammar.parse(s, ctx);
        if (out.ok) mapOffer(out.offer, ctx);
        return out;
      },
    },
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
  subjectType: 'public',
};

async function seed (platform, extra = {}) {
  await persistClient(platform, { ...REGISTRY_CLIENT, ...extra });
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
    scope: 'offline_access data/*.read ctx/patient who',
    aud: AUD,
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

/** The error redirect of a refused /authorize, parsed. */
function redirectError (res) {
  const u = new URL(res.headers.location);
  return { error: u.searchParams.get('error'), description: u.searchParams.get('error_description') };
}

/** createAccess fake: records its input, returns a session minted under one grant. */
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

function acceptDeps (deps, calls = []) {
  return { ...deps, resolveUser: async () => ({ userId: USER_ID, username: 'alice' }), createAccess: fakeCreateAccess(calls) };
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
    resolveUsername: async (id) => (id === USER_ID ? 'alice' : null),
    resolveAccess: async ({ accessId }) => ({ accessToken: 'session-token-' + accessId.split('-')[1], apiEndpoint: 'https://alice.example.com/' }),
    resolveGrantSubject: async ({ userId }) => ({ subject: userId, aliased: false }),
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

async function postOffer (deps, signed) {
  const res = fakeRes();
  await handleOffer(deps)({ body: { state: signed } }, res);
  return res;
}

/** Full flow up to the token response. */
async function flow ({ platform, config, query = {}, keep = null, more = {} }) {
  const deps = { config, platform };
  const a = await authorize(deps, authorizeQuery(query));
  assert.ok(a.signed, 'authorize did not redirect to consent: ' + a.location + ' ' + a.res.raw);
  const offerRes = await postOffer(deps, a.signed);
  assert.equal(offerRes.statusCode, 200, offerRes.raw);
  const calls = [];
  const granted = keep == null ? offerRes.body.offer.permissions : offerRes.body.offer.permissions.filter(keep);
  const acc = await accept(acceptDeps(deps, calls), a.signed, granted);
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

async function seedRefresh (platform, token, extra = {}) {
  const now = Date.now();
  await setRefresh(platform, CORE_ID, token, {
    clientId: 'reg-app',
    userId: USER_ID,
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
    ...extra,
  });
}

async function refresh (platform, token, mint, more = {}) {
  const res = fakeRes();
  await handleToken(tokenDeps(platform, fakeConfig(), { mintRefreshedAccess: mint, ...more }))({
    headers: {}, body: { grant_type: 'refresh_token', refresh_token: token, client_id: 'reg-app' },
  }, res);
  return res;
}

const refreshedMint = (permissions = [{ streamId: 'b', level: 'read' }]) => async () => ({
  accessId: 'session-9',
  accessToken: 'tok-9',
  apiEndpoint: 'https://tok-9@alice.example.com/',
  permissions,
  subject: USER_ID,
  aliased: false,
});

describe('[OXREG] OAuth2: registry clients and the OAuth extension', () => {
  beforeEach(() => {
    extension.setExtension(toyExtension());
    scopeGrammar._resetForTests();
    offerRoute._resetForTests();
    lastCtx = {};
    hookOverride = null;
    parseCalls = 0;
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
      assert.throws(() => extension.createExtension(() => ({ ...toyExtension(), idTokenClaims: 'x' }), {}), /idTokenClaims must be a function/);
      assert.throws(() => extension.createExtension(() => ({ ...toyExtension(), claimsSupported: [1] }), {}), /claimsSupported/);
    });
    it('[OXE03] a hook setting a key the core owns is refused', async () => {
      hookOverride = () => ({ access_token: 'x' });
      await assert.rejects(extension.runHook('tokenResponse', { scopeTokens: [] }), /reserved key/);
    });
    it('[OXE04] a hook that does not settle within the configured bound fails; a fast one passes', async () => {
      extension.setExtension(toyExtension(), { hookTimeoutMs: 30 });
      hookOverride = () => new Promise(() => {});
      const started = Date.now();
      await assert.rejects(extension.runHook('tokenResponse', { scopeTokens: [] }), /failed/);
      assert.ok(Date.now() - started < 2000);
      hookOverride = async () => ({ fast: true });
      assert.deepEqual(await extension.runHook('tokenResponse', { scopeTokens: [] }), { fast: true });
      // An invalid bound keeps the default (the hook is still awaited).
      extension.setExtension(toyExtension(), { hookTimeoutMs: -1 });
      hookOverride = () => new Promise((resolve) => setTimeout(() => resolve({ late: 1 }), 50));
      assert.deepEqual(await extension.runHook('tokenResponse', { scopeTokens: [] }), { late: 1 });
    });
    it('[OXE05] the pseudonym switch is one exported constant, off', () => {
      assert.equal(scopeGrammar.PSEUDONYM_SUBJECTS_AVAILABLE, false);
      assert.equal(oauth2.PSEUDONYM_SUBJECTS_AVAILABLE, false);
    });
    it('[OXE06] Basic client credentials are decoded by the shared helper', () => {
      const b = (s) => 'Basic ' + Buffer.from(s).toString('base64');
      assert.deepEqual(decodeBasicAuth(b('id:se%3Acret')), { client_id: 'id', client_secret: 'se:cret' });
      assert.deepEqual(decodeBasicAuth('basic ' + Buffer.from('id:s').toString('base64')), { client_id: 'id', client_secret: 's' });
      assert.equal(decodeBasicAuth(b(':s')), null);
      assert.equal(decodeBasicAuth('Bearer x'), null);
      assert.equal(decodeBasicAuth(undefined), null);
    });
  });

  describe('[OXSCP] whole-scope grammar', () => {
    const client = { ...REGISTRY_CLIENT, updatedAt: 1 };
    it('[OXS01] colon-bearing tokens parse; core tokens are stripped before the grammar', () => {
      const r = scopeGrammar.resolveRequestedScope(client, 'cat=http://x.example|lab.read offline_access');
      assert.equal(r.ok, true, r.description);
      assert.deepEqual(r.coreTokens, ['offline_access']);
      assert.deepEqual(r.grammarTokens, ['cat=http://x.example|lab.read']);
      assert.deepEqual(r.offer.permissions, [{ streamId: 'lab', level: 'read' }]);
    });
    it('[OXS02] a narrower request is accepted; a wider level or an unknown stream is refused', () => {
      assert.equal(scopeGrammar.resolveRequestedScope(client, 'data/a.read').ok, true);
      const wider = scopeGrammar.resolveRequestedScope(client, 'data/a.write');
      assert.equal(wider.ok, false);
      assert.match(wider.description, /maximum scope set/);
      assert.equal(scopeGrammar.resolveRequestedScope(client, 'nope').ok, false);
    });
    it('[OXS03] openid is refused on this core; offline_access without the refresh grant is dropped', () => {
      assert.match(scopeGrammar.resolveRequestedScope(client, 'openid data/a.read').description, /openid is not available/);
      const r = scopeGrammar.resolveRequestedScope({ ...client, grantTypes: ['authorization_code'] }, 'offline_access data/a.read');
      assert.deepEqual(r.coreTokens, []);
    });
    it('[OXS04] no grammar installed: refused', () => {
      extension._resetForTests();
      assert.match(scopeGrammar.resolveRequestedScope(client, 'data/a.read').description, /no scope grammar/);
    });
    it('[OXS05] a grammar that throws is reported as an invalid scope, not a crash', () => {
      extension.setExtension({ ...toyExtension(), scopeGrammar: { ...toyExtension().scopeGrammar, parse () { throw new Error('x'); } } });
      assert.equal(scopeGrammar.resolveRequestedScope(client, 'data/a.read').ok, false);
    });
    it('[OXS06] account and system streams are refused whatever the grammar answers, in any spelling', () => {
      for (const token of ['acct/language.write', 'acct/email.write', 'acct/email.read', 'acct/email.local',
        'acct/email.store', 'acct/field.store', 'acct/root.read', 'emails.read']) {
        const r = scopeGrammar.resolveRequestedScope(client, 'data/a.read ' + token);
        assert.equal(r.ok, false, token);
        assert.match(r.description, /account or system stream/, token + ': ' + r.description);
      }
    });
    it('[OXS07] a permission on every stream (*), in any spelling, is refused', () => {
      for (const token of ['all.read', 'local-root.read']) {
        const r = scopeGrammar.resolveRequestedScope(client, token);
        assert.equal(r.ok, false, token);
        assert.match(r.description, /every stream/, token + ': ' + r.description);
      }
    });
    it('[OXS08] level manage is refused', () => {
      const r = scopeGrammar.resolveRequestedScope(client, 'data/a.manage');
      assert.equal(r.ok, false);
      assert.match(r.description, /manage/);
    });
    it('[OXS09] the same rules hold on the registered maximum set; feature permissions pass', () => {
      const wide = { ...client, clientId: 'wide-app', scope: [...client.scope, 'acct/email.write'] };
      const r = scopeGrammar.resolveRequestedScope(wide, 'data/a.read');
      assert.equal(r.ok, false);
      assert.match(r.description, /registered scope.*account or system stream/);
      // Positive control: an ordinary stream plus a feature permission.
      extension.setExtension(toyWith((offer) => offer.permissions.push({ feature: 'selfRevoke', setting: 'forbidden' })));
      const ok = scopeGrammar.resolveRequestedScope(client, 'data/a.read');
      assert.equal(ok.ok, true, ok.description);
      assert.deepEqual(ok.offer.permissions, [{ streamId: 'a', level: 'read' }, { feature: 'selfRevoke', setting: 'forbidden', mandatory: true }]);
    });
    it('[OXS10] two entries on one stream (any spelling) are a contract error: invalid_scope, generic text', () => {
      const r = scopeGrammar.resolveRequestedScope({ ...client, scope: [...client.scope, 'dup.local'] }, 'dup.local');
      assert.equal(r.ok, false);
      assert.equal(r.description, 'conflicting permissions on a requested resource');
      // The maximum set is a list of ceilings: two on one stream are harmless there.
      const m = scopeGrammar.resolveRequestedScope({ ...client, clientId: 'dup-max', scope: [...client.scope, 'dup.local', 'data/a.write'] }, 'data/a.write');
      assert.equal(m.ok, true, m.description);
    });
    it('[OXS11] defaultName / name from the grammar never reach the offer', () => {
      extension.setExtension(toyWith((offer) => { offer.permissions = offer.permissions.map((p) => ({ ...p, defaultName: 'X', name: 'Y' })); }));
      const r = scopeGrammar.resolveRequestedScope(client, 'data/a.read');
      assert.equal(r.ok, true, r.description);
      assert.deepEqual(r.offer.permissions, [{ streamId: 'a', level: 'read' }]);
    });
    it('[OXS12] the echo may only answer requested tokens', () => {
      extension.setExtension({ ...toyExtension(), scopeGrammar: { ...toyExtension().scopeGrammar, echo: () => ['data/a.read', 'data/b.read'] } });
      assert.throws(() => scopeGrammar.grantedScopeTokens(client, [], ['data/a.read'], []), /did not request: data\/b\.read/);
      assert.deepEqual(scopeGrammar.grantedScopeTokens(client, ['offline_access'], ['data/a.read', 'data/b.read'], []),
        ['offline_access', 'data/a.read', 'data/b.read']);
      extension.setExtension({ ...toyExtension(), scopeGrammar: { ...toyExtension().scopeGrammar, echo: () => 'x' } });
      assert.throws(() => scopeGrammar.grantedScopeTokens(client, [], [], []), /array of strings/);
    });
    it('[OXS13] pseudonymous subjects are refused: an offer asking for one, a pairwise client', () => {
      const pseudo = scopeGrammar.resolveRequestedScope({ ...client, scope: [...client.scope, 'pseudo'] }, 'data/a.read pseudo');
      assert.deepEqual(pseudo, { ok: false, description: 'pseudonymous subjects are not available on this core' });
      const pairwise = scopeGrammar.resolveRequestedScope({ ...client, subjectType: 'pairwise' }, 'data/a.read');
      assert.deepEqual(pairwise, { ok: false, description: 'pseudonymous subjects are not available on this core' });
      // A public client without a pseudonym: the offer carries none.
      assert.equal(scopeGrammar.resolveRequestedScope(client, 'data/a.read').offer.randomAlias, false);
    });
    it('[OXS14] the maximum set covers a stream in any spelling', () => {
      extension.setExtension(toyWith((offer, ctx) => {
        if (ctx.purpose === 'request') offer.permissions = offer.permissions.map((p) => ({ ...p, streamId: ':local:' + p.streamId }));
      }));
      const r = scopeGrammar.resolveRequestedScope(client, 'data/a.read');
      assert.equal(r.ok, true, r.description);
    });
  });

  describe('[OXFZ] grammar fuzz: whatever the grammar answers, the core keeps its rules', () => {
    // Deterministic PRNG (mulberry32), so a failure is reproducible.
    function prng (seed) {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const ORDINARY = ['s1', 's2', ':local:s1', ':local:s2'];
    const REFUSED_STREAMS = ['*', ':local:', ':_system:language', ':system:email', ':account:email', ':_cmc:x', ':local::system:email', ':account::system:email'];
    const LEVELS_OK = ['read', 'contribute', 'create-only'];
    const LEVELS_BAD = ['manage', 'none', 'bogus'];
    const MAX = [{ streamId: 's1', level: 'contribute' }, { streamId: 's2', level: 'contribute' }, { feature: 'selfRevoke', setting: 'forbidden' }];
    const canon = (id) => id.replace(/^:local:/, '');

    let current;
    function fuzzExtension () {
      return {
        apiVersion: 1,
        name: 'fuzz',
        scopeGrammar: {
          parse (s, ctx) {
            if (ctx.purpose === 'max') return { ok: true, tokens: ['all'], offer: { permissions: MAX } };
            if (current.kind === 'throw') throw new Error('grammar bug');
            return { ok: true, tokens: ['t'], offer: { permissions: current.permissions, ...(current.randomAlias ? { randomAlias: true } : {}) } };
          },
          echo: () => [],
        },
      };
    }

    function generate (rnd) {
      const roll = rnd();
      if (roll < 0.04) return { kind: 'throw', mustRefuse: true };
      if (roll < 0.08) return { kind: 'shape', permissions: [null, {}, 'x', 3][Math.floor(rnd() * 4)], mustRefuse: true };
      if (roll < 0.10) {
        const permissions = Array.from({ length: 1001 }, (_v, i) => ({ streamId: 'n' + i, level: 'read' }));
        return { kind: 'big', permissions, mustRefuse: true };
      }
      const n = Math.floor(rnd() * 6);
      const permissions = [];
      let mustRefuse = n === 0;
      const seen = new Set();
      for (let i = 0; i < n; i++) {
        if (rnd() < 0.1) {
          permissions.push({ feature: 'selfRevoke', setting: 'forbidden' });
          continue;
        }
        const refusedStream = rnd() < 0.2;
        const streamId = refusedStream ? REFUSED_STREAMS[Math.floor(rnd() * REFUSED_STREAMS.length)] : ORDINARY[Math.floor(rnd() * ORDINARY.length)];
        const badLevel = rnd() < 0.15;
        const level = badLevel ? LEVELS_BAD[Math.floor(rnd() * LEVELS_BAD.length)] : LEVELS_OK[Math.floor(rnd() * LEVELS_OK.length)];
        const p = { streamId, level };
        if (rnd() < 0.3) p.defaultName = 'Name ' + i;
        if (rnd() < 0.2) p.name = 'Display ' + i;
        permissions.push(p);
        if (refusedStream || badLevel) mustRefuse = true;
        const id = refusedStream ? streamId : canon(streamId);
        if (seen.has(id)) mustRefuse = true;
        seen.add(id);
      }
      const randomAlias = rnd() < 0.1;
      if (randomAlias) mustRefuse = true;
      return { kind: 'list', permissions, randomAlias, mustRefuse };
    }

    it('[OXF01] 500 random offers: never a throw, refused exactly when a rule is broken, accepted offers are clean', () => {
      extension.setExtension(fuzzExtension());
      const client = { ...REGISTRY_CLIENT, clientId: 'fuzz-app', scope: ['all'], updatedAt: 7 };
      const rnd = prng(20261030);
      let accepted = 0;
      let refused = 0;
      for (let i = 0; i < 500; i++) {
        current = generate(rnd);
        let r;
        assert.doesNotThrow(() => { r = scopeGrammar.resolveRequestedScope(client, 't'); }, 'case ' + i);
        assert.equal(r.ok, !current.mustRefuse, 'case ' + i + ' ' + JSON.stringify(current).slice(0, 300) + ' => ' + JSON.stringify(r).slice(0, 200));
        if (!r.ok) { refused++; continue; }
        accepted++;
        const ids = new Set();
        assert.ok(r.offer.permissions.length <= scopeGrammar.MAX_SYNTH_ENTRIES);
        assert.notEqual(r.offer.randomAlias, true);
        for (const p of r.offer.permissions) {
          assert.equal(p.defaultName, undefined, 'case ' + i);
          assert.equal(p.name, undefined, 'case ' + i);
          if (p.streamId == null) continue;
          assert.ok(!['manage', 'none'].includes(p.level), 'case ' + i);
          assert.equal(scopeGrammar.refusedPermission(p), null, 'case ' + i);
          assert.ok(!ids.has(canon(p.streamId)), 'case ' + i);
          ids.add(canon(p.streamId));
        }
      }
      // Both outcomes are exercised.
      assert.ok(accepted > 50 && refused > 50, `accepted ${accepted}, refused ${refused}`);
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
      assert.equal(v.payload.nonce, undefined);
      assert.equal(v.payload.audience, AUD);
      assert.ok(signed.length < 1500, 'state length ' + signed.length);
    });
    it('[OXA02] an http redirect URI that is not loopback works only for a client registered for it', async () => {
      const platform = fakePlatform();
      await seed(platform, { redirectUris: [INSECURE_REDIRECT], allowInsecureRedirect: true });
      const { signed } = await authorize({ config: fakeConfig(), platform }, authorizeQuery({ redirect_uri: INSECURE_REDIRECT }));
      assert.ok(signed);
    });
    it('[OXA03] aud: missing or foreign refused, trailing slash tolerated', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      for (const aud of [undefined, 'https://other.example.com/base']) {
        const { res } = await authorize(deps, authorizeQuery({ aud }));
        assert.ok(res.headers.location.startsWith(REDIRECT + '?error=invalid_request'), res.headers.location);
      }
      const { signed } = await authorize(deps, authorizeQuery({ aud: AUD + '/' }));
      assert.equal(verifyState(ADMIN_KEY, signed).payload.audience, AUD);
      // A client registered for any audience needs none.
      const any = fakePlatform(); await seed(any, { allowedAudiences: [], anyAudience: true });
      assert.ok((await authorize({ config: fakeConfig(), platform: any }, authorizeQuery({ aud: undefined }))).signed);
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
    it('[OXA07] a pseudonym request, or a pairwise client, is refused with invalid_scope', async () => {
      const platform = fakePlatform(); await seed(platform, { scope: [...REGISTRY_CLIENT.scope, 'pseudo'] });
      const { res, signed } = await authorize({ config: fakeConfig(), platform }, authorizeQuery({ scope: 'data/a.read pseudo' }));
      assert.equal(signed, null);
      assert.deepEqual(redirectError(res), { error: 'invalid_scope', description: 'pseudonymous subjects are not available on this core' });
      const pw = fakePlatform(); await seed(pw, { subjectType: 'pairwise' });
      const r2 = await authorize({ config: fakeConfig(), platform: pw }, authorizeQuery({ scope: 'data/a.read' }));
      assert.deepEqual(redirectError(r2.res), { error: 'invalid_scope', description: 'pseudonymous subjects are not available on this core' });
    });
    it('[OXA08] a grammar duplicate reaches the app as a generic description', async () => {
      const platform = fakePlatform(); await seed(platform, { scope: [...REGISTRY_CLIENT.scope, 'dup.local'] });
      const { res } = await authorize({ config: fakeConfig(), platform }, authorizeQuery({ scope: 'dup.local' }));
      assert.deepEqual(redirectError(res), { error: 'invalid_scope', description: 'conflicting permissions on a requested resource' });
    });
  });

  describe('[OXOFR] offer endpoint and /accept', () => {
    it('[OXO01] the offer endpoint returns the client display and the re-derived offer', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      const { signed } = await authorize(deps, authorizeQuery());
      const res = await postOffer(deps, signed);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.body.client.clientName, 'Registry app');
      assert.equal(res.body.offer.allowUserChoice, false);
      assert.deepEqual(res.body.offer.permissions, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]);
    });
    it('[OXO02] a client updated between /authorize and /accept invalidates the state', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      const { signed } = await authorize(deps, authorizeQuery());
      assert.equal((await postOffer(deps, signed)).statusCode, 200);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await persistClient(platform, { ...REGISTRY_CLIENT, clientName: 'renamed' });
      const res = await accept(acceptDeps(deps), signed, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error_description, /changed/);
    });
    it('[OXO03] /accept mints from the synthesised offer, without CMC material', async () => {
      const platform = fakePlatform(); await seed(platform);
      const { calls } = await flow({ platform, config: fakeConfig() });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].offer, { kind: 'synthesised', permissions: [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }], randomAlias: false });
    });
    it('[OXO04] a grant wider than the offer is refused (all or nothing by default)', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      const { signed } = await authorize(deps, authorizeQuery({ scope: 'data/a.read' }));
      const res = await accept(acceptDeps(deps), signed, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]);
      assert.equal(res.statusCode, 400);
    });
    it('[OXO05] a grammar change between /authorize and /accept invalidates the state (digest drift)', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      const { signed } = await authorize(deps, authorizeQuery({ scope: 'data/a.read' }));
      assert.equal((await postOffer(deps, signed)).statusCode, 200);
      // Same name and version, another mapping of the same scope string.
      extension.setExtension(toyWith((offer) => { offer.permissions = [{ streamId: 'b', level: 'read' }]; }));
      for (const res of [await postOffer(deps, signed), await accept(acceptDeps(deps), signed, [{ streamId: 'b', level: 'read' }])]) {
        assert.equal(res.statusCode, 400, res.raw);
        assert.match(res.body.error_description, /changed since it was issued/);
      }
    });
    it('[OXO06] entryLabels from the grammar reach the consent UI unchanged', async () => {
      const labels = { 's|a|read': { en: 'Stream A', fr: 'Flux A' }, 'f|selfRevoke|forbidden': { en: 'Cannot revoke itself' } };
      extension.setExtension(toyWith((offer) => { offer.entryLabels = labels; offer.title = { en: 'Title' }; }));
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      const { signed } = await authorize(deps, authorizeQuery({ scope: 'data/a.read' }));
      const res = await postOffer(deps, signed);
      assert.equal(res.statusCode, 200, res.raw);
      assert.deepEqual(res.body.offer.entryLabels, labels);
      assert.deepEqual(res.body.offer.title, { en: 'Title' });
    });
    it('[OXO07] one state is re-derived once: /offer replays and /accept reuse it', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      const { signed } = await authorize(deps, authorizeQuery({ scope: 'data/a.read' }));
      const afterAuthorize = parseCalls;
      for (let i = 0; i < 3; i++) assert.equal((await postOffer(deps, signed)).statusCode, 200);
      assert.equal(parseCalls, afterAuthorize + 1);
      const acc = await accept(acceptDeps(deps), signed, [{ streamId: 'a', level: 'read' }]);
      assert.equal(acc.statusCode, 200, acc.raw);
      assert.equal(parseCalls, afterAuthorize + 1);
      // Bounded: entries beyond the bound are dropped, oldest first.
      assert.equal(offerRoute.OFFER_CACHE_SIZE, 1000);
    });
    it('[OXO08] a client suspended after /authorize is refused at /offer and at /accept', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      const { signed } = await authorize(deps, authorizeQuery({ scope: 'data/a.read' }));
      assert.equal((await postOffer(deps, signed)).statusCode, 200);
      await persistClient(platform, { ...REGISTRY_CLIENT, status: 'suspended' });
      const calls = [];
      for (const res of [await postOffer(deps, signed), await accept(acceptDeps(deps, calls), signed, [{ streamId: 'a', level: 'read' }])]) {
        assert.equal(res.statusCode, 403, res.raw);
        assert.equal(res.body.error, 'access_denied');
      }
      assert.equal(calls.length, 0);
    });
    it('[OXO09] /accept writes the session index row: no token, no username', async () => {
      const platform = fakePlatform(); await seed(platform);
      await flow({ platform, config: fakeConfig() });
      const row = platform._state.get('oauth-at/' + hashSecret('session-token-1'));
      assert.ok(row != null);
      assert.deepEqual(Object.keys(row.value).sort(), ['accessId', 'audience', 'clientId', 'coreId', 'coreTokens', 'dataGrantAccessId', 'expiresAt', 'grammarTokens', 'userId']);
      const json = JSON.stringify(row.value);
      assert.ok(!json.includes('session-token-1'));
      assert.ok(!json.includes('"alice"'));
    });
  });

  describe('[OXTOK] token response', () => {
    it('[OXT01] scope echo, extras, hook fields; the subject is the user id and apiEndpoint is sent', async () => {
      const platform = fakePlatform(); await seed(platform);
      const { token } = await flow({ platform, config: fakeConfig() });
      assert.equal(token.statusCode, 200, token.raw);
      const b = token.body;
      assert.deepEqual(b.scope.split(' ').sort(), ['ctx/patient', 'data/*.read', 'offline_access', 'who']);
      assert.equal(b.banner, true);
      assert.equal(b.patient, USER_ID);
      assert.equal(b.apiEndpoint, 'https://alice.example.com/');
      assert.equal(typeof b.refresh_token, 'string');
      assert.equal(b.id_token, undefined);
    });
    it('[OXT02] hooks receive the GRANTED tokens: a token whose permissions were unticked is absent', async () => {
      const platform = fakePlatform(); await seed(platform);
      // The offer allows no user choice by default: let this grammar allow it.
      extension.setExtension(toyWith((offer) => { offer.allowUserChoice = true; }));
      const { token } = await flow({
        platform,
        config: fakeConfig(),
        query: { scope: 'data/a.read data/b.read ctx/patient' },
        keep: (p) => p.streamId === 'a',
      });
      assert.equal(token.statusCode, 200, token.raw);
      const expected = ['ctx/patient', 'data/a.read'];
      assert.deepEqual(token.body.scope.split(' ').sort(), expected);
      assert.deepEqual([...lastCtx.tokenResponse.scopeTokens].sort(), expected);
      assert.deepEqual(lastCtx.tokenResponse.permissions, [{ streamId: 'a', level: 'read' }]);
      assert.equal(lastCtx.tokenResponse.client.clientSecretHash, undefined);
      assert.equal(lastCtx.tokenResponse.subject, USER_ID);
    });
    it('[OXT03] no refresh token without offline_access', async () => {
      const platform = fakePlatform(); await seed(platform);
      const { token } = await flow({ platform, config: fakeConfig(), query: { scope: 'data/a.read' } });
      assert.equal(token.statusCode, 200, token.raw);
      assert.equal(token.body.refresh_token, undefined);
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
    it('[OXT05] the consent withdrawn before the exchange: 400 invalid_grant, the session is removed', async () => {
      const platform = fakePlatform(); await seed(platform);
      const revoked = [];
      const { token } = await flow({
        platform,
        config: fakeConfig(),
        more: { resolveGrantSubject: async () => null, revokeAccessLocal: async (p) => { revoked.push(p.accessId); } },
      });
      assert.equal(token.statusCode, 400, token.raw);
      assert.equal(token.body.error, 'invalid_grant');
      assert.deepEqual(revoked, ['session-1']);
      assert.equal([...platform._state.keys()].some((k) => k.startsWith('oauth-rt/')), false);
    });
    it('[OXT06] refresh: the echo follows the effective (narrowed) permissions', async () => {
      const platform = fakePlatform(); await seed(platform);
      await seedRefresh(platform, 'RT-X');
      const res = await refresh(platform, 'RT-X', refreshedMint());
      assert.equal(res.statusCode, 200, res.raw);
      assert.deepEqual(res.body.scope.split(' ').sort(), ['ctx/patient', 'data/b.read', 'offline_access']);
      assert.equal(res.body.patient, USER_ID);
      assert.equal(res.body.id_token, undefined);
      assert.equal(res.body.apiEndpoint, 'https://tok-9@alice.example.com/');
      // The refreshed session is indexed too.
      assert.ok(platform._state.has('oauth-at/' + hashSecret('tok-9')));
    });
    it('[OXT07] a suspended client cannot exchange its code, nor refresh', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: fakeConfig(), platform };
      const { signed } = await authorize(deps, authorizeQuery());
      const acc = await accept(acceptDeps(deps), signed, [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]);
      await persistClient(platform, { ...REGISTRY_CLIENT, status: 'suspended' });
      const tok = await exchange(tokenDeps(platform, fakeConfig()), new URL(acc.body.redirectTo).searchParams.get('code'));
      assert.equal(tok.statusCode, 400);
      assert.equal(tok.body.error, 'unauthorized_client');
      await seedRefresh(platform, 'RT-S');
      let minted = false;
      const rt = await refresh(platform, 'RT-S', async () => { minted = true; return refreshedMint()(); });
      assert.equal(rt.statusCode, 400, rt.raw);
      assert.equal(rt.body.error, 'unauthorized_client');
      assert.equal(minted, false);
    });
    it('[OXT08] a hook that times out answers 500 before any refresh row; the session is removed', async () => {
      const platform = fakePlatform(); await seed(platform);
      extension.setExtension(toyExtension(), { hookTimeoutMs: 30 });
      hookOverride = () => new Promise(() => {});
      const revoked = [];
      const { token } = await flow({ platform, config: fakeConfig(), more: { revokeAccessLocal: async (p) => { revoked.push(p.accessId); } } });
      assert.equal(token.statusCode, 500, token.raw);
      assert.equal([...platform._state.keys()].some((k) => k.startsWith('oauth-rt/')), false);
      assert.deepEqual(revoked, ['session-1']);
      // Refresh: same, and the minted session is removed.
      await seedRefresh(platform, 'RT-T');
      const rRevoked = [];
      const rt = await refresh(platform, 'RT-T', refreshedMint(), { revokeAccessLocal: async (p) => { rRevoked.push(p.accessId); } });
      assert.equal(rt.statusCode, 500, rt.raw);
      assert.deepEqual(rRevoked, ['session-9']);
    });
    it('[OXT09] a registry client presenting a DPoP proof is refused before its code is consumed', async () => {
      const platform = fakePlatform(); await seed(platform);
      const config = fakeConfig();
      const deps = { config, platform };
      const a = await authorize(deps, authorizeQuery({ scope: 'data/a.read' }));
      const offerRes = await postOffer(deps, a.signed);
      const acc = await accept(acceptDeps(deps), a.signed, offerRes.body.offer.permissions);
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
    it('[OXT10] an echo outside the requested tokens is an extension error (500, no refresh row)', async () => {
      const platform = fakePlatform(); await seed(platform);
      extension.setExtension({ ...toyExtension(), scopeGrammar: { ...toyExtension().scopeGrammar, echo: () => ['data/*.read', 'never-asked'] } });
      const { token } = await flow({ platform, config: fakeConfig() });
      assert.equal(token.statusCode, 500, token.raw);
      assert.equal([...platform._state.keys()].some((k) => k.startsWith('oauth-rt/')), false);
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
    it('[OXW02] an empty audience list needs an explicit any-audience registration; both together are refused', async () => {
      const platform = fakePlatform();
      await assert.rejects(persistClient(platform, { ...REGISTRY_CLIENT, allowedAudiences: [] }), /at least one audience/);
      await assert.rejects(persistClient(platform, { ...REGISTRY_CLIENT, allowedAudiences: undefined }), /at least one audience/);
      await assert.rejects(persistClient(platform, { ...REGISTRY_CLIENT, anyAudience: true }), /exclude each other/);
      await persistClient(platform, { ...REGISTRY_CLIENT, allowedAudiences: [], anyAudience: true });
    });
    it('[OXW03] plain-http redirect URIs only on loopback, unless registered for them', async () => {
      const platform = fakePlatform();
      await assert.rejects(persistClient(platform, { ...REGISTRY_CLIENT, redirectUris: [REDIRECT, INSECURE_REDIRECT] }), /loopback hosts only.*192\.168\.1\.10/);
      for (const uri of ['http://127.0.0.1/cb', 'http://[::1]:8080/cb', 'http://localhost:3000/cb', 'com.example.app:/cb']) {
        await persistClient(platform, { ...REGISTRY_CLIENT, redirectUris: [uri] });
      }
      await persistClient(platform, { ...REGISTRY_CLIENT, redirectUris: [INSECURE_REDIRECT], allowInsecureRedirect: true });
    });
    it('[OXW04] a stored apiEndpoint opt-out field is ignored', async () => {
      const platform = fakePlatform();
      await setClient(platform, { ...REGISTRY_CLIENT, omitApiEndpoint: true, updatedAt: Date.now() });
      const { token } = await flow({ platform, config: fakeConfig(), query: { scope: 'data/a.read' } });
      assert.equal(token.statusCode, 200, token.raw);
      assert.equal(token.body.apiEndpoint, 'https://alice.example.com/');
    });
  });

  describe('[OXBOOT] boot pass over registry rows', () => {
    it('[OXB01] each bad registry row is reported, nothing throws; good rows and app-account rows are silent', async () => {
      const platform = fakePlatform();
      await seed(platform);
      // Written storage-direct: rows the registration rules would refuse today.
      await setClient(platform, { ...REGISTRY_CLIENT, clientId: 'bad-scope', scope: ['acct/email.write'], updatedAt: 1 });
      await setClient(platform, { ...REGISTRY_CLIENT, clientId: 'http-redirect', redirectUris: [INSECURE_REDIRECT], allowInsecureRedirect: true, updatedAt: 1 });
      const { subjectType: _s, ...noSubject } = REGISTRY_CLIENT;
      await setClient(platform, { ...noSubject, clientId: 'no-subject', updatedAt: 1 });
      await setClient(platform, { clientId: 'cmc-app', redirectUris: [REDIRECT], scope: ['cmc:a'], grantTypes: ['authorization_code'], updatedAt: 1 });
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (...a) => warnings.push(a.join(' '));
      let count;
      try {
        count = await checkRegistryClients(platform);
      } finally {
        console.warn = origWarn;
      }
      assert.equal(count, 3);
      // The bad row is refused at /authorize, the others work.
      const { res } = await authorize({ config: fakeConfig(), platform }, authorizeQuery({ client_id: 'bad-scope', scope: 'data/a.read' }));
      assert.equal(redirectError(res).error, 'invalid_scope');
      assert.match(redirectError(res).description, /registered scope/);
      // A partial store (no listing) is skipped, not fatal.
      assert.equal(await checkRegistryClients({}), 0);
      // No grammar installed: every registry row is reported (plus the
      // redirect and subject-type warnings above).
      extension._resetForTests();
      assert.equal(await checkRegistryClients(platform), 6);
    });
  });
});
