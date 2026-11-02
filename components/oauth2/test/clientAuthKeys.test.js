/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OCAK] Client authentication keys and lifetimes: `private_key_jwt` with
 * ES256 / ES384 / RS384 (real key pairs, real signatures), per-client
 * algorithm pinning, `kid` rules, `jwks_uri` (fetched through the
 * counterparty-call guards, cached), secret rotation window, per-client
 * token lifetimes and offline access, end to end through /oauth2/token.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { handleToken: rawHandleToken } = require('../src/routes/token.ts');
const { setCode, setRefresh, getRefresh, getClient: storedClient } = require('../src/storage.ts');
const { persistClient } = require('../src/clientRegistry.ts');
const { authenticateClient, mintSecret } = require('../src/clientSecret.ts');
const { verifyClientAssertion, CLIENT_ASSERTION_TYPE } = require('../src/clientAssertion.ts');
const { validatePublicJwk, validatePublicJwkSet, computeThumbprint } = require('../src/jwks.ts');
const { getClientJwks, resetJwksCacheForTests, JwksFetchError, JWKS_CACHE_TTL_MS, JWKS_FAILURE_TTL_MS, MAX_JWKS_RESPONSE_BYTES } = require('../src/jwksUri.ts');
const { clientLifetimes } = require('../src/clientLifetimes.ts');
const { setPeerTransportForTests } = require('business/src/outbound/peerFetch.ts');

const ISSUER = 'https://reg.pryv.me';
const TOKEN_ENDPOINT = ISSUER + '/oauth2/token';
const AUDS = [ISSUER, TOKEN_ENDPOINT];
const CORE_ID = 'core-a';
const CLIENT_ID = 'keyapp';
const JWKS_URI = 'https://keys.example.com/jwks.json';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);

function fakeConfig (overrides = {}) {
  const m = {
    'service:api': ISSUER,
    'core:id': CORE_ID,
    'oauth:accessTokenTTL': 3600,
    'oauth:refreshTokenTTL': 30 * 24 * 3600,
    'oauth:refreshTokenAbsoluteTTL': 90 * 24 * 3600,
    ...overrides,
  };
  return { get: (k) => m[k] };
}

function fakePlatform () {
  const kv = new Map();
  const state = new Map();
  return {
    async setPlatformKv (k, v) { kv.set(k, v); },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvKeys (p) { return [...kv.keys()].filter((k) => k.startsWith(p)); },
    async listPlatformKvEntries (p) { return [...kv.entries()].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })); },
    async setAccessState (k, v, exp) { state.set(k, { value: v, expiresAt: exp }); },
    async setAccessStateIfAbsent (k, v, exp) {
      const e = state.get(k);
      if (e != null && Date.now() <= e.expiresAt) return false;
      state.set(k, { value: v, expiresAt: exp });
      return true;
    },
    async getAccessState (k) {
      const e = state.get(k);
      if (e == null) return null;
      if (Date.now() > e.expiresAt) { state.delete(k); return null; }
      return e;
    },
    async deleteAccessState (k) { state.delete(k); },
    async consumeAccessState (k) {
      const e = state.get(k); state.delete(k);
      if (e == null || Date.now() > e.expiresAt) return null;
      return e;
    },
  };
}

function fakeRes () {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
    end (b) { this.body = b ? JSON.parse(b) : null; },
  };
}

/** A signing key of the kind `alg` needs, with its public JWK. */
function makeKey (alg, kid) {
  const { privateKey, publicKey } = alg === 'RS384'
    ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    : crypto.generateKeyPairSync('ec', { namedCurve: alg === 'ES384' ? 'P-384' : 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const jwk = pub.kty === 'RSA' ? { kty: 'RSA', n: pub.n, e: pub.e } : { kty: 'EC', crv: pub.crv, x: pub.x, y: pub.y };
  return { alg, privateKey, publicJwk: kid != null ? { ...jwk, kid } : jwk, rawPublic: pub };
}

/** A compact JWS signed with `key`, header alg and kid as given (they may lie). */
function assertion (key, { alg = key.alg, kid = key.publicJwk.kid, header = {}, payload = {}, clientId = CLIENT_ID } = {}) {
  const h = b64url(JSON.stringify({ alg, typ: 'JWT', ...(kid != null ? { kid } : {}), ...header }));
  const p = b64url(JSON.stringify({
    iss: clientId, sub: clientId, aud: TOKEN_ENDPOINT, jti: 'jti-' + crypto.randomUUID(), exp: nowSec() + 120, iat: nowSec(), ...payload,
  }));
  const input = Buffer.from(`${h}.${p}`, 'utf8');
  const hash = key.alg === 'ES256' ? 'sha256' : 'sha384';
  const sig = key.alg === 'RS384'
    ? crypto.sign(hash, input, key.privateKey)
    : crypto.sign(hash, input, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${b64url(sig)}`;
}

const base = {
  clientId: CLIENT_ID,
  redirectUris: ['https://app.example/cb'],
  scope: ['pryv:read'],
  grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
  accountUserId: 'u-' + CLIENT_ID,
};

async function auth (platform, client, token, extra = {}) {
  return await authenticateClient({
    client, clientId: CLIENT_ID, assertion: token, assertionType: CLIENT_ASSERTION_TYPE, platform, expectedAudiences: AUDS, ...extra,
  });
}

/** Route the counterparty calls to a stub; returns the call log. */
function stubTransport (answer) {
  const calls = [];
  setPeerTransportForTests(async (url, init) => {
    calls.push({ url, init });
    return await answer(url, init);
  });
  return calls;
}
const jsonAnswer = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('[OCAK] client authentication keys, rotation and lifetimes', function () {
  this.timeout(30000);
  let rs, es, es256;
  before(() => {
    rs = makeKey('RS384', 'rsa-1');
    es = makeKey('ES384', 'ec-1');
    es256 = makeKey('ES256');
  });
  afterEach(() => { setPeerTransportForTests(null); resetJwksCacheForTests(); });

  describe('[OCAK-ALG] algorithms, pinning and kid', () => {
    it('[OCAK1] ES384 and RS384 assertions verify against their key; ES256 is unchanged', async () => {
      for (const key of [rs, es, es256]) {
        const v = await verifyClientAssertion(assertion(key), { clientId: CLIENT_ID, jwks: { keys: [key.publicJwk] }, expectedAudiences: AUDS });
        assert.ok(v.jti, key.alg);
      }
    });

    it('[OCAK2] one client, two keys (RS384 + ES384) and both algorithms pinned: each alg accepted; an RS384 header naming the ES384 kid refused', async () => {
      const platform = fakePlatform();
      await persistClient(platform, { ...base, jwks: { keys: [rs.publicJwk, es.publicJwk] }, tokenEndpointAuthSigningAlgs: ['RS384', 'ES384'] });
      const client = await storedClient(platform, CLIENT_ID);
      assert.equal((await auth(platform, client, assertion(rs))).ok, true, 'RS384');
      assert.equal((await auth(platform, client, assertion(es))).ok, true, 'ES384');
      // Alg confusion: the header claims RS384 but names the EC key (signed with the RSA key, or the EC key).
      assert.equal((await auth(platform, client, assertion(rs, { kid: 'ec-1' }))).ok, false);
      assert.equal((await auth(platform, client, assertion(es, { alg: 'RS384', kid: 'ec-1' }))).ok, false);
      assert.equal((await auth(platform, client, assertion(es, { kid: 'rsa-1' }))).ok, false);
      // Two keys: the header must name one.
      assert.equal((await auth(platform, client, assertion(rs, { kid: null }))).ok, false);
      // A kid on file but not this key's.
      assert.equal((await auth(platform, client, assertion(rs, { kid: 'nope' }))).ok, false);
    });

    it('[OCAK3] pinning: an RS256 or an RS384 assertion against an ES384-only client is refused, its ES384 one accepted', async () => {
      const platform = fakePlatform();
      await persistClient(platform, { ...base, jwks: { keys: [rs.publicJwk, es.publicJwk] }, tokenEndpointAuthSigningAlgs: ['ES384'] });
      const client = await storedClient(platform, CLIENT_ID);
      assert.equal((await auth(platform, client, assertion(rs))).ok, false, 'RS384 is supported but not pinned');
      assert.equal((await auth(platform, client, assertion(rs, { alg: 'RS256' }))).ok, false, 'RS256');
      assert.equal((await auth(platform, client, assertion(es))).ok, true);
    });

    it('[OCAK4] a client without a pinned list keeps any algorithm that fits its key (an ES256 client still works, RS384 refused)', async () => {
      const platform = fakePlatform();
      await persistClient(platform, { ...base, jwks: { keys: [es256.publicJwk] } });
      const client = await storedClient(platform, CLIENT_ID);
      assert.equal((await auth(platform, client, assertion(es256))).ok, true);
      assert.equal((await auth(platform, client, assertion(es256, { alg: 'ES384' }))).ok, false);
      assert.equal((await auth(platform, client, assertion(rs))).ok, false);
    });

    it('[OCAK5] a key carrying its own alg is used with that alg only; a crit header is refused; HS384 / none refused', async () => {
      const keyed = { ...es.publicJwk, alg: 'ES384' };
      const opts = { clientId: CLIENT_ID, jwks: { keys: [keyed] }, expectedAudiences: AUDS };
      assert.ok((await verifyClientAssertion(assertion(es), opts)).jti);
      await assert.rejects(verifyClientAssertion(assertion(es, { header: { crit: ['exp'] } }), opts));
      await assert.rejects(verifyClientAssertion(assertion(es, { alg: 'HS384' }), opts));
      await assert.rejects(verifyClientAssertion(assertion(es, { alg: 'none' }), opts));
      assert.throws(() => validatePublicJwk({ ...es.publicJwk, alg: 'RS384' }), /alg/);
    });

    it('[OCAK6] the jti burn is unchanged: the same RS384 assertion twice, the second refused', async () => {
      const platform = fakePlatform();
      await persistClient(platform, { ...base, jwks: { keys: [rs.publicJwk, es.publicJwk] } });
      const client = await storedClient(platform, CLIENT_ID);
      const a = assertion(rs);
      assert.equal((await auth(platform, client, a)).ok, true);
      assert.equal((await auth(platform, client, a)).ok, false);
    });

    it('[OCAK7] key set rules: RSA under 2048 bits, private members, several keys without or with duplicate kids, an encryption key: refused', () => {
      const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
      assert.throws(() => validatePublicJwk({ kty: 'RSA', n: small.n, e: small.e }), /2048/);
      const priv = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
      assert.throws(() => validatePublicJwk(priv), /private key material/);
      assert.throws(() => validatePublicJwkSet({ keys: [{ ...rs.publicJwk, kid: undefined }, es.publicJwk] }), /kid/);
      assert.throws(() => validatePublicJwkSet({ keys: [rs.publicJwk, { ...es.publicJwk, kid: 'rsa-1' }] }), /share/);
      assert.throws(() => validatePublicJwk({ ...es.publicJwk, use: 'enc' }), /use/);
      assert.match(computeThumbprint(validatePublicJwk(rs.publicJwk)), /^[A-Za-z0-9_-]{43}$/);
      assert.match(computeThumbprint(validatePublicJwk(es.publicJwk)), /^[A-Za-z0-9_-]{43}$/);
    });

    it('[OCAK8] registration rules: a pinned alg with no fitting key, an unknown alg, jwks with jwksUri, an http jwksUri: refused', async () => {
      const platform = fakePlatform();
      await assert.rejects(persistClient(platform, { ...base, jwks: { keys: [es.publicJwk] }, tokenEndpointAuthSigningAlgs: ['RS384'] }), /no key of the jwks fits RS384/);
      await assert.rejects(persistClient(platform, { ...base, jwks: { keys: [es.publicJwk] }, tokenEndpointAuthSigningAlgs: ['RS256'] }), /tokenEndpointAuthSigningAlgs/);
      await assert.rejects(persistClient(platform, { ...base, tokenEndpointAuthSigningAlgs: ['ES384'] }), /needs a key set/);
      await assert.rejects(persistClient(platform, { ...base, jwks: { keys: [es.publicJwk] }, jwksUri: JWKS_URI }), /exclude/);
      await assert.rejects(persistClient(platform, { ...base, jwksUri: 'http://keys.example.com/jwks.json' }), /https/);
      assert.equal(await storedClient(platform, CLIENT_ID), null);
    });
  });

  describe('[OCAK-URI] jwks_uri', () => {
    it('[OCAK9] a client by jwks_uri authenticates; the set is fetched once and cached (5 minutes), then fetched again', async () => {
      const calls = stubTransport(jsonAnswer({ keys: [rs.publicJwk, es.publicJwk] }));
      const platform = fakePlatform();
      await persistClient(platform, { ...base, jwksUri: JWKS_URI, tokenEndpointAuthSigningAlgs: ['RS384', 'ES384'] });
      const client = await storedClient(platform, CLIENT_ID);
      assert.equal((await auth(platform, client, assertion(rs))).ok, true);
      assert.equal((await auth(platform, client, assertion(es))).ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, JWKS_URI);
      assert.equal(calls[0].init.redirect, 'manual');
      // Cache expiry, on an injected clock.
      const t0 = Date.now();
      await getClientJwks(JWKS_URI, { now: t0 + JWKS_CACHE_TTL_MS - 1000 });
      assert.equal(calls.length, 1, 'still cached');
      await getClientJwks(JWKS_URI, { now: t0 + JWKS_CACHE_TTL_MS + 1000 });
      assert.equal(calls.length, 2, 'fetched again after the cache lifetime');
    });

    it('[OCAK10] SSRF: private, loopback, link-local addresses and plain http are refused before any call', async () => {
      const calls = stubTransport(jsonAnswer({ keys: [es.publicJwk] }));
      for (const uri of [
        'https://10.0.0.5/jwks', 'https://192.168.1.10/jwks', 'https://169.254.169.254/latest/meta-data',
        'https://[fd00::1]/jwks', 'https://0.0.0.0/jwks', 'http://keys.example.com/jwks',
        'https://user:pw@keys.example.com/jwks',
      ]) {
        await assert.rejects(getClientJwks(uri), (e) => e instanceof JwksFetchError && typeof e.reason === 'string', uri);
      }
      assert.equal(calls.length, 0);
      // Through client authentication: a uniform refusal.
      const platform = fakePlatform();
      const client = { ...base, jwksUri: 'https://169.254.169.254/jwks' };
      assert.deepEqual(await auth(platform, client, assertion(es)), { ok: false, status: 401, error: 'invalid_client', description: 'client authentication failed' });
    });

    it('[OCAK11] a redirect, a non-200 answer, an oversized or non-JSON body, a set with private material: refused', async () => {
      const cases = [
        [async () => new Response(null, { status: 302, headers: { location: 'https://10.0.0.5/jwks' } }), /302/],
        [jsonAnswer({ error: 'x' }, 500), /500/],
        [async () => new Response('x'.repeat(MAX_JWKS_RESPONSE_BYTES + 1), { status: 200 }), /too large/],
        [async () => new Response('not json', { status: 200 }), /not JSON/],
        [jsonAnswer({ keys: [crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ format: 'jwk' })] }), /private/],
        [jsonAnswer({ keys: [{ kty: 'oct', k: 'abc' }] }), /private/],
        [jsonAnswer({ keys: [{ ...es.publicJwk, use: 'enc' }] }), /no usable/],
      ];
      for (const [answer, reason] of cases) {
        resetJwksCacheForTests();
        stubTransport(answer);
        await assert.rejects(getClientJwks(JWKS_URI), (e) => reason.test(e.reason), String(reason));
      }
    });

    it('[OCAK12] a failed fetch is remembered 30 seconds (no call per assertion), then retried', async () => {
      let status = 503;
      const calls = stubTransport(async () => new Response('{}', { status }));
      const t0 = Date.now();
      await assert.rejects(getClientJwks(JWKS_URI, { now: t0 }));
      await assert.rejects(getClientJwks(JWKS_URI, { now: t0 + 1000 }));
      assert.equal(calls.length, 1);
      status = 200;
      setPeerTransportForTests(async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ keys: [es.publicJwk] }), { status: 200 }); });
      const set = await getClientJwks(JWKS_URI, { now: t0 + JWKS_FAILURE_TTL_MS + 1 });
      assert.equal(set.keys.length, 1);
      assert.equal(calls.length, 2);
    });

    it('[OCAK13] key rotation by the client: an unknown kid refreshes the cached set (at most every 30 s)', async () => {
      let published = { keys: [es.publicJwk] };
      const calls = stubTransport(async () => new Response(JSON.stringify(published), { status: 200 }));
      const t0 = Date.now();
      await getClientJwks(JWKS_URI, { now: t0 });
      published = { keys: [es.publicJwk, rs.publicJwk] };
      await getClientJwks(JWKS_URI, { now: t0 + 1000, unknownKid: true });
      assert.equal(calls.length, 1, 'too soon: the cached set is used');
      const fresh = await getClientJwks(JWKS_URI, { now: t0 + 31000, unknownKid: true });
      assert.equal(calls.length, 2);
      assert.equal(fresh.keys.length, 2);
    });
  });

  describe('[OCAK-SEC] secret rotation window', () => {
    it('[OCAK14] the replaced secret is accepted until its expiry, then refused; the current one always', async () => {
      const oldSecret = await mintSecret();
      const newSecret = await mintSecret();
      const platform = fakePlatform();
      const expiresAt = Date.now() + 3600 * 1000;
      await persistClient(platform, { ...base, clientSecretHash: newSecret.hash, previousSecretHash: oldSecret.hash, previousSecretExpiresAt: expiresAt });
      const client = await storedClient(platform, CLIENT_ID);
      const withSecret = (s, now) => authenticateClient({ client, clientId: CLIENT_ID, presentedSecret: s, now });
      assert.equal((await withSecret(newSecret.plaintext)).ok, true);
      assert.equal((await withSecret(oldSecret.plaintext)).ok, true, 'inside the window');
      assert.equal((await withSecret(oldSecret.plaintext, expiresAt + 1)).ok, false, 'after the window');
      assert.equal((await withSecret(newSecret.plaintext, expiresAt + 1)).ok, true);
      assert.equal((await withSecret('wrong')).ok, false);
    });

    it('[OCAK15] registration rules: a previous secret needs an expiry, a current secret and a window of 30 days at most', async () => {
      const s = await mintSecret();
      const platform = fakePlatform();
      await assert.rejects(persistClient(platform, { ...base, clientSecretHash: s.hash, previousSecretHash: s.hash }), /go together/);
      await assert.rejects(persistClient(platform, { ...base, previousSecretHash: s.hash, previousSecretExpiresAt: Date.now() + 1000 }), /current one/);
      await assert.rejects(persistClient(platform, {
        ...base, clientSecretHash: s.hash, previousSecretHash: s.hash, previousSecretExpiresAt: Date.now() + 31 * 24 * 3600 * 1000,
      }), /30 days/);
    });
  });

  describe('[OCAK-TTL] per-client lifetimes and offline access', () => {
    it('[OCAK16] lifetimes: the client\'s own, clamped to the platform\'s; invalid values refused at registration', async () => {
      const config = fakeConfig({ 'oauth:accessTokenTTL': 600 });
      assert.deepEqual(clientLifetimes(config, null), { accessTokenTTL: 600, refreshTokenTTL: 30 * 24 * 3600, refreshTokenAbsoluteTTL: 90 * 24 * 3600 });
      assert.deepEqual(clientLifetimes(config, { accessTokenTTL: 300, refreshTokenTTL: 7200, refreshTokenAbsoluteTTL: 365 * 24 * 3600 }),
        { accessTokenTTL: 300, refreshTokenTTL: 7200, refreshTokenAbsoluteTTL: 90 * 24 * 3600 });
      assert.equal(clientLifetimes(config, { accessTokenTTL: 99999 }).accessTokenTTL, 600, 'clamped to the cap');
      const platform = fakePlatform();
      await assert.rejects(persistClient(platform, { ...base, accessTokenTTL: 0 }), /positive integer/);
      await assert.rejects(persistClient(platform, { ...base, refreshTokenTTL: 1.5 }), /positive integer/);
      await assert.rejects(persistClient(platform, { ...base, refreshTokenTTL: 7200, refreshTokenAbsoluteTTL: 3600 }), /exceed/);
      await assert.rejects(persistClient(platform, { ...base, offlineAccessAllowed: 'no' }), /true or false/);
    });

    const VERIFIER = 'verifier-1234567890-abcdefg-hijklmnop-qrstuv';
    const challenge = (v) => crypto.createHash('sha256').update(v).digest('base64url');
    async function seedCode (platform, code) {
      await setCode(platform, code, {
        clientId: CLIENT_ID,
        redirectUri: 'https://app.example/cb',
        codeChallenge: challenge(VERIFIER),
        codeChallengeMethod: 'S256',
        userId: 'u-alice',
        scope: ['pryv:read'],
        expiresAt: Date.now() + 60_000,
        accessId: 'acc-u-alice',
        coreId: CORE_ID,
      });
    }
    function handler (platform, config = fakeConfig()) {
      return rawHandleToken({
        config,
        platform,
        resolveAccess: async () => ({ accessToken: 'tok-alice', apiEndpoint: 'https://alice.pryv.me/' }),
        revokeAccessLocal: async () => {},
        resolveUsername: async (userId) => (userId === 'u-alice' ? 'alice' : null),
        mintRefreshedAccess: async ({ expiresAt }) => ({ accessId: 'acc-r', accessToken: 'tok-r-' + expiresAt, apiEndpoint: 'https://alice.pryv.me/' }),
      });
    }
    const exchange = (code, a) => ({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      client_id: CLIENT_ID,
      redirect_uri: 'https://app.example/cb',
      client_assertion: a,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
    });

    it('[OCAK17] a code exchange and a refresh by an RS384 client answer the client\'s lifetimes (clamped), the refresh row carries them', async () => {
      const platform = fakePlatform();
      await persistClient(platform, {
        ...base,
        jwks: { keys: [rs.publicJwk, es.publicJwk] },
        tokenEndpointAuthSigningAlgs: ['RS384', 'ES384'],
        accessTokenTTL: 900,
        refreshTokenTTL: 7200,
        refreshTokenAbsoluteTTL: 10 * 24 * 3600,
      });
      await seedCode(platform, 'C-TTL');
      const h = handler(platform, fakeConfig({ 'oauth:refreshTokenTTL': 3600 }));
      const res = fakeRes();
      const before = Date.now();
      await h({ body: exchange('C-TTL', assertion(rs)) }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.expires_in, 900);
      const row = await getRefresh(platform, CORE_ID, res.body.refresh_token);
      assert.ok(row.expiresAt <= Date.now() + 3600 * 1000 && row.expiresAt >= before + 3600 * 1000, 'sliding TTL clamped to the platform cap');
      assert.ok(Math.abs(row.absoluteExpiresAt - (before + 10 * 24 * 3600 * 1000)) < 5000, 'the client\'s absolute TTL');
      const r = fakeRes();
      await h({ body: { grant_type: 'refresh_token', refresh_token: res.body.refresh_token, client_id: CLIENT_ID, client_assertion: assertion(es), client_assertion_type: CLIENT_ASSERTION_TYPE } }, r);
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));
      assert.equal(r.body.expires_in, 900);
    });

    it('[OCAK18] offline access withheld: no refresh token at the exchange; a refresh token issued before is refused without being used up', async () => {
      const platform = fakePlatform();
      await persistClient(platform, { ...base, jwks: { keys: [es.publicJwk] }, offlineAccessAllowed: false });
      await seedCode(platform, 'C-OFF');
      const h = handler(platform);
      const res = fakeRes();
      await h({ body: exchange('C-OFF', assertion(es)) }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal('refresh_token' in res.body, false);
      const now = Date.now();
      await setRefresh(platform, CORE_ID, 'RT-OFF', {
        clientId: CLIENT_ID, userId: 'u-alice', scope: ['pryv:read'], issuedAt: now, lastUsedAt: now, expiresAt: now + 3600_000, absoluteExpiresAt: now + 7200_000,
      });
      const r = fakeRes();
      await h({ body: { grant_type: 'refresh_token', refresh_token: 'RT-OFF', client_id: CLIENT_ID, client_assertion: assertion(es), client_assertion_type: CLIENT_ASSERTION_TYPE } }, r);
      assert.equal(r.statusCode, 400);
      assert.equal(r.body.error, 'unauthorized_client');
      assert.notEqual(await getRefresh(platform, CORE_ID, 'RT-OFF'), null, 'not used up');
    });
  });
});
