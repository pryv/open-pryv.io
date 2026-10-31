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
const signingKeys = require('../src/signingKeys.ts');
const { registerRoutes } = require('../src/routes.ts');
const { handleRefuse } = require('../src/routes/refuse.ts');
const { signState } = require('../src/signedState.ts');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

function acceptDeps (deps, calls = [], session = {}) {
  return { ...deps, resolveUser: async () => ({ userId: USER_ID, username: 'alice', ...session }), createAccess: fakeCreateAccess(calls) };
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
async function flow ({ platform, config, query = {}, keep = null, more = {}, session = {} }) {
  const deps = { config, platform };
  const a = await authorize(deps, authorizeQuery(query));
  assert.ok(a.signed, 'authorize did not redirect to consent: ' + a.location + ' ' + a.res.raw);
  const offerRes = await postOffer(deps, a.signed);
  assert.equal(offerRes.statusCode, 200, offerRes.raw);
  const calls = [];
  const granted = keep == null ? offerRes.body.offer.permissions : offerRes.body.offer.permissions.filter(keep);
  const acc = await accept(acceptDeps(deps, calls, session), a.signed, granted);
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
    it('[OXS03] openid is refused without a signing key, a core token with one; offline_access without the refresh grant is dropped', () => {
      assert.match(scopeGrammar.resolveRequestedScope(client, 'openid data/a.read').description, /openid is not available on this core \(no signing key configured\)/);
      const oidc = scopeGrammar.resolveRequestedScope(client, 'openid offline_access data/a.read', { oidcEnabled: true });
      assert.equal(oidc.ok, true, oidc.description);
      assert.deepEqual(oidc.coreTokens, ['openid', 'offline_access']);
      assert.deepEqual(oidc.grammarTokens, ['data/a.read']);
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
    it('[OXS12] the echo is bounded by what the session holds, not by the requested tokens; a request reports only sent tokens', () => {
      extension.setExtension({ ...toyExtension(), scopeGrammar: { ...toyExtension().scopeGrammar, echo: () => ['data/a.read', 'data/b.read'] } });
      const held = [{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }];
      // An unrequested token the session covers is fine; one it does not is refused.
      assert.deepEqual(scopeGrammar.grantedScopeTokens(client, ['offline_access'], ['data/a.read'], held),
        ['offline_access', 'data/a.read', 'data/b.read']);
      assert.throws(() => scopeGrammar.grantedScopeTokens(client, [], ['data/a.read', 'data/b.read'], [held[0]]),
        /claims reach the session does not have: stream b read \(held: none\)/);
      extension.setExtension({ ...toyExtension(), scopeGrammar: { ...toyExtension().scopeGrammar, echo: () => 'x' } });
      assert.throws(() => scopeGrammar.grantedScopeTokens(client, [], [], []), /array of strings/);
      // A grammar reporting a token the client did not send (which its echo
      // could then answer) is a contract error at parse time.
      extension.setExtension(toyWith(() => {}));
      const adding = toyExtension();
      extension.setExtension({
        ...adding,
        scopeGrammar: {
          ...adding.scopeGrammar,
          parse (s, ctx) {
            const out = adding.scopeGrammar.parse(s, ctx);
            return ctx.purpose === 'request' && out.ok ? { ...out, tokens: [...out.tokens, 'data/b.read'] } : out;
          },
        },
      });
      const r = scopeGrammar.resolveRequestedScope(client, 'data/a.read');
      assert.equal(r.ok, false);
      assert.equal(r.description, 'scope could not be parsed');
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

  describe('[OXCOV] echo coverage: the echo may name reach, never claim it', () => {
    const client = { ...REGISTRY_CLIENT, updatedAt: 1 };
    const A_READ = { streamId: 'a', level: 'read' };
    const B_READ = { streamId: 'b', level: 'read' };
    /** The toy grammar with a fixed echo. */
    function withEcho (echo) {
      const toy = toyExtension();
      return { ...toy, scopeGrammar: { ...toy.scopeGrammar, echo } };
    }
    /** The toy grammar plus `feat/<feature>.<setting>` tokens, with a fixed echo. */
    function withFeatureTokens (echo) {
      const toy = toyExtension();
      return {
        ...toy,
        scopeGrammar: {
          ...toy.scopeGrammar,
          echo,
          parse (s, ctx) {
            const tokens = s.split(/\s+/).filter((t) => t !== '');
            const feats = tokens.filter((t) => t.startsWith('feat/'));
            const out = toy.scopeGrammar.parse(tokens.filter((t) => !t.startsWith('feat/')).join(' '), ctx);
            if (!out.ok) return out;
            for (const t of feats) {
              const [feature, setting] = t.slice('feat/'.length).split('.');
              out.offer.permissions.push({ feature, setting });
            }
            return { ...out, tokens: [...out.tokens, ...feats] };
          },
        },
      };
    }
    const granted = (requested, held, core = []) => scopeGrammar.grantedScopeTokens(client, core, requested, held);

    it('[OXC1] an unrequested token the session covers is accepted and answered (a narrowed token after an untick)', () => {
      extension.setExtension(withEcho(() => ['data/a.read', 'ctx/patient']));
      assert.deepEqual(granted(['data/*.read', 'ctx/patient'], [A_READ], ['offline_access']), ['offline_access', 'data/a.read', 'ctx/patient']);
    });
    it('[OXC2] a level above the held one is refused, naming the stream, the claimed and the held level', () => {
      extension.setExtension(withEcho(() => ['data/a.write']));
      assert.throws(() => granted(['data/a.write'], [A_READ]), /claims reach the session does not have: stream a contribute \(held: read\)/);
      // create-only does not cover read.
      extension.setExtension(withEcho(() => ['data/a.read']));
      assert.throws(() => granted(['data/a.read'], [{ streamId: 'a', level: 'create-only' }]), /stream a read \(held: create-only\)/);
    });
    it('[OXC3] a stream the session lacks, or holds at none, is refused; another spelling of a held stream passes', () => {
      extension.setExtension(withEcho(() => ['data/a.read', 'data/b.read']));
      assert.throws(() => granted([], [A_READ]), /stream b read \(held: none\)/);
      assert.throws(() => granted([], [A_READ, { streamId: 'b', level: 'none' }]), /stream b read \(held: none\)/);
      assert.deepEqual(granted([], [{ streamId: ':local:a', level: 'read' }, B_READ]), ['data/a.read', 'data/b.read']);
    });
    it('[OXC4] a marker (a token whose parse yields no entry) passes, requested or not', () => {
      extension.setExtension(withEcho(() => ['data/a.read', 'ctx/patient', 'who', 'pseudo']));
      assert.deepEqual(granted(['data/a.read', 'ctx/patient'], [A_READ]), ['data/a.read', 'ctx/patient', 'who', 'pseudo']);
      extension.setExtension(withEcho(() => ['who']));
      assert.deepEqual(granted([], [A_READ]), ['who']);
    });
    it('[OXC5] a core token, a token the parse refuses, every stream, an account stream, two entries on one stream: refused', () => {
      const cases = [
        [['offline_access', 'data/a.read'], /token the core owns: offline_access/],
        [['openid'], /token the core owns: openid/],
        // Tokens, not array elements: a core token inside one element is still found.
        [['data/a.read offline_access'], /token the core owns: offline_access/],
        [['x openid'], /token the core owns: openid/],
        [['data/a.read', 'nope'], /parse refuses: unknown token nope/],
        [['all.read'], /parse refuses: .*every stream/],
        [['acct/email.read'], /parse refuses: .*account or system stream/],
        [['dup.local'], /parse refuses: conflicting permissions/],
      ];
      for (const [echo, re] of cases) {
        extension.setExtension(withEcho(() => echo));
        assert.throws(() => granted([], [A_READ, { streamId: '*', level: 'read' }, { streamId: ':system:email', level: 'read' }]), re, echo.join(' '));
      }
    });
    it('[OXC6] a requested token echoed after the grant narrowed below it is refused; the honest narrower token passes', () => {
      extension.setExtension(withEcho(() => ['data/a.write']));
      assert.throws(() => granted(['data/a.write'], [A_READ]), /stream a contribute \(held: read\)/);
      extension.setExtension(withEcho(() => ['data/a.read']));
      assert.deepEqual(granted(['data/a.write'], [A_READ]), ['data/a.read']);
    });
    it('[OXC7] an echo leaving held reach unnamed is accepted and logged', () => {
      extension.setExtension(withEcho(() => ['data/a.read']));
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (...a) => warnings.push(a.join(' '));
      let out;
      try {
        out = granted(['data/*.read'], [A_READ, B_READ]);
        // A complete echo logs nothing.
        extension.setExtension(withEcho(() => ['data/*.read']));
        granted(['data/*.read'], [A_READ, B_READ, { streamId: 'c', level: 'none' }]);
      } finally {
        console.warn = origWarn;
      }
      assert.deepEqual(out, ['data/a.read']);
      assert.equal(warnings.length, 1, warnings.join('\n'));
      assert.match(warnings[0], /client reg-app leaves held reach unnamed: stream b read/);
    });
    it('[OXC8] more than 1000 echoed tokens are refused before any parse', () => {
      extension.setExtension(withEcho(() => Array.from({ length: 1001 }, (_v, i) => 'who' + i)));
      assert.throws(() => granted([], [A_READ]), /more than 1000 tokens/);
      assert.equal(parseCalls, 0);
      // One element carrying 1001 tokens counts as 1001 tokens.
      extension.setExtension(withEcho(() => [Array.from({ length: 1001 }, (_v, i) => 'who' + i).join(' ')]));
      assert.throws(() => granted([], [A_READ]), /more than 1000 tokens/);
      assert.equal(parseCalls, 0);
      // Duplicates count once; empty elements yield no token.
      extension.setExtension(withEcho(() => Array.from({ length: 1001 }, () => 'data/a.read')));
      assert.deepEqual(granted([], [A_READ]), ['data/a.read']);
      extension.setExtension(withEcho(() => ['data/a.read', '', '  ']));
      assert.deepEqual(granted(['data/a.read'], [A_READ], ['offline_access']), ['offline_access', 'data/a.read']);
      extension.setExtension(withEcho(() => ['']));
      assert.deepEqual(granted([], [A_READ]), []);
    });
    it('[OXC9] the echo parse is memoised per extension, client row and echoed string', () => {
      extension.setExtension(withEcho(() => ['data/a.read']));
      granted([], [A_READ]);
      granted([], [A_READ, B_READ]);
      assert.equal(parseCalls, 1);
      scopeGrammar.grantedScopeTokens({ ...client, updatedAt: 2 }, [], [], [A_READ]);
      assert.equal(parseCalls, 2);
      extension.setExtension(withEcho(() => ['data/a.read']));
      granted([], [A_READ]);
      assert.equal(parseCalls, 3);
      extension.setExtension(withEcho(() => ['data/a.read', 'who']));
      granted([], [A_READ]);
      assert.equal(parseCalls, 4);
      // Coverage is recomputed on every call: the memo holds the parse, not the verdict.
      assert.throws(() => granted([], [B_READ]), /stream a read \(held: none\)/);
      assert.equal(parseCalls, 4);
    });
    it('[OXC10] feature entries: an allowed feature the session lacks is refused, a forbidden one always passes', () => {
      const held = [A_READ, { feature: 'selfRevoke', setting: 'allowed' }];
      extension.setExtension(withFeatureTokens(() => ['data/a.read', 'feat/webhooks.allowed']));
      assert.throws(() => granted([], held), /feature webhooks allowed \(held: none\)/);
      // The default restriction of a registry session: a held forbid never covers an allowed claim.
      assert.throws(() => granted([], [A_READ, { feature: 'webhooks', setting: 'forbidden' }]), /feature webhooks allowed \(held: forbidden\)/);
      extension.setExtension(withFeatureTokens(() => ['data/a.read', 'feat/webhooks.forbidden']));
      assert.deepEqual(granted([], held), ['data/a.read', 'feat/webhooks.forbidden']);
      extension.setExtension(withFeatureTokens(() => ['data/a.read', 'feat/selfRevoke.allowed']));
      assert.deepEqual(granted([], held), ['data/a.read', 'feat/selfRevoke.allowed']);
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
      // With openid granted: the same refusal, never an id_token naming the user instead.
      const oidc = await flow({
        platform,
        config: fakeConfig({ 'oauth:signingKeys': [{ kid: 'k', privateKeyPem: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }] }),
        query: { scope: 'openid data/a.read', nonce: 'n-withdrawn' },
        more: { resolveGrantSubject: async () => null },
      });
      assert.equal(oidc.token.statusCode, 400, oidc.token.raw);
      assert.equal(oidc.token.body.error, 'invalid_grant');
      assert.equal(oidc.token.body.id_token, undefined);
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
      // Suspension is reversible: the refused refresh consumed nothing, so
      // after a resume the same refresh token rotates (no reuse, no revoke).
      await persistClient(platform, { ...REGISTRY_CLIENT, status: 'active' });
      const revokes = [];
      const again = await refresh(platform, 'RT-S', refreshedMint(), { revokeChain: async (p) => { revokes.push(p); } });
      assert.equal(again.statusCode, 200, again.raw);
      assert.deepEqual(revokes, []);
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
      // The rotation did not happen: the row is back, no reuse marker. The
      // app's retry once the hook answers again (past the reuse grace window)
      // rotates; the chain and the grant survive.
      hookOverride = null;
      const chainRevokes = [];
      const retry = fakeRes();
      await handleToken(tokenDeps(platform, fakeConfig({ 'oauth:refreshReuseGraceSeconds': 0 }), {
        mintRefreshedAccess: refreshedMint(), revokeChain: async (p) => { chainRevokes.push(p); },
      }))({ headers: {}, body: { grant_type: 'refresh_token', refresh_token: 'RT-T', client_id: 'reg-app' } }, retry);
      assert.equal(retry.statusCode, 200, retry.raw);
      assert.deepEqual(chainRevokes, []);
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
    it('[OXT10] an echo beyond the session is an extension error: 500 at the exchange (no refresh row, session removed), 500 at refresh (the token works again once fixed)', async () => {
      const platform = fakePlatform(); await seed(platform);
      const beyond = { ...toyExtension(), scopeGrammar: { ...toyExtension().scopeGrammar, echo: () => ['data/*.read', 'data/a.write'] } };
      extension.setExtension(beyond);
      const revoked = [];
      const { token } = await flow({ platform, config: fakeConfig(), more: { revokeAccessLocal: async (p) => { revoked.push(p.accessId); } } });
      assert.equal(token.statusCode, 500, token.raw);
      assert.equal(token.body.error, 'server_error');
      assert.equal(token.body.error_description, 'failed to build the token response');
      assert.equal([...platform._state.keys()].some((k) => k.startsWith('oauth-rt/')), false);
      assert.deepEqual(revoked, ['session-1']);
      // Refresh: refused, the new session removed, the consumed row restored.
      await seedRefresh(platform, 'RT-E');
      const rRevoked = [];
      const rt = await refresh(platform, 'RT-E', refreshedMint([{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]),
        { revokeAccessLocal: async (p) => { rRevoked.push(p.accessId); } });
      assert.equal(rt.statusCode, 500, rt.raw);
      assert.equal(rt.body.error, 'server_error');
      assert.deepEqual(rRevoked, ['session-9']);
      // The grammar fixed: the same refresh token rotates, nothing is revoked.
      extension.setExtension(toyExtension());
      const chainRevokes = [];
      const retry = fakeRes();
      await handleToken(tokenDeps(platform, fakeConfig({ 'oauth:refreshReuseGraceSeconds': 0 }), {
        mintRefreshedAccess: refreshedMint([{ streamId: 'a', level: 'read' }, { streamId: 'b', level: 'read' }]),
        revokeChain: async (p) => { chainRevokes.push(p); },
      }))({ headers: {}, body: { grant_type: 'refresh_token', refresh_token: 'RT-E', client_id: 'reg-app' } }, retry);
      assert.equal(retry.statusCode, 200, retry.raw);
      assert.deepEqual(retry.body.scope.split(' ').sort(), ['ctx/patient', 'data/a.read', 'data/b.read', 'offline_access']);
      assert.deepEqual(chainRevokes, []);
    });
  });

  describe('[OXOIDC] OpenID Connect', () => {
    const pem = (bits) => crypto.generateKeyPairSync('rsa', { modulusLength: bits }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const PEM_1 = pem(2048);
    const PEM_2 = pem(2048);
    const KEY_1 = { kid: 'k1', privateKeyPem: PEM_1 };
    const KEY_2 = { kid: 'k2', alg: 'RS256', privateKeyPem: PEM_2 };
    const oidcConfig = (overrides = {}) => fakeConfig({ 'oauth:signingKeys': [KEY_1], 'oauth:idTokenTTL': 120, ...overrides });
    const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

    function decodeJwt (jwt) {
      const [h, p, s] = jwt.split('.');
      return {
        header: JSON.parse(Buffer.from(h, 'base64url').toString()),
        payload: JSON.parse(Buffer.from(p, 'base64url').toString()),
        input: h + '.' + p,
        sig: s,
      };
    }
    /** Verify a JWT against a published JWK Set, by its kid. */
    function verifiedBy (jwt, jwkSet) {
      const { header, input, sig } = decodeJwt(jwt);
      assert.equal(header.alg, 'RS256');
      const jwk = jwkSet.keys.find((k) => k.kid === header.kid);
      assert.ok(jwk, 'no published key for kid ' + header.kid);
      const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      return crypto.verify('sha256', Buffer.from(input), { key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(sig, 'base64url'));
    }
    function withIdClaims () {
      extension.setExtension({
        ...toyExtension(),
        idTokenClaims (ctx) { lastCtx.idTokenClaims = ctx; return { who: 'P/' + ctx.subject }; },
        claimsSupported: ['who'],
      });
    }

    beforeEach(() => { signingKeys._resetForTests(); });
    afterEach(() => { signingKeys._resetForTests(); });

    it('[OXK01] the JWK Set carries public members only, signing key first', () => {
      const set = signingKeys.publicJwkSet(signingKeys.loadSigningKeys(oidcConfig({ 'oauth:signingKeys': [KEY_1, KEY_2] })));
      assert.deepEqual(set.keys.map((k) => k.kid), ['k1', 'k2']);
      for (const k of set.keys) {
        assert.deepEqual(Object.keys(k).sort(), ['alg', 'e', 'kid', 'kty', 'n', 'use']);
        assert.equal(k.alg, 'RS256');
        assert.equal(k.use, 'sig');
        for (const m of PRIVATE_MEMBERS) assert.equal(k[m], undefined, m);
      }
    });

    it('[OXK02] a bad key entry fails loudly, without echoing the key', () => {
      const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
      const small = pem(1024);
      const pub = crypto.createPublicKey(PEM_1).export({ type: 'spki', format: 'pem' });
      const encrypted = crypto.createPrivateKey(PEM_1).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'x' });
      for (const [entries, re] of [
        [[{ privateKeyPem: PEM_1 }], /kid is required/],
        [[{ kid: 'has space', privateKeyPem: PEM_1 }], /kid is required/],
        [[{ kid: 'a', alg: 'ES256', privateKeyPem: PEM_1 }], /alg must be RS256/],
        [[{ kid: 'a', alg: 'none', privateKeyPem: PEM_1 }], /alg must be RS256/],
        [[{ kid: 'a', privateKeyPem: ec }], /an RSA key is required/],
        [[{ kid: 'a', privateKeyPem: small }], /1024 bits, at least 2048 required/],
        [[{ kid: 'a', privateKeyPem: 'garbage' }], /cannot be read/],
        [[{ kid: 'a', privateKeyPem: pub }], /cannot be read/],
        [[{ kid: 'a', privateKeyPem: encrypted }], /cannot be read/],
        [[{ kid: 'a' }], /exactly one of privateKeyFile or privateKeyPem/],
        [[{ kid: 'a', privateKeyPem: PEM_1, privateKeyFile: '/x.pem' }], /exactly one of/],
        [[{ kid: 'a', privateKeyFile: '/nonexistent/key.pem' }], /cannot read privateKeyFile \(ENOENT\)/],
        [[KEY_1, { ...KEY_2, kid: 'k1' }], /duplicate kid/],
        [['k1'], /must be an object/],
      ]) {
        let thrown = null;
        try { signingKeys.loadSigningKeys(oidcConfig({ 'oauth:signingKeys': entries })); } catch (e) { thrown = e; }
        assert.ok(thrown, 'no throw for ' + re);
        assert.match(thrown.message, re);
        assert.ok(!thrown.message.includes('PRIVATE KEY'), 'key material in: ' + thrown.message);
      }
      assert.throws(() => signingKeys.loadSigningKeys(oidcConfig({ 'oauth:signingKeys': { kid: 'a' } })), /must be a list/);
      assert.equal(signingKeys.hasSigningKeys(fakeConfig()), false);
      assert.equal(signingKeys.hasSigningKeys(fakeConfig({ 'oauth:signingKeys': [] })), false);
    });

    it('[OXK03] keys load from a file; rotation by ordering: the first signs, all are published, a removed key is gone', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-keys-'));
      try {
        const file = path.join(dir, 'k2.pem');
        fs.writeFileSync(file, PEM_2, { mode: 0o600 });
        const both = signingKeys.loadSigningKeys(oidcConfig({ 'oauth:signingKeys': [KEY_1, { kid: 'k2', privateKeyFile: file }] }));
        const setBoth = signingKeys.publicJwkSet(both);
        const jwt1 = signingKeys.signJwt(both[0], { sub: 's' });
        assert.equal(decodeJwt(jwt1).header.kid, 'k1');
        assert.ok(verifiedBy(jwt1, setBoth));
        // The new key moved first: it signs, the old one still verifies.
        const swapped = signingKeys.loadSigningKeys(oidcConfig({ 'oauth:signingKeys': [{ kid: 'k2', privateKeyFile: file }, KEY_1] }));
        const jwt2 = signingKeys.signJwt(swapped[0], { sub: 's' });
        assert.equal(decodeJwt(jwt2).header.kid, 'k2');
        const setSwapped = signingKeys.publicJwkSet(swapped);
        assert.ok(verifiedBy(jwt2, setSwapped) && verifiedBy(jwt1, setSwapped));
        // The old key removed: no longer published.
        const only2 = signingKeys.publicJwkSet(signingKeys.loadSigningKeys(oidcConfig({ 'oauth:signingKeys': [{ kid: 'k2', privateKeyFile: file }] })));
        assert.deepEqual(only2.keys.map((k) => k.kid), ['k2']);
        assert.throws(() => verifiedBy(jwt1, only2), /no published key for kid k1/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('[OXD01] the code exchange answers an id_token: RS256, kid, core claims over the hook claims, verifiable with the JWK Set', async () => {
      withIdClaims();
      const platform = fakePlatform(); await seed(platform);
      const config = oidcConfig();
      const before = Math.floor(Date.now() / 1000);
      const { token } = await flow({ platform, config, query: { scope: 'openid offline_access data/*.read ctx/patient who', nonce: 'n-1' }, session: { authTime: 1700000000.7 } });
      assert.equal(token.statusCode, 200, token.raw);
      const b = token.body;
      assert.deepEqual(b.scope.split(' ').sort(), ['ctx/patient', 'data/*.read', 'offline_access', 'openid', 'who']);
      const jwt = decodeJwt(b.id_token);
      assert.deepEqual(jwt.header, { alg: 'RS256', kid: 'k1', typ: 'JWT' });
      const p = jwt.payload;
      assert.equal(p.iss, ISSUER);
      assert.equal(p.sub, USER_ID);
      assert.equal(p.aud, 'reg-app');
      assert.equal(p.azp, 'reg-app');
      assert.equal(p.nonce, 'n-1');
      assert.equal(p.auth_time, 1700000000);
      assert.ok(p.iat >= before && p.iat <= before + 5);
      assert.equal(p.exp - p.iat, 120);
      assert.equal(p.who, 'P/' + USER_ID);
      assert.ok(verifiedBy(b.id_token, signingKeys.publicJwkSet(signingKeys.loadSigningKeys(config))));
      // The hook got the granted tokens and the same subject.
      assert.deepEqual([...lastCtx.idTokenClaims.scopeTokens].sort(), ['ctx/patient', 'data/*.read', 'offline_access', 'openid', 'who']);
      assert.equal(lastCtx.idTokenClaims.subject, USER_ID);
      // The other fields are unchanged.
      assert.equal(b.apiEndpoint, 'https://alice.example.com/');
      assert.equal(typeof b.refresh_token, 'string');
    });

    it('[OXD02] without auth time from the sign-in, auth_time is the consent time; without a nonce, none is set', async () => {
      const platform = fakePlatform(); await seed(platform);
      const before = Math.floor(Date.now() / 1000);
      const { token } = await flow({ platform, config: oidcConfig(), query: { scope: 'openid data/a.read' } });
      assert.equal(token.statusCode, 200, token.raw);
      const p = decodeJwt(token.body.id_token).payload;
      assert.ok(p.auth_time >= before && p.auth_time <= p.iat, JSON.stringify(p));
      assert.equal(Object.hasOwn(p, 'nonce'), false);
    });

    it('[OXD03] no id_token without openid, nor on refresh; the code row carries no nonce without openid', async () => {
      const platform = fakePlatform(); await seed(platform);
      const config = oidcConfig();
      const { token } = await flow({ platform, config, query: { scope: 'offline_access data/a.read', nonce: 'n-unused' } });
      assert.equal(token.statusCode, 200, token.raw);
      assert.equal(token.body.id_token, undefined);
      // The nonce of a request without openid is not even carried.
      const { signed } = await authorize({ config, platform }, authorizeQuery({ scope: 'data/a.read', nonce: 'n-x' }));
      assert.equal(verifyState(ADMIN_KEY, signed).payload.nonce, undefined);
      // A chain granted openid refreshes without an id_token.
      await seedRefresh(platform, 'RT-O', { coreTokens: ['openid', 'offline_access'] });
      const res = fakeRes();
      await handleToken(tokenDeps(platform, config, { mintRefreshedAccess: refreshedMint() }))({
        headers: {}, body: { grant_type: 'refresh_token', refresh_token: 'RT-O', client_id: 'reg-app' },
      }, res);
      assert.equal(res.statusCode, 200, res.raw);
      assert.ok(res.body.scope.split(' ').includes('openid'));
      assert.equal(res.body.id_token, undefined);
    });

    it('[OXD04] openid without a signing key is refused at /authorize; with keys the state carries the nonce', async () => {
      const platform = fakePlatform(); await seed(platform);
      const off = await authorize({ config: fakeConfig(), platform }, authorizeQuery({ scope: 'openid data/a.read', nonce: 'n' }));
      assert.equal(off.signed, null);
      assert.deepEqual(redirectError(off.res), { error: 'invalid_scope', description: 'openid is not available on this core (no signing key configured)' });
      const on = await authorize({ config: oidcConfig(), platform }, authorizeQuery({ scope: 'openid data/a.read', nonce: 'n-2' }));
      assert.equal(verifyState(ADMIN_KEY, on.signed).payload.nonce, 'n-2');
      // Keys removed between /authorize and the consent: /offer and /accept refuse it too.
      const offRes = await postOffer({ config: fakeConfig(), platform }, on.signed);
      const accRes = await accept(acceptDeps({ config: fakeConfig(), platform }), on.signed, [{ streamId: 'a', level: 'read' }]);
      for (const res of [offRes, accRes]) {
        assert.equal(res.statusCode, 400, res.raw);
        assert.equal(res.body.error, 'invalid_scope');
        assert.match(res.body.error_description, /openid is not available/);
      }
    });

    it('[OXD05] an id_token hook setting a core claim, or failing, answers 500 before any refresh row; the session is removed', async () => {
      const platform = fakePlatform(); await seed(platform);
      for (const hook of [() => ({ sub: 'someone-else' }), () => { throw new Error('boom'); }]) {
        extension.setExtension({ ...toyExtension(), idTokenClaims: hook });
        const revoked = [];
        const { token } = await flow({ platform, config: oidcConfig(), query: { scope: 'openid offline_access data/a.read' }, more: { revokeAccessLocal: async (p) => { revoked.push(p.accessId); } } });
        assert.equal(token.statusCode, 500, token.raw);
        assert.equal(token.body.id_token, undefined);
        assert.deepEqual(revoked, ['session-1']);
        assert.equal([...platform._state.keys()].some((k) => k.startsWith('oauth-rt/')), false);
      }
    });

    it('[OXD07] the id_token lifetime is clamped to 3600 s; an unusable value falls back to 300 s', async () => {
      const { idTokenTTL, MAX_ID_TOKEN_TTL } = require('../src/responseHooks.ts');
      assert.equal(MAX_ID_TOKEN_TTL, 3600);
      for (const [v, expected] of [[120, 120], [3600, 3600], [99999, 3600], [0, 300], ['x', 300], [undefined, 300]]) {
        assert.equal(idTokenTTL(fakeConfig({ 'oauth:idTokenTTL': v })), expected, String(v));
      }
      const platform = fakePlatform(); await seed(platform);
      const { token } = await flow({ platform, config: oidcConfig({ 'oauth:idTokenTTL': 99999 }), query: { scope: 'openid data/a.read' } });
      const p = decodeJwt(token.body.id_token).payload;
      assert.equal(p.exp - p.iat, 3600);
    });

    it('[OXN01] a nonce is accepted once per client: a replay is refused at /authorize, a racing second code at the exchange', async () => {
      const platform = fakePlatform(); await seed(platform);
      const config = oidcConfig();
      const deps = { config, platform };
      // Two authorizations with the same nonce, both consented before any exchange.
      const query = authorizeQuery({ scope: 'openid data/a.read', nonce: 'n-race' });
      const a1 = await authorize(deps, query);
      const a2 = await authorize(deps, query);
      const codes = [];
      for (const a of [a1, a2]) {
        const acc = await accept(acceptDeps(deps), a.signed, [{ streamId: 'a', level: 'read' }]);
        assert.equal(acc.statusCode, 200, acc.raw);
        codes.push(new URL(acc.body.redirectTo).searchParams.get('code'));
      }
      const first = await exchange(tokenDeps(platform, config), codes[0]);
      assert.equal(first.statusCode, 200, first.raw);
      assert.equal(decodeJwt(first.body.id_token).payload.nonce, 'n-race');
      const revoked = [];
      const second = await exchange(tokenDeps(platform, config, { revokeAccessLocal: async (p) => { revoked.push(p.accessId); } }), codes[1]);
      assert.equal(second.statusCode, 400, second.raw);
      assert.deepEqual([second.body.error, second.body.error_description], ['invalid_grant', 'nonce already used']);
      assert.deepEqual(revoked, ['session-1']);
      // A later authorization request with that nonce is refused up front.
      const replay = await authorize(deps, query);
      assert.equal(replay.signed, null);
      assert.deepEqual(redirectError(replay.res), { error: 'invalid_request', description: 'nonce already used' });
      // Per client: another client may use the same value.
      await persistClient(platform, { ...REGISTRY_CLIENT, clientId: 'reg-app-2' });
      assert.ok((await authorize(deps, { ...query, client_id: 'reg-app-2' })).signed);
      // The burn is keyed on a hash: the nonce itself is not stored.
      assert.ok(![...platform._state.keys()].some((k) => k.includes('n-race')));
    });

    it('[OXN02] a nonce is 1 to 512 characters', async () => {
      const platform = fakePlatform(); await seed(platform);
      const deps = { config: oidcConfig(), platform };
      for (const nonce of ['', 'x'.repeat(513)]) {
        const { res, signed } = await authorize(deps, authorizeQuery({ scope: 'openid data/a.read', nonce }));
        assert.equal(signed, null);
        assert.deepEqual(redirectError(res), { error: 'invalid_request', description: 'nonce must be 1 to 512 characters' });
      }
      assert.ok((await authorize(deps, authorizeQuery({ scope: 'openid data/a.read', nonce: 'x'.repeat(512) }))).signed);
    });

    it('[OXD06] discovery: OpenID documents 404 without a key; with keys the configuration, the JWK Set and openid in scopes_supported', async () => {
      withIdClaims();
      const app = { routes: {} };
      for (const m of ['get', 'post', 'options']) app[m] = (p, ...h) => { app.routes[m.toUpperCase() + ' ' + p] = h[h.length - 1]; };
      let keys = [];
      const config = { get: (k) => (k === 'oauth:signingKeys' ? keys : fakeConfig().get(k)) };
      registerRoutes(app, { config, extension: extension.getExtension() });
      const get = (p) => { const res = fakeRes(); app.routes['GET ' + p]({}, res); return res; };

      for (const p of ['/.well-known/openid-configuration', '/oauth2/jwks']) assert.equal(get(p).statusCode, 404, p);
      let as = get('/.well-known/oauth-authorization-server').body;
      assert.equal(as.jwks_uri, undefined);
      assert.ok(!as.scopes_supported.includes('openid'));

      keys = [KEY_1, KEY_2];
      as = get('/.well-known/oauth-authorization-server').body;
      assert.equal(as.jwks_uri, ISSUER + '/oauth2/jwks');
      assert.ok(as.scopes_supported.includes('openid') && as.scopes_supported.includes('offline_access'));
      const oidc = get('/.well-known/openid-configuration');
      assert.equal(oidc.statusCode, 200);
      assert.equal(oidc.headers['cache-control'], 'public, max-age=300');
      assert.equal(oidc.body.issuer, ISSUER);
      assert.equal(oidc.body.jwks_uri, ISSUER + '/oauth2/jwks');
      // `pairwise` is advertised by the same switch that lets /authorize serve it.
      assert.equal(scopeGrammar.PSEUDONYM_SUBJECTS_AVAILABLE, false);
      assert.deepEqual(oidc.body.subject_types_supported, ['public']);
      assert.deepEqual(oidc.body.id_token_signing_alg_values_supported, ['RS256']);
      assert.deepEqual(oidc.body.response_types_supported, ['code']);
      assert.ok(oidc.body.scopes_supported.includes('openid') && oidc.body.scopes_supported.includes('data/a.read'));
      assert.deepEqual(oidc.body.claims_supported, ['iss', 'sub', 'aud', 'azp', 'exp', 'iat', 'auth_time', 'nonce', 'who']);
      const jwks = get('/oauth2/jwks');
      assert.equal(jwks.statusCode, 200);
      assert.deepEqual(jwks.body.keys.map((k) => k.kid), ['k1', 'k2']);
      for (const k of jwks.body.keys) for (const m of PRIVATE_MEMBERS) assert.equal(k[m], undefined, m);
      // A malformed key fails the mount (the boot), not the first sign-in.
      assert.throws(() => registerRoutes({ get () {}, post () {} }, { config: oidcConfig({ 'oauth:signingKeys': [{ kid: 'a', privateKeyPem: 'garbage' }] }) }), /cannot be read/);
    });

    it('[OXSK1] the state is keyed on oauth:stateKey; until it is set, on the admin key; once set, an admin-keyed state is refused', async () => {
      const STATE_KEY = 's'.repeat(40);
      const platform = fakePlatform(); await seed(platform);
      // Fallback: no state key, the admin-derived key signs and verifies.
      const fallback = await authorize({ config: fakeConfig(), platform }, authorizeQuery({ scope: 'data/a.read' }));
      assert.equal(verifyState(ADMIN_KEY, fallback.signed).ok, true);
      // Set: states are signed with it, not with the admin key.
      const config = fakeConfig({ 'oauth:stateKey': STATE_KEY });
      const deps = { config, platform };
      const fresh = await authorize(deps, authorizeQuery({ scope: 'data/a.read' }));
      assert.equal(verifyState(STATE_KEY, fresh.signed).ok, true);
      assert.deepEqual(verifyState(ADMIN_KEY, fresh.signed), { ok: false, reason: 'bad_signature' });
      assert.equal((await postOffer(deps, fresh.signed)).statusCode, 200);
      // The state issued before the key was set no longer verifies anywhere.
      const offerRes = await postOffer(deps, fallback.signed);
      const acceptRes = await accept(acceptDeps(deps), fallback.signed, [{ streamId: 'a', level: 'read' }]);
      const refuseRes = fakeRes();
      await handleRefuse({ config })({ body: { state: fallback.signed } }, refuseRes);
      for (const res of [offerRes, acceptRes, refuseRes]) {
        assert.equal(res.statusCode, 400, res.raw);
        assert.equal(res.body.error_description, 'signed state bad_signature');
      }
      // A forged state signed with the admin key is refused the same way.
      const forged = signState(ADMIN_KEY, verifyState(STATE_KEY, fresh.signed).payload);
      assert.equal((await postOffer(deps, forged)).statusCode, 400);
      // The flow completes with the state key.
      const acc = await accept(acceptDeps(deps), fresh.signed, [{ streamId: 'a', level: 'read' }]);
      assert.equal(acc.statusCode, 200, acc.raw);
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
