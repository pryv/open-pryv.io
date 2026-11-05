/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [OTX] token exchange (RFC 8693) at the oauth2 component level: the token
 * route with an in-memory platform store and a toy grammar; the subject
 * session re-read and the derived session are injected. Also the registry
 * rules of `canExchange`, the introspection of a derived token and the boot
 * warning.
 */

import assert from 'node:assert/strict';
import * as extension from '../src/extension.ts';
import * as scopeGrammar from '../src/scopeGrammar.ts';
import { handleToken } from '../src/routes/token.ts';
import { handleIntrospect } from '../src/introspection.ts';
import { TOKEN_EXCHANGE, ACCESS_TOKEN_TYPE } from '../src/grants/token_exchange.ts';
import { persistClient, changedVettedFields, narrowedGrantFields, VETTED_FIELDS } from '../src/clientRegistry.ts';
import { mintSecret } from '../src/clientSecret.ts';
import { setSessionIndex, getSessionIndex, setClient, getClient } from '../src/storage.ts';
import { checkRegistryClients } from '../src/registryBootCheck.ts';
import { prepareRegistryResponse } from '../src/responseHooks.ts';
import { parseAudienceBoundSessions, audienceBoundSessions, audienceBoundSessionsProblem } from '../src/audienceBinding.ts';

/** The operator revoke epoch of a client (what `deleteClient` writes), without deleting its row. */
async function setRevokedAt (platform, clientId, at) {
  await platform.setPlatformKv('oauth-client-revoked/' + clientId, JSON.stringify({ revokedAt: at }));
}

const ISSUER = 'https://core.example.com';
const CORE_ID = 'core-a';
const AUD = 'https://rs.example.com/rs';
const OTHER_AUD = 'https://other-rs.example.com/api';
const USER_ID = 'u-alice';

function toyExtension (overrides = {}) {
  return {
    apiVersion: 1,
    name: 'toy-exchange',
    scopeGrammar: {
      parse (scopeString) {
        const tokens = scopeString.split(/\s+/).filter((t) => t !== '');
        return { ok: true, tokens, offer: { permissions: tokens.filter((t) => t.startsWith('read/')).map((t) => ({ streamId: t.slice(5), level: 'read' })) } };
      },
      echo ({ permissions, requestedTokens }) {
        return requestedTokens.filter((t) => permissions.some((p) => 'read/' + p.streamId === t));
      },
    },
    ...overrides,
  };
}

function fakeConfig (overrides = {}) {
  const m = { 'service:api': ISSUER, 'core:id': CORE_ID, 'oauth:accessTokenTTL': 3600, ...overrides };
  return { get: (k) => m[k] };
}

function fakePlatform () {
  const state = new Map();
  const kv = new Map();
  return {
    async setAccessState (k, v, exp) { state.set(k, { value: v, expiresAt: exp }); },
    async setAccessStateIfAbsent (k, v, exp) { if (state.has(k)) return false; state.set(k, { value: v, expiresAt: exp }); return true; },
    async getAccessState (k) {
      const e = state.get(k);
      if (e == null) return null;
      if (Date.now() > e.expiresAt) { state.delete(k); return null; }
      return e;
    },
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
      this.body = b ? JSON.parse(b) : null;
    },
  };
}

const basic = (id, secret) => 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');

const CONNECTOR = {
  clientId: 'conn-app',
  kind: 'registry',
  redirectUris: ['https://app.example.com/redirect'],
  scope: ['read/a', 'read/b'],
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenEndpointAuthMethod: 'none',
  allowedAudiences: [AUD],
  subjectType: 'public',
  tokenResponseExtras: { connector_extra: 'not-for-the-rs' },
};

let rsSecret;

async function seeded () {
  const platform = fakePlatform();
  await persistClient(platform, CONNECTOR);
  const rs = { ...CONNECTOR, tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash, tokenResponseExtras: { rs_extra: 'yes' } };
  await persistClient(platform, { ...rs, clientId: 'rs-one', canExchange: true });
  await persistClient(platform, { ...rs, clientId: 'no-role' });
  await persistClient(platform, { ...rs, clientId: 'other-rs', canExchange: true, allowedAudiences: [OTHER_AUD] });
  await persistClient(platform, { ...rs, clientId: 'short-rs', canExchange: true, accessTokenTTL: 600 });
  // A client registered for introspection too (the derived token's reader).
  await persistClient(platform, { ...rs, clientId: 'intro-rs', canIntrospect: true });
  await setSessionIndex(platform, 'subject-token', {
    userId: USER_ID,
    accessId: 'session-1',
    clientId: 'conn-app',
    coreId: CORE_ID,
    expiresAt: Date.now() + 3600e3,
    dataGrantAccessId: 'grant-1',
    coreTokens: ['offline_access'],
    grammarTokens: ['read/a', 'read/b'],
    audience: AUD,
    refreshTokenHash: 'h',
  });
  return platform;
}

function subjectSession (overrides = {}) {
  const now = Date.now() / 1000;
  return {
    username: 'alice',
    created: now - 10,
    expires: now + 1800,
    permissions: [{ streamId: 'a', level: 'read' }, { feature: 'webhooks', setting: 'forbidden' }],
    subject: USER_ID,
    aliased: false,
    apiBase: 'https://alice.example.com/',
    ...overrides,
  };
}

/** The derived sessions, as the glue keeps them: one per (resource server, subject session). */
function derivedStore () {
  const rows = new Map();
  const calls = [];
  let n = 0;
  return {
    rows,
    calls,
    mints: () => calls.filter((c) => !c.reused).length,
    async issue (params) {
      const key = params.clientId + '|' + params.subjectAccessId;
      const existing = rows.get(key);
      if (existing != null) {
        existing.expires = Math.max(existing.expires, Math.floor(params.expiresAt / 1000));
        calls.push({ ...params, reused: true });
        return { ...existing, reused: true };
      }
      n++;
      const row = { accessId: 'derived-' + n, accessToken: 'derived-token-' + n, expires: Math.floor(params.expiresAt / 1000) };
      rows.set(key, row);
      calls.push({ ...params, reused: false });
      return { ...row, reused: false };
    },
  };
}

/** Run `body` while recording the audit rows (the debug channel the audit helper writes first). */
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

describe('[OTX] OAuth2: token exchange (RFC 8693)', () => {
  before(async () => { rsSecret = await mintSecret(); });
  beforeEach(() => {
    extension.setExtension(toyExtension());
    scopeGrammar._resetForTests();
  });
  afterEach(() => extension._resetForTests());

  async function exchange (platform, {
    auth = basic('rs-one', rsSecret.plaintext),
    body = {},
    headers = {},
    subject = subjectSession(),
    store = derivedStore(),
    config = fakeConfig(),
    readSubjectSession,
    wired = true,
  } = {}) {
    const res = fakeRes();
    await handleToken({
      config,
      platform,
      resolveUsername: async () => 'alice',
      ...(wired
        ? {
            readSubjectSession: readSubjectSession ?? (async () => subject),
            issueDerivedSession: (p) => store.issue(p),
          }
        : {}),
      coreUrlFor: async (id) => 'https://' + id + '.example.com',
    })({
      headers: { ...(auth != null ? { authorization: auth } : {}), ...headers },
      // The exact request a resource server sends: nothing but these three.
      body: { grant_type: TOKEN_EXCHANGE, subject_token: 'subject-token', subject_token_type: ACCESS_TOKEN_TYPE, ...body },
    }, res);
    return res;
  }

  it('[OTX01] the minimal request (grant type, subject token and its type, Basic auth): a Bearer access token with api_base, no refresh token', async () => {
    const platform = await seeded();
    const store = derivedStore();
    const res = await exchange(platform, { store });
    assert.equal(res.statusCode, 200, res.raw);
    assert.equal(res.headers['cache-control'], 'no-store');
    const b = res.body;
    assert.equal(b.access_token, 'derived-token-1');
    assert.equal(b.issued_token_type, 'urn:ietf:params:oauth:token-type:access_token');
    assert.equal(b.token_type, 'Bearer');
    assert.ok(Number.isInteger(b.expires_in) && b.expires_in > 0 && b.expires_in <= 1800, String(b.expires_in));
    assert.equal(b.scope, 'read/a');
    assert.equal(b.api_base, 'https://alice.example.com/');
    assert.equal(b.refresh_token, undefined);
    assert.equal(b.id_token, undefined);
    assert.equal(b.apiEndpoint, undefined);
    // The resource server's static extras, never the connector's.
    assert.equal(b.rs_extra, 'yes');
    assert.equal(b.connector_extra, undefined);
    // The derived session: the resource server's, bound to the subject.
    assert.deepEqual(store.calls.map(({ expiresAt: _e, ...c }) => c), [{
      userId: USER_ID, username: 'alice', clientId: 'rs-one', subjectAccessId: 'session-1', subjectClientId: 'conn-app', notBefore: null, reused: false,
    }]);
    const index = await getSessionIndex(platform, 'derived-token-1');
    assert.deepEqual({ ...index, expiresAt: typeof index.expiresAt }, {
      userId: USER_ID,
      accessId: 'derived-1',
      clientId: 'rs-one',
      coreId: CORE_ID,
      expiresAt: 'number',
      dataGrantAccessId: 'grant-1',
      // No core token: no refresh token, no id_token come with it.
      coreTokens: [],
      grammarTokens: ['read/a', 'read/b'],
      exchange: { subjectClientId: 'conn-app', subjectAccessId: 'session-1' },
    });
    // The subject token is left as it was.
    assert.equal((await getSessionIndex(platform, 'subject-token')).audience, AUD);
  });

  it('[OTX02] an unknown caller, a public one, a wrong secret, no credential or a Basic / body mismatch: 401 alike, nothing audited', async () => {
    const platform = await seeded();
    const store = derivedStore();
    const rows = await auditRows(async () => {
      for (const [auth, body] of [
        [basic('nobody', 'x'), {}],
        [null, { client_id: 'conn-app' }],
        [basic('rs-one', 'wrong'), {}],
        [null, { client_id: 'rs-one' }],
        [basic('rs-one', rsSecret.plaintext), { client_id: 'other-rs' }],
        [null, {}],
      ]) {
        const res = await exchange(platform, { auth, body, store });
        assert.equal(res.statusCode, 401, JSON.stringify([auth, body, res.body]));
        assert.deepEqual(res.body, { error: 'invalid_client', error_description: 'client authentication failed' });
      }
    });
    assert.deepEqual(rows, []);
    assert.equal(store.calls.length, 0);
    // client_secret_post works as Basic does.
    const post = await exchange(platform, { auth: null, body: { client_id: 'rs-one', client_secret: rsSecret.plaintext }, store });
    assert.equal(post.statusCode, 200, post.raw);
  });

  it('[OTX03] a caller not registered for it, suspended, under review, or an app-account row: unauthorized_client, audited', async () => {
    const platform = await seeded();
    let res;
    const rows = await auditRows(async () => { res = await exchange(platform, { auth: basic('no-role', rsSecret.plaintext) }); });
    assert.equal(res.statusCode, 400, res.raw);
    assert.deepEqual(res.body, { error: 'unauthorized_client', error_description: 'client is not registered for token exchange' });
    assert.deepEqual(rows, [{ event: 'oauth.token.exchange_refused', payload: { clientId: 'no-role', reason: 'not-entitled' } }]);
    const row = await getClient(platform, 'rs-one');
    for (const [status, text] of [['suspended', 'this client is suspended'], ['review', 'this client is under review']]) {
      await setClient(platform, { ...row, status });
      res = await exchange(platform);
      assert.equal(res.statusCode, 400, res.raw);
      assert.deepEqual(res.body, { error: 'unauthorized_client', error_description: text });
    }
    // The caller's regions are not its business here (as for introspection).
    await setClient(platform, { ...row, status: 'active', regions: ['elsewhere'] });
    assert.equal((await exchange(platform)).statusCode, 200);
    // A row the registry would refuse (app-account with the flag): refused at run time too.
    await setClient(platform, { clientId: 'app-acct', redirectUris: ['https://x.example.com/r'], scope: ['pryv:read'], grantTypes: ['authorization_code'], clientSecretHash: rsSecret.hash, canExchange: true, allowedAudiences: [AUD], updatedAt: 0 });
    res = await exchange(platform, { auth: basic('app-acct', rsSecret.plaintext) });
    assert.equal(res.body.error, 'unauthorized_client', res.raw);
  });

  it('[OTX04] an unknown subject token, one issued for no resource server, a derived token, or a subject session gone: invalid_grant with one text', async () => {
    const platform = await seeded();
    const base = await getSessionIndex(platform, 'subject-token');
    const { audience: _a, ...noAudience } = base;
    await setSessionIndex(platform, 'no-aud-token', noAudience);
    await setSessionIndex(platform, 'derived-token', { ...base, exchange: { subjectClientId: 'conn-app', subjectAccessId: 'session-0' } });
    const store = derivedStore();
    const rows = await auditRows(async () => {
      for (const token of ['unknown-token', 'no-aud-token', 'derived-token']) {
        const res = await exchange(platform, { body: { subject_token: token }, store });
        assert.equal(res.statusCode, 400, token + ': ' + res.raw);
        assert.deepEqual(res.body, { error: 'invalid_grant', error_description: 'subject token is not active' }, token);
      }
      const gone = await exchange(platform, { subject: null, store });
      assert.deepEqual(gone.body, { error: 'invalid_grant', error_description: 'subject token is not active' });
      // Gone between the re-read and the mint: the same answer.
      const raced = await exchange(platform, {
        store: { issue: async () => { throw Object.assign(new Error('gone'), { code: 'subject-inactive' }); } },
      });
      assert.deepEqual(raced.body, { error: 'invalid_grant', error_description: 'subject token is not active' });
    });
    assert.equal(store.calls.length, 0);
    assert.ok(rows.every((r) => r.event === 'oauth.token.exchange_refused' && r.payload.reason === 'subject-inactive'), JSON.stringify(rows));
    assert.ok(!JSON.stringify(rows).includes('subject-token'), 'no token in the audit rows');
  });

  it('[OTX05] a subject token issued for a resource the caller is not registered for: invalid_target; the same resource spelt with another case or a trailing slash is accepted', async () => {
    const platform = await seeded();
    let res;
    const rows = await auditRows(async () => { res = await exchange(platform, { auth: basic('other-rs', rsSecret.plaintext) }); });
    assert.equal(res.statusCode, 400, res.raw);
    assert.deepEqual(res.body, { error: 'invalid_target', error_description: 'the subject token was issued for a resource this client is not registered for' });
    assert.equal(rows[0].payload.reason, 'foreign-audience');
    const base = await getSessionIndex(platform, 'subject-token');
    await setSessionIndex(platform, 'subject-token', { ...base, audience: 'HTTPS://RS.example.com/rs/' });
    res = await exchange(platform);
    assert.equal(res.statusCode, 200, res.raw);
  });

  it('[OTX06] a subject token whose session lives on another core: 421 wrong_core with that core\'s URL; nothing issued', async () => {
    const platform = await seeded();
    const base = await getSessionIndex(platform, 'subject-token');
    await setSessionIndex(platform, 'subject-token', { ...base, coreId: 'core-b' });
    const store = derivedStore();
    const res = await exchange(platform, { store });
    assert.equal(res.statusCode, 421, res.raw);
    assert.deepEqual(res.body, { error: 'wrong_core', coreUrl: 'https://core-b.example.com' });
    assert.equal(store.calls.length, 0);
    // A resource server the token was not issued for learns no core URL.
    const foreign = await exchange(platform, { auth: basic('other-rs', rsSecret.plaintext), store });
    assert.deepEqual(foreign.body, { error: 'invalid_target', error_description: 'the subject token was issued for a resource this client is not registered for' });
  });

  it('[OTX20] the resource server\'s revoke epoch reaches the derived session lookup: passed as notBefore', async () => {
    const platform = await seeded();
    const store = derivedStore();
    assert.equal((await exchange(platform, { store })).statusCode, 200);
    const epoch = Date.now();
    await setRevokedAt(platform, 'rs-one', epoch);
    assert.equal((await exchange(platform, { store })).statusCode, 200);
    assert.deepEqual(store.calls.map((c) => c.notBefore), [null, epoch]);
  });

  it('[OTX07] scope, an actor token, a missing or wrong subject token type, a wrong requested type, a repeated resource: refused before the subject is read', async () => {
    const platform = await seeded();
    let reads = 0;
    const readSubjectSession = async () => { reads++; return subjectSession(); };
    for (const [body, error, description] of [
      [{ scope: 'read/a' }, 'invalid_scope', 'scope narrowing is not available on this grant'],
      [{ actor_token: 'x', actor_token_type: ACCESS_TOKEN_TYPE }, 'invalid_request', 'actor tokens are not supported'],
      [{ subject_token_type: undefined }, 'invalid_request', 'subject_token_type must be ' + ACCESS_TOKEN_TYPE],
      [{ subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token' }, 'invalid_request', 'subject_token_type must be ' + ACCESS_TOKEN_TYPE],
      [{ subject_token: '' }, 'invalid_request', 'subject_token is required'],
      [{ requested_token_type: 'urn:ietf:params:oauth:token-type:jwt' }, 'invalid_request', 'requested_token_type must be ' + ACCESS_TOKEN_TYPE],
      [{ resource: [ISSUER, ISSUER] }, 'invalid_target', 'one resource per request'],
      [{ audience: { url: ISSUER } }, 'invalid_request', 'resource and audience must be strings'],
    ]) {
      const res = await exchange(platform, { body, readSubjectSession });
      assert.equal(res.statusCode, 400, JSON.stringify(body) + ': ' + res.raw);
      assert.deepEqual(res.body, { error, error_description: description }, JSON.stringify(body));
    }
    assert.equal(reads, 0);
    // The requested type spelt out is fine.
    assert.equal((await exchange(platform, { body: { requested_token_type: ACCESS_TOKEN_TYPE } })).statusCode, 200);
  });

  it('[OTX08] resource or audience naming this server is accepted (trailing slash too); any other resource is refused', async () => {
    const platform = await seeded();
    for (const body of [{ resource: ISSUER }, { audience: ISSUER + '/' }]) {
      const res = await exchange(platform, { body });
      assert.equal(res.statusCode, 200, JSON.stringify(body) + ': ' + res.raw);
    }
    for (const body of [{ resource: AUD }, { audience: 'https://elsewhere.example.com' }]) {
      const res = await exchange(platform, { body });
      assert.equal(res.statusCode, 400, res.raw);
      assert.deepEqual(res.body, { error: 'invalid_target', error_description: 'the requested resource is not this server' });
    }
  });

  it('[OTX09] a repeated exchange of the same subject token answers the same derived token, audited as reused; no second mint', async () => {
    const platform = await seeded();
    const store = derivedStore();
    let first, second;
    const rows = await auditRows(async () => {
      first = await exchange(platform, { store });
      second = await exchange(platform, { store });
    });
    assert.equal(first.statusCode, 200, first.raw);
    assert.equal(second.statusCode, 200, second.raw);
    assert.equal(second.body.access_token, first.body.access_token);
    assert.equal(store.mints(), 1);
    const exchanged = rows.filter((r) => r.event === 'oauth.token.exchanged');
    assert.deepEqual(exchanged.map((r) => r.payload.reused), [false, true]);
    assert.deepEqual(exchanged[0].payload, {
      clientId: 'rs-one',
      userId: USER_ID,
      accessId: 'derived-1',
      dataGrantAccessId: 'grant-1',
      subjectClientId: 'conn-app',
      subjectAccessId: 'session-1',
      reused: false,
      grantedScope: ['read/a'],
    });
    assert.ok(!JSON.stringify(rows).includes('derived-token-1') && !JSON.stringify(rows).includes('subject-token'), 'no token in the audit rows');
  });

  it('[OTX10] the derived lifetime is the subject\'s at most and the resource server\'s own lifetime at most; a subject about to expire is refused', async () => {
    const platform = await seeded();
    const now = Date.now();
    // The resource server's lifetime (600 s) below the subject's (1800 s).
    let store = derivedStore();
    let res = await exchange(platform, { auth: basic('short-rs', rsSecret.plaintext), store });
    assert.equal(res.statusCode, 200, res.raw);
    assert.ok(res.body.expires_in <= 600 && res.body.expires_in >= 598, String(res.body.expires_in));
    assert.ok(Math.abs(store.calls[0].expiresAt - (now + 600e3)) < 2000);
    // The subject's (300 s) below the resource server's (3600 s).
    store = derivedStore();
    const subject = subjectSession({ expires: now / 1000 + 300 });
    res = await exchange(platform, { subject, store });
    assert.equal(store.calls[0].expiresAt, subject.expires * 1000);
    assert.ok(res.body.expires_in <= 300 && res.body.expires_in >= 298, String(res.body.expires_in));
    // A later exchange with a shorter bound keeps the derived session's expiry.
    res = await exchange(platform, { subject: subjectSession({ expires: now / 1000 + 100 }), store });
    assert.ok(res.body.expires_in >= 298, String(res.body.expires_in));
    // One second left: nothing is issued, and no hook runs for it.
    let hookCalls = 0;
    extension.setExtension(toyExtension({ tokenResponse () { hookCalls++; return {}; } }));
    store = derivedStore();
    res = await exchange(platform, { subject: subjectSession({ expires: now / 1000 + 1 }), store });
    assert.deepEqual(res.body, { error: 'invalid_grant', error_description: 'subject token is not active' });
    assert.equal(store.calls.length, 0);
    assert.equal(hookCalls, 0);
  });

  it('[OTX11] a failing tokenResponse hook: 500, and no derived session is issued', async () => {
    const platform = await seeded();
    extension.setExtension(toyExtension({ tokenResponse () { throw new Error('boom'); } }));
    const store = derivedStore();
    const res = await exchange(platform, { store });
    assert.equal(res.statusCode, 500, res.raw);
    assert.deepEqual(res.body, { error: 'server_error', error_description: 'failed to issue the derived token' });
    assert.equal(store.calls.length, 0);
    // A failure to issue the derived session: the same answer.
    const failing = await exchange(platform, { store: { issue: async () => { throw new Error('storage down'); } } });
    extension.setExtension(toyExtension());
    assert.equal(failing.statusCode, 500);
  });

  it('[OTX12] the tokenResponse hook gets grantType token-exchange, the subject\'s client and grant, the resource server as actor, no audience; api_base is the core\'s', async () => {
    const platform = await seeded();
    const seen = [];
    extension.setExtension(toyExtension({ tokenResponse (ctx) { seen.push(ctx); return { hook_field: ctx.actor?.clientId }; } }));
    const res = await exchange(platform);
    assert.equal(res.statusCode, 200, res.raw);
    assert.equal(res.body.hook_field, 'rs-one');
    assert.equal(seen.length, 1);
    const ctx = seen[0];
    assert.equal(ctx.grantType, 'token-exchange');
    assert.equal(ctx.clientId, 'conn-app');
    assert.equal(ctx.client.clientId, 'conn-app');
    assert.deepEqual(ctx.actor, { clientId: 'rs-one' });
    assert.equal(ctx.audience, undefined);
    assert.equal(ctx.subject, USER_ID);
    assert.deepEqual(ctx.scopeTokens, ['read/a']);
    for (const key of ['api_base', 'issued_token_type', 'access_token', 'scope']) {
      extension.setExtension(toyExtension({ tokenResponse: () => ({ [key]: 'x' }) }));
      const bad = await exchange(platform);
      assert.equal(bad.statusCode, 500, key + ': ' + bad.raw);
    }
    // The same keys in the resource server's static extras are dropped.
    extension.setExtension(toyExtension());
    const row = await getClient(platform, 'rs-one');
    await setClient(platform, { ...row, tokenResponseExtras: { api_base: 'x', issued_token_type: 'y', kept: 1 } });
    const extras = await exchange(platform);
    assert.equal(extras.statusCode, 200, extras.raw);
    assert.equal(extras.body.api_base, 'https://alice.example.com/');
    assert.equal(extras.body.issued_token_type, ACCESS_TOKEN_TYPE);
    assert.equal(extras.body.kept, 1);
  });

  it('[OTX21] the exchange\'s reserved keys are reserved there only: the other grants\' hooks and static extras may still set api_base, introspection of a non-derived token act', async () => {
    const ctx = { scopeTokens: [] };
    extension.setExtension(toyExtension({ tokenResponse: () => ({ api_base: 'hook', issued_token_type: 'hook' }), introspectionClaims: () => ({ act: 'hook' }) }));
    assert.deepEqual(await extension.runHook('tokenResponse', ctx), { api_base: 'hook', issued_token_type: 'hook' });
    assert.deepEqual(await extension.runHook('introspectionClaims', ctx), { act: 'hook' });
    await assert.rejects(extension.runHook('tokenResponse', ctx, extension.EXCHANGE_RESERVED_KEYS.tokenResponse), /reserved key.*api_base/);
    await assert.rejects(extension.runHook('introspectionClaims', ctx, extension.EXCHANGE_RESERVED_KEYS.introspectionClaims), /reserved key.*act/);
    assert.ok(!extension.RESERVED_KEYS.tokenResponse.includes('api_base'));
    assert.ok(!extension.RESERVED_KEYS.introspectionClaims.includes('act'));
    for (const grantType of ['authorization_code', 'refresh_token']) {
      const parts = await prepareRegistryResponse({
        client: { ...CONNECTOR, tokenResponseExtras: { static_base: 's', api_base: 'static' }, updatedAt: 1 },
        grantType,
        issuer: ISSUER,
        config: fakeConfig(),
        coreTokens: [],
        grammarTokens: ['read/a'],
        permissions: [{ streamId: 'a', level: 'read' }],
        subject: USER_ID,
        aliased: false,
      });
      assert.equal(parts.extra.api_base, 'hook', grantType);
      assert.equal(parts.extra.static_base, 's', grantType);
    }
    // The introspection of the subject token (not derived) answers the hook's act.
    const platform = await seeded();
    const res = fakeRes();
    await handleIntrospect({
      config: fakeConfig(),
      platform,
      introspectAccess: async () => subjectSession(),
    })({ headers: { authorization: basic('intro-rs', rsSecret.plaintext) }, body: { token: 'subject-token' } }, res);
    assert.equal(res.statusCode, 200, res.raw);
    assert.equal(res.body.act, 'hook');
  });

  it('[OTX13] the registry: the role needs a registry row, a confidential method and an audience list, never "any audience"', async () => {
    const platform = fakePlatform();
    const rs = { ...CONNECTOR, clientId: 'rs-x', tokenEndpointAuthMethod: 'client_secret_basic', clientSecretHash: rsSecret.hash, canExchange: true };
    await persistClient(platform, rs);
    await persistClient(platform, { ...rs, clientId: 'rs-jwt', tokenEndpointAuthMethod: 'private_key_jwt', clientSecretHash: undefined, jwksUri: 'https://rs.example.com/jwks' });
    await assert.rejects(persistClient(platform, { ...rs, tokenEndpointAuthMethod: 'none', clientSecretHash: undefined }), /token exchange needs a confidential client/);
    await assert.rejects(persistClient(platform, { ...rs, allowedAudiences: [], anyAudience: true }), /token exchange needs an audience list/);
    await assert.rejects(persistClient(platform, { ...rs, canExchange: 'yes' }), /canExchange must be true or false/);
    await assert.rejects(persistClient(platform, {
      clientId: 'app-x', redirectUris: ['https://x.example.com/r'], scope: ['pryv:read'], grantTypes: ['authorization_code'], canExchange: true,
    }), /token exchange is available to registry clients only/);
    // Withdrawn: an absent field.
    const { canExchange: _c, ...without } = rs;
    await persistClient(platform, without);
  });

  it('[OTX14] canExchange is vetted (any change is a change of what the client may reach); withdrawing it is a narrowing', async () => {
    assert.ok(VETTED_FIELDS.includes('canExchange'));
    const before = { ...CONNECTOR, canExchange: true };
    const { canExchange: _c, ...after } = before;
    assert.deepEqual(changedVettedFields(before, after), ['canExchange']);
    assert.deepEqual(changedVettedFields(after, before), ['canExchange']);
    assert.deepEqual(changedVettedFields(before, { ...before }), []);
    assert.deepEqual(narrowedGrantFields(before, after), ['canExchange']);
    assert.deepEqual(narrowedGrantFields(after, before), []);
  });

  it('[OTX15] the subject\'s client revoked after the subject session, suspended, under review, outside its regions, gone, or not a registry client: invalid_grant naming the client', async () => {
    const platform = await seeded();
    const row = await getClient(platform, 'conn-app');
    const expectUnavailable = async (label) => {
      let res;
      const rows = await auditRows(async () => { res = await exchange(platform); });
      assert.equal(res.statusCode, 400, label + ': ' + res.raw);
      assert.deepEqual(res.body, { error: 'invalid_grant', error_description: 'the subject token\'s client is not available' }, label);
      assert.equal(rows[0].payload.reason, 'subject-client-unavailable', label);
    };
    for (const status of ['suspended', 'review']) {
      await setClient(platform, { ...row, status });
      await expectUnavailable(status);
    }
    await setClient(platform, { ...row, regions: ['elsewhere'] });
    await expectUnavailable('region');
    await setClient(platform, row);
    await setRevokedAt(platform, 'conn-app', Date.now());
    await expectUnavailable('revoked');
    // A session minted after the revoke and its clock margin (a client registered again): accepted.
    assert.equal((await exchange(platform, { subject: subjectSession({ created: Date.now() / 1000 + 4 }) })).statusCode, 400, 'within the margin');
    assert.equal((await exchange(platform, { subject: subjectSession({ created: Date.now() / 1000 + 10 }) })).statusCode, 200);
    await platform.deletePlatformKv('oauth-client/conn-app');
    await expectUnavailable('gone');
    await setClient(platform, { clientId: 'conn-app', redirectUris: ['https://x.example.com/r'], scope: ['pryv:read'], grantTypes: ['authorization_code'], updatedAt: 0 });
    const appAccount = await exchange(platform);
    assert.deepEqual(appAccount.body, { error: 'invalid_grant', error_description: 'subject token is not active' });
  });

  it('[OTX16] a DPoP proof is refused (registry client rule) before anything; the grant without its glue answers 500', async () => {
    const platform = await seeded();
    const store = derivedStore();
    const res = await exchange(platform, { headers: { dpop: 'x.y.z' }, store });
    assert.equal(res.statusCode, 400, res.raw);
    assert.deepEqual(res.body, { error: 'invalid_request', error_description: 'DPoP is not available for this client' });
    assert.equal(store.calls.length, 0);
    const unwired = await exchange(platform, { wired: false });
    assert.equal(unwired.statusCode, 500);
    assert.equal(unwired.body.error, 'server_error');
  });

  describe('[OTXI] introspection of a derived token', () => {
    async function introspect (platform, { token = 'derived-token-1', session, config = fakeConfig() } = {}) {
      const res = fakeRes();
      await handleIntrospect({
        config,
        platform,
        introspectAccess: async () => session ?? { ...subjectSession(), dpopJkt: undefined, apiBase: 'https://alice.example.com/' },
        coreUrlFor: async (id) => 'https://' + id + '.example.com',
      })({ headers: { authorization: basic('intro-rs', rsSecret.plaintext) }, body: { token } }, res);
      return res;
    }

    it('[OTX17] client_id is the subject token\'s client, act names the resource server, no aud; the hook sees the actor; act is reserved', async () => {
      const platform = await seeded();
      assert.equal((await exchange(platform)).statusCode, 200);
      const seen = [];
      extension.setExtension(toyExtension({ introspectionClaims (ctx) { seen.push(ctx); return { claim: 1 }; } }));
      let res;
      const rows = await auditRows(async () => { res = await introspect(platform); });
      assert.equal(res.statusCode, 200, res.raw);
      const b = res.body;
      assert.equal(b.active, true);
      assert.equal(b.client_id, 'conn-app');
      assert.deepEqual(b.act, { client_id: 'rs-one' });
      assert.equal(b.aud, undefined);
      assert.equal(b.cnf, undefined);
      assert.equal(b.scope, 'read/a');
      assert.equal(b.token_type, 'Bearer');
      assert.equal(b.claim, 1);
      assert.deepEqual(b.permissions, [{ streamId: 'a', level: 'read' }]);
      assert.equal(seen[0].clientId, 'conn-app');
      assert.deepEqual(seen[0].actor, { clientId: 'rs-one' });
      const introspected = rows.find((r) => r.event === 'oauth.token.introspected');
      assert.equal(introspected.payload.tokenClientId, 'conn-app');
      assert.equal(introspected.payload.actorClientId, 'rs-one');
      // `act` is the core's in this answer: a hook setting it fails the introspection.
      extension.setExtension(toyExtension({ introspectionClaims: () => ({ act: 'x' }) }));
      const reserved = await introspect(platform);
      assert.equal(reserved.statusCode, 500, reserved.raw);
      // The subject token itself answers as before.
      extension.setExtension(toyExtension());
      const subject = await introspect(platform, { token: 'subject-token' });
      assert.equal(subject.body.client_id, 'conn-app');
      assert.equal(subject.body.aud, AUD);
      assert.equal(subject.body.act, undefined);
    });

    it('[OTX18] inactive when the resource server or the subject\'s client is revoked, suspended or under review', async () => {
      const platform = await seeded();
      assert.equal((await exchange(platform)).statusCode, 200);
      for (const clientId of ['rs-one', 'conn-app']) {
        const row = await getClient(platform, clientId);
        for (const status of ['suspended', 'review']) {
          await setClient(platform, { ...row, status });
          assert.deepEqual((await introspect(platform)).body, { active: false }, clientId + ' ' + status);
        }
        await setClient(platform, row);
        assert.equal((await introspect(platform)).body.active, true, clientId);
        await setRevokedAt(platform, clientId, Date.now());
        assert.deepEqual((await introspect(platform)).body, { active: false }, clientId + ' revoked');
        await platform.deletePlatformKv('oauth-client-revoked/' + clientId);
      }
      // The resource server's regions are not checked (its status only).
      await setClient(platform, { ...(await getClient(platform, 'rs-one')), regions: ['elsewhere'] });
      assert.equal((await introspect(platform)).body.active, true);
    });
  });

  it('[OTX19] boot: a client registered for token exchange while the core does not refuse the tokens issued for a resource server is reported', async () => {
    const platform = await seeded();
    const off = await checkRegistryClients(platform, fakeConfig());
    const on = await checkRegistryClients(platform, fakeConfig({ 'oauth:audienceBoundSessions': true }));
    assert.equal(off, on + 1);
    // No configuration given (the operator CLI's check): nothing about it.
    assert.equal(await checkRegistryClients(platform), on);
    // No client registered for it: nothing either.
    const none = fakePlatform();
    await persistClient(none, CONNECTOR);
    assert.equal(await checkRegistryClients(none, fakeConfig()), await checkRegistryClients(none, fakeConfig({ 'oauth:audienceBoundSessions': true })));
    // The string an environment variable gives counts as on.
    assert.equal(await checkRegistryClients(platform, fakeConfig({ 'oauth:audienceBoundSessions': 'TRUE' })), on);
  });

  it('[OTX22] audienceBoundSessions: a boolean or the strings true / false (any case); anything else is a configuration problem, never read as on or off silently', () => {
    for (const [value, parsed] of [[true, true], [false, false], [undefined, false], [null, false], ['true', true], [' True ', true], ['false', false], ['FALSE', false]]) {
      assert.equal(parseAudienceBoundSessions(value), parsed, JSON.stringify(value));
      assert.equal(audienceBoundSessionsProblem(value), null, JSON.stringify(value));
    }
    for (const value of ['yes', '1', 1, 0, {}, []]) {
      assert.equal(parseAudienceBoundSessions(value), null, JSON.stringify(value));
      assert.match(audienceBoundSessionsProblem(value), /true or false is expected/, JSON.stringify(value));
      assert.equal(audienceBoundSessions(fakeConfig({ 'oauth:audienceBoundSessions': value })), false);
    }
    assert.equal(audienceBoundSessions(fakeConfig({ 'oauth:audienceBoundSessions': 'true' })), true);
  });
});
