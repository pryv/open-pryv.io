/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OCMD] Client metadata documents (an https URL as client_id): the URL
 * rules and host policy, the row key, the fetch and its guards, the document
 * validation, the client row derived from it, the caches and budgets, the
 * configuration, the prune, the discovery flag, the operator CLI and the
 * access stamp. The counterparty transport is replaced by an in-memory
 * document server, except where the address guard itself is checked.
 */

const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const meta = require('../src/clientMetadata.ts');
const ids = require('../src/clientMetadataId.ts');
const conf = require('../src/clientMetadataConfig.ts');
const { persistClient, getClient } = require('../src/clientRegistry.ts');
const storage = require('../src/storage.ts');
const { buildDiscoveryDocument } = require('../src/wellKnown.ts');
const { setPeerTransportForTests, getPeerTransportForTests } = require('business/src/outbound/peerFetch.ts');
const cli = require('../../../bin/oauth-client.js');
const crypto = require('node:crypto');
const jwks = require('../src/jwks.ts');
const { authenticateClient } = require('../src/clientSecret.ts');
const { verifyClientAssertion, CLIENT_ASSERTION_TYPE } = require('../src/clientAssertion.ts');
const { isConfidentialClient } = require('../src/clientAuth.ts');

const ISSUER = 'https://issuer.example.net';

/** A signing key for `alg` (RS* an RSA 2048 key, ES256 a P-256 key), with its public JWK. */
function makeKey (alg, kid) {
  const { privateKey, publicKey } = alg.startsWith('RS')
    ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const jwk = pub.kty === 'RSA' ? { kty: 'RSA', n: pub.n, e: pub.e } : { kty: 'EC', crv: pub.crv, x: pub.x, y: pub.y };
  return { alg, privateKey, publicJwk: { ...jwk, kid }, rawPublic: pub };
}

/** A client assertion naming `clientId` (iss = sub), signed by `key` (`signAs`: the algorithm actually used). */
function signedAssertion (key, clientId, { alg = key.alg, signAs = key.alg, aud = ISSUER + '/oauth2/token' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = enc({ alg, typ: 'JWT', kid: key.publicJwk.kid }) + '.' +
    enc({ iss: clientId, sub: clientId, aud, jti: 'j-' + crypto.randomUUID(), exp: now + 120, iat: now });
  const hash = signAs.endsWith('384') ? 'sha384' : 'sha256';
  const sig = signAs.startsWith('RS')
    ? crypto.sign(hash, Buffer.from(input), key.privateKey)
    : crypto.sign(hash, Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return input + '.' + sig.toString('base64url');
}

const URL1 = 'https://client.example/oauth/client.json';
const URL2 = 'https://tools.example/agent/metadata.json';
const AUD = 'https://core.example.org/adapter/x/';

function fakePlatform () {
  const kv = new Map();
  return {
    kv,
    async setPlatformKv (k, v) { kv.set(k, v); },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvKeys (p) { return [...kv.keys()].filter((k) => k.startsWith(p)); },
    async listPlatformKvEntries (p) { return [...kv.entries()].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })); },
    state: new Map(),
    async setAccessStateIfAbsent (k, v, exp) {
      if (this.state.has(k)) return false;
      this.state.set(k, { value: v, expiresAt: exp });
      return true;
    },
  };
}

function block (overrides = {}, client = {}) {
  return {
    mode: 'any',
    allowedHosts: [],
    deniedHosts: [],
    ...overrides,
    client: { scope: 'read/a read/b', allowedAudiences: [AUD], subjectType: 'pairwise', maxEntries: 50, ...client },
  };
}

function fakeConfig (cmd = block(), extra = {}) {
  const m = {
    'service:api': 'https://{username}.pryv.example/',
    'core:url': 'https://core-a.pryv.example/',
    'dns:domain': 'pryv.example',
    'dnsLess:publicUrl': 'https://public.example.net/',
    'oauth:issuer': 'https://issuer.example.net',
    'oauth:refreshTokenAbsoluteTTL': 90 * 24 * 3600,
    'oauth:clientMetadataDocuments': cmd,
    ...extra,
  };
  return { get: (k) => m[k] };
}

function doc (url = URL1, extra = {}) {
  return { client_id: url, client_name: 'Example agent', redirect_uris: ['https://client.example/cb'], ...extra };
}

/** An in-memory document server: path -> answer; counts the calls. */
function docServer () {
  const answers = new Map();
  const server = {
    calls: 0,
    set (url, answer) { answers.set(url, answer); },
    async transport (url, init) {
      server.calls++;
      const a = answers.get(url);
      if (a == null) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      if (typeof a === 'function') return await a(init);
      const body = typeof a.body === 'string' ? a.body : JSON.stringify(a.body ?? a);
      return new Response(body, { status: a.status ?? 200, headers: a.headers ?? { 'content-type': 'application/json' } });
    },
  };
  return server;
}

const settingsOf = (cmd = block()) => conf.clientMetadataSettings(fakeConfig(cmd));

describe('[OCMD] client metadata documents', function () {
  let savedTransport;
  before(() => { savedTransport = getPeerTransportForTests(); });
  after(() => { setPeerTransportForTests(savedTransport); });
  beforeEach(() => { meta._resetClientMetadataForTests(); });

  it('[OCMD01] URL rules and host policy, before any network call', () => {
    const syntaxRefused = [
      'http://client.example/c.json', // not https
      'https://192.0.2.10/c.json', 'https://[2001:db8::1]/c.json', // IP literals
      'https://user@client.example/c.json', 'https://u:p@client.example/c.json', // userinfo
      'https://client.example/c.json#x', 'https://client.example/c.json#', // fragment
      'https://client.example', 'https://client.example?x=1', // no path
      'https://client.example/a/./c.json', 'https://client.example/a/../c.json', 'https://client.example//c.json',
      'https://client.example/%2e%2e/c.json', 'https://client.example/a%41.json', // dot segments, empty segment, escapes
      'https://Client.example/c.json', 'https://client.example:443/c.json', 'https://client.example./c.json', // spellings
      'https://client.example/c .json', 'https://client.example/c\t.json', 'https://client.example/c\u202e.json', // control / spaces
      'https://client.example/' + 'a'.repeat(2048), // length
      'https://bücher.example/c.json', // a host not in its ASCII form
    ];
    for (const raw of syntaxRefused) {
      assert.notEqual(ids.clientIdUrlSyntaxProblem(raw), null, 'refused: ' + JSON.stringify(raw));
      assert.equal(ids.isMetadataClientUrl(raw), false);
    }
    for (const ok of ['https://client.example/', URL1, 'https://client.example/c.json?v=2', 'https://client.example:8443/c.json', 'https://xn--bcher-kva.example/c.json']) {
      assert.equal(ids.clientIdUrlSyntaxProblem(ok), null, 'accepted: ' + ok);
    }
    const config = fakeConfig();
    const any = settingsOf();
    // This platform's hosts: the API hosts, the public URL's, the issuer's.
    for (const host of ['core-a.pryv.example', 'pryv.example', 'alice.pryv.example', 'public.example.net', 'issuer.example.net']) {
      const r = meta.clientIdUrlProblem('https://' + host + '/c.json', any, config);
      assert.deepEqual(r && r.reason, 'url', host);
    }
    assert.equal(meta.clientIdUrlProblem(URL1, any, config), null);
    // Allow-list: exact, one-label wildcard (never the apex, never two labels), explicit port.
    const list = settingsOf(block({ mode: 'allowList', allowedHosts: ['client.example', '*.tools.example', 'port.example:8443'] }));
    assert.equal(meta.clientIdUrlProblem(URL1, list, config), null);
    assert.equal(meta.clientIdUrlProblem('https://a.tools.example/m.json', list, config), null);
    assert.equal(meta.clientIdUrlProblem('https://tools.example/m.json', list, config).reason, 'host-policy');
    assert.equal(meta.clientIdUrlProblem('https://a.b.tools.example/m.json', list, config).reason, 'host-policy');
    assert.equal(meta.clientIdUrlProblem('https://port.example:8443/m.json', list, config), null);
    assert.equal(meta.clientIdUrlProblem('https://port.example/m.json', list, config).reason, 'host-policy');
    assert.equal(meta.clientIdUrlProblem('https://client.example:8443/m.json', list, config).reason, 'host-policy');
    assert.equal(meta.clientIdUrlProblem(URL2, list, config).reason, 'host-policy');
    // The deny-list wins, in both modes.
    const denied = settingsOf(block({ mode: 'allowList', allowedHosts: ['client.example'], deniedHosts: ['client.example'] }));
    assert.equal(meta.clientIdUrlProblem(URL1, denied, config).detail, 'the host is denied');
    const deniedAny = settingsOf(block({ deniedHosts: ['*.example'] }));
    assert.equal(meta.clientIdUrlProblem(URL1, deniedAny, config).reason, 'host-policy');
    // off: nothing is accepted.
    assert.equal(meta.clientIdUrlProblem(URL1, settingsOf({ mode: 'off' }), config).reason, 'host-policy');
  });

  it('[OCMD02] the row key and the wire id', () => {
    const key = ids.metadataClientKey(URL1);
    assert.match(key, /^url~[0-9a-f]{40}$/);
    assert.equal(storage.clientIdError(key.replace('url~', 'abc~')), null, 'the key shape passes the id rules');
    assert.match(storage.clientIdError(key), /reserved/, 'the prefix is reserved for such clients');
    assert.deepEqual(ids.clientRef(URL1), { key, url: URL1 });
    assert.deepEqual(ids.clientRef('my-app'), { key: 'my-app', url: null });
    assert.deepEqual(ids.clientRef('http://client.example/c.json'), { key: 'http://client.example/c.json', url: null });
    assert.notEqual(ids.metadataClientKey(URL1 + '?v=2'), key, 'two spellings are two clients');
    assert.equal(ids.publicClientId({ clientId: key, metadataUrl: URL1 }), URL1);
    assert.equal(ids.publicClientId({ clientId: 'my-app' }), 'my-app');
  });

  describe('[OCMD03] fetch', () => {
    let server;
    beforeEach(() => {
      server = docServer();
      setPeerTransportForTests(server.transport);
    });

    it('[OCMD03A] a 200 application/json document (a charset parameter passes)', async () => {
      server.set(URL1, { body: doc(), headers: { 'content-type': 'application/json; charset=utf-8' } });
      const r = await meta.fetchClientMetadataDocument(URL1, settingsOf());
      assert.equal(r.ok, true);
      assert.equal(r.doc.client_id, URL1);
    });

    it('[OCMD03B] a redirect is not followed, other statuses refused', async () => {
      server.set(URL1, { status: 302, body: doc(), headers: { 'content-type': 'application/json', location: URL2 } });
      server.set(URL2, { body: doc(URL2) });
      const r = await meta.fetchClientMetadataDocument(URL1, settingsOf());
      assert.deepEqual([r.ok, r.kind], [false, 'unreachable']);
      assert.match(r.detail, /302/);
      assert.equal(server.calls, 1, 'the location is not fetched');
      for (const status of [404, 500]) {
        server.set(URL1, { status, body: doc() });
        assert.equal((await meta.fetchClientMetadataDocument(URL1, settingsOf())).ok, false, String(status));
      }
    });

    it('[OCMD03C] content type: application/json only (+json suffixes refused)', async () => {
      for (const ct of ['text/plain', 'application/jwk-set+json', 'application/ld+json', '']) {
        server.set(URL1, { body: JSON.stringify(doc()), headers: ct === '' ? {} : { 'content-type': ct } });
        const r = await meta.fetchClientMetadataDocument(URL1, settingsOf());
        assert.deepEqual([r.ok, r.kind], [false, 'invalid'], ct);
      }
    });

    it('[OCMD03D] size: a declared length over the cap is refused before the body is read; an undeclared body is counted', async () => {
      const settings = settingsOf(block({ maxDocumentBytes: 1024 }));
      const big = JSON.stringify(doc(URL1, { padding: 'x'.repeat(2000) }));
      let pulled = 0;
      server.set(URL1, () => new Response(new ReadableStream({
        pull (c) { pulled++; c.enqueue(new TextEncoder().encode(big)); c.close(); },
      }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(big.length) } }));
      const declared = await meta.fetchClientMetadataDocument(URL1, settings);
      assert.deepEqual([declared.ok, declared.kind], [false, 'invalid']);
      assert.match(declared.detail, /declared/);
      assert.equal(pulled, 0, 'the body is not read');
      server.set(URL1, () => new Response(new ReadableStream({
        start (c) { for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode('x'.repeat(400))); c.close(); },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
      const counted = await meta.fetchClientMetadataDocument(URL1, settings);
      assert.deepEqual([counted.ok, counted.kind], [false, 'invalid']);
      assert.match(counted.detail, /larger than 1024 bytes$/);
    });

    it('[OCMD03E] a byte order mark, bad UTF-8, non-JSON and a non-object are invalid', async () => {
      const bodies = [
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(doc()))]),
        Buffer.from([0x7b, 0xff, 0x7d]),
        Buffer.from('not json'),
        Buffer.from('[1,2]'),
      ];
      for (const body of bodies) {
        server.set(URL1, () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
        const r = await meta.fetchClientMetadataDocument(URL1, settingsOf());
        assert.deepEqual([r.ok, r.kind], [false, 'invalid'], body.toString('hex').slice(0, 16));
      }
    });

    it('[OCMD03F] a server that does not answer within fetchTimeoutMs', async () => {
      server.set(URL1, (init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }));
      const t0 = Date.now();
      const r = await meta.fetchClientMetadataDocument(URL1, settingsOf(block({ fetchTimeoutMs: 50 })));
      assert.deepEqual([r.ok, r.kind, r.detail], [false, 'unreachable', 'timed out']);
      assert.ok(Date.now() - t0 < 2000);
    });

    it('[OCMD03G] the counterparty guards: a host resolving to a loopback address is refused before any connection', async () => {
      // The real guarded transport (no test transport), with a production
      // allow-list (the test configuration allows the loopback hosts):
      // `localhost` resolves to a loopback address, which the checked lookup
      // refuses; nothing listens on 443 there, so any other outcome is a
      // connection attempt.
      setPeerTransportForTests(null);
      const { compileAllowList } = require('business/src/webhooks/destination.ts');
      const strict = { allow: compileAllowList([]), allowInsecure: false, isPlatformHost: () => false };
      const r = await meta.fetchClientMetadataDocument('https://localhost/client.json', settingsOf(), { peerSettings: strict });
      assert.deepEqual([r.ok, r.kind, r.detail], [false, 'unreachable', 'refused: address']);
      // http is refused whatever the insecure-peer setting says.
      const h = await meta.fetchClientMetadataDocument('http://client.example/c.json', settingsOf(),
        { peerSettings: { ...strict, allowInsecure: true } });
      assert.equal(h.ok, false);
    });

    it('[OCMD03H] budgets: 10 fetches a minute per host, fetchesPerMinute per core; concurrent misses share one fetch', async () => {
      const platform = fakePlatform();
      const config = fakeConfig(block({ fetchesPerMinute: 12, negativeCacheSeconds: 0 }));
      const now = Date.now();
      // Every fetch fails (404): the URL is fetched again (no negative cache).
      for (let i = 0; i < 10; i++) {
        const r = await meta.resolveMetadataClient({ platform, config }, URL1, { now: now + i });
        assert.equal(r.reason, 'unreachable', 'fetch ' + i);
      }
      assert.equal(server.calls, 10);
      const spent = await meta.resolveMetadataClient({ platform, config }, URL1, { now: now + 10 });
      assert.deepEqual([spent.reason, server.calls], ['budget', 10], 'per host');
      await meta.resolveMetadataClient({ platform, config }, URL2, { now: now + 11 });
      await meta.resolveMetadataClient({ platform, config }, URL2, { now: now + 12 });
      const core = await meta.resolveMetadataClient({ platform, config }, 'https://other.example/m.json', { now: now + 13 });
      assert.deepEqual([core.reason, server.calls], ['budget', 12], 'per core');
      // A minute later the window has moved on.
      const later = await meta.resolveMetadataClient({ platform, config }, URL1, { now: now + 61000 });
      assert.equal(later.reason, 'unreachable');

      meta._resetClientMetadataForTests();
      server.calls = 0;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      server.set(URL1, async () => {
        await gate;
        return new Response(JSON.stringify(doc()), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      const pending = [1, 2, 3, 4, 5].map(() => meta.resolveMetadataClient({ platform, config }, URL1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      const results = await Promise.all(pending);
      assert.ok(results.every((r) => r.ok === true));
      assert.equal(server.calls, 1, 'one fetch for concurrent misses');
    });
  });

  it('[OCMD04] document validation', () => {
    const s = settingsOf();
    const check = (d, url = URL1) => meta.clientMetadataProblem(d, url, s);
    const refused = (d, re, why) => {
      const r = check(d);
      assert.equal(r.ok, false, why);
      assert.match(r.detail, re, why);
    };
    refused({ ...doc(), client_id: URL1 + '/' }, /client-id-mismatch/, 'trailing slash');
    refused({ ...doc(), client_id: URL1.replace('client.example', 'CLIENT.example') }, /client-id-mismatch/, 'case');
    refused({ ...doc(), client_id: undefined }, /client-id-mismatch/, 'absent');
    refused({ ...doc(), redirect_uris: [] }, /redirect_uris/, 'none');
    refused({ ...doc(), redirect_uris: Array.from({ length: 33 }, (_, i) => 'https://client.example/cb' + i) }, /redirect_uris/, '33');
    refused({ ...doc(), redirect_uris: ['https://client.example/cb#f'] }, /fragment/, 'fragment');
    refused({ ...doc(), redirect_uris: ['https://client.example/c\nb'] }, /control/, 'control');
    refused({ ...doc(), redirect_uris: ['not a uri'] }, /absolute/, 'relative');
    refused({ ...doc(), redirect_uris: ['http://client.example/cb'] }, /loopback/, 'plain http elsewhere');
    refused({ ...doc(), token_endpoint_auth_method: 'client_secret_basic' }, /unsupported-auth-method/, 'secret');
    refused({ ...doc(), grant_types: ['refresh_token'] }, /unsupported-grant-types/, 'no code grant');
    refused({ ...doc(), grant_types: 'authorization_code' }, /grant_types/, 'not a list');
    refused({ ...doc(), response_types: ['token'] }, /unsupported-response-types/, 'implicit');
    refused({ ...doc(), client_name: 'x'.repeat(129) }, /client_name/, 'long name');
    refused({ ...doc(), client_name: 'bad\u202ename' }, /client_name/, 'bidi');
    refused({ ...doc(), 'client_name#xx_1': 'Nom' }, /client_name#/, 'bad language code');

    // Loopback plain http (any port at /authorize) and private-use schemes pass.
    const ok = check(doc(URL1, { redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback', 'com.example.app:/cb'] }));
    assert.equal(ok.ok, true);
    // Absent auth method reads as none; grant types: RFC 7591 default, the intersection.
    assert.equal(ok.fields.tokenEndpointAuthMethod, 'none');
    assert.deepEqual(ok.fields.grantTypes, ['authorization_code']);
    const g = check(doc(URL1, { token_endpoint_auth_method: 'none', grant_types: ['urn:ietf:params:oauth:grant-type:jwt-bearer', 'refresh_token', 'authorization_code'] }));
    assert.deepEqual(g.fields.grantTypes, ['authorization_code', 'refresh_token']);
    // Names: a string and a per-language set.
    const n = check(doc(URL1, { 'client_name#fr': 'Agent exemple', 'client_name#de': 'Beispiel' }));
    assert.equal(n.fields.clientName, 'Example agent');
    assert.deepEqual(n.fields.name, { fr: 'Agent exemple', de: 'Beispiel' });
    // Links: kept on the document's host only (the port counts); the logo too.
    const links = check(doc(URL1, {
      client_uri: 'https://client.example/about',
      policy_uri: 'https://elsewhere.example/policy',
      tos_uri: 'https://client.example:8443/tos',
      logo_uri: 'https://cdn.example/logo.png',
    }));
    assert.equal(links.fields.clientUri, 'https://client.example/about');
    assert.equal(links.fields.policyUri, undefined);
    assert.equal(links.fields.tosUri, undefined);
    assert.equal(links.fields.logoUri, undefined);
    assert.deepEqual(links.dropped.sort(), ['logo_uri', 'policy_uri', 'tos_uri']);
    assert.equal(check(doc(URL1, { logo_uri: 'https://client.example/logo.png' })).fields.logoUri, 'https://client.example/logo.png');
    // Reach and anything unknown is ignored (and named for the log).
    const ignored = check(doc(URL1, { scope: 'read/everything', dpop_bound_access_tokens: true, require_signed_request_object: true, extra: 1 }));
    assert.equal(ignored.ok, true);
    assert.deepEqual(ignored.ignored.sort(), ['dpop_bound_access_tokens', 'extra', 'require_signed_request_object', 'scope']);
    assert.equal(ignored.fields.scope, undefined);
    // software_id and contacts: bounded, dropped when out of bounds.
    const sw = check(doc(URL1, { software_id: 'agent', contacts: Array.from({ length: 9 }, () => 'a@b.example') }));
    assert.equal(sw.fields.softwareId, 'agent');
    assert.equal(sw.fields.contacts, undefined);
  });

  it('[OCMD05] the client row: the template, the hard-coded limits; the registry refuses what such a row may not hold', async () => {
    const s = settingsOf(block({}, { launchTypes: ['agent'], regions: ['eu'], offlineAccessAllowed: false, accessTokenTTL: 600 }));
    const checked = meta.clientMetadataProblem(doc(URL1, { grant_types: ['authorization_code', 'refresh_token'] }), URL1, s);
    const row = meta.buildMetadataClientRow(URL1, checked.fields, s, null, 1000);
    assert.equal(row.clientId, ids.metadataClientKey(URL1));
    assert.deepEqual([row.kind, row.origin, row.metadataUrl, row.status], ['registry', 'metadata-document', URL1, 'active']);
    assert.deepEqual(row.scope, ['read/a', 'read/b']);
    assert.deepEqual(row.allowedAudiences, [AUD]);
    assert.deepEqual([row.launchTypes, row.subjectType, row.maxEntries, row.regions], [['agent'], 'pairwise', 50, ['eu']]);
    assert.deepEqual([row.offlineAccessAllowed, row.accessTokenTTL], [false, 600]);
    assert.deepEqual(row.allowFeatures, []);
    assert.equal(row.tokenEndpointAuthMethod, 'none');
    for (const k of ['canIntrospect', 'canExchange', 'anyAudience', 'allowInsecureRedirect', 'dpopBoundAccessTokens', 'clientSecretHash']) {
      assert.equal(row[k], undefined, k);
    }
    assert.deepEqual([row.metadata.fetchedAt, row.metadata.expiresAt, row.metadata.lastUsedAt], [1000, 1000 + 3600 * 1000, 1000]);
    assert.equal(row.updatedAt, 1000);
    const platform = fakePlatform();
    await persistClient(platform, row);
    assert.equal((await getClient(platform, row.clientId)).metadataUrl, URL1);
    for (const [k, v] of [['canIntrospect', true], ['allowFeatures', ['webhooks']], ['clientSecretHash', 'h'],
      ['allowInsecureRedirect', true]]) {
      await assert.rejects(persistClient(platform, { ...row, [k]: v }), /not available to such a client/, k);
    }
    // (A public row is refused the exchange role by the registry rule first.)
    await assert.rejects(persistClient(platform, { ...row, canExchange: true }), /confidential client/);
    await assert.rejects(persistClient(platform, { ...row, allowedAudiences: [], anyAudience: true }), /not available to such a client: anyAudience/);
    await assert.rejects(persistClient(platform, { ...row, clientId: ids.metadataClientKey(URL2) }), /derived from its URL/);
    await assert.rejects(persistClient(platform, { ...row, origin: undefined }), /reserved/);
    await assert.rejects(persistClient(platform, { ...row, clientId: 'plain-id' }), /derived from its URL/);
    await assert.rejects(persistClient(platform, { ...row, tokenEndpointAuthMethod: 'client_secret_basic' }), /needs a client secret|none or private_key_jwt/);
  });

  describe('[OCMD06] the row as the cache', () => {
    let server, platform, config;
    beforeEach(() => {
      server = docServer();
      setPeerTransportForTests(server.transport);
      platform = fakePlatform();
      config = fakeConfig(block({ cacheSeconds: 60, staleGraceSeconds: 600, negativeCacheSeconds: 30 }));
    });
    const resolve = (now) => meta.resolveMetadataClient({ platform, config }, URL1, { now });

    it('[OCMD06A] a fresh row is used without a fetch; a stale one is fetched again; unchanged content keeps updatedAt, a change bumps it', async () => {
      server.set(URL1, doc());
      const t = 1_000_000;
      const first = await resolve(t);
      assert.equal(first.ok, true);
      assert.equal(server.calls, 1);
      await resolve(t + 59000);
      assert.equal(server.calls, 1, 'fresh: no fetch');
      const again = await resolve(t + 61000);
      assert.equal(server.calls, 2, 'stale: fetched');
      assert.equal(again.client.updatedAt, first.client.updatedAt, 'same content, same updatedAt');
      assert.equal(again.client.metadata.fetchedAt, t + 61000);
      server.set(URL1, doc(URL1, { client_name: 'Renamed agent' }));
      const changed = await resolve(t + 130000);
      assert.equal(changed.client.clientName, 'Renamed agent');
      assert.equal(changed.client.updatedAt, t + 130000);
    });

    it('[OCMD06B] a failed refetch keeps the row within the stale grace, refuses past it, and keeps the row', async () => {
      server.set(URL1, doc());
      const t = 2_000_000;
      await resolve(t);
      server.set(URL1, { status: 503, body: 'down' });
      const within = await resolve(t + 120000);
      assert.equal(within.ok, true, 'within grace');
      assert.equal(server.calls, 2);
      // The negative cache: no fetch within 30 s, the row still served.
      assert.equal((await resolve(t + 125000)).ok, true);
      assert.equal(server.calls, 2);
      const past = await resolve(t + 700000);
      assert.deepEqual([past.ok, past.reason, past.message], [false, 'stale', meta.METADATA_STALE]);
      assert.notEqual(await getClient(platform, ids.metadataClientKey(URL1)), null, 'the row is kept');
    });

    it('[OCMD06C] an invalid or unreachable document is negatively cached; the operator status survives a refetch; a use is recorded hourly', async () => {
      server.set(URL1, doc(URL1, { client_id: URL2 }));
      const t = 3_000_000;
      const bad = await resolve(t);
      assert.deepEqual([bad.ok, bad.reason, bad.message], [false, 'invalid', meta.METADATA_INVALID]);
      assert.equal((await resolve(t + 1000)).reason, 'invalid');
      assert.equal(server.calls, 1, 'not fetched again within negativeCacheSeconds');
      server.set(URL1, doc());
      const ok = await resolve(t + 31000);
      assert.equal(ok.ok, true);
      const key = ok.client.clientId;
      await storage.setClient(platform, { ...ok.client, status: 'suspended', statusLog: [{ at: 1, by: 'op', from: 'active', to: 'suspended', reason: 'suspend' }] });
      const refetched = await resolve(t + 31000 + 61000);
      assert.equal(refetched.client.status, 'suspended');
      assert.equal(refetched.client.statusLog.length, 1);
      // lastUsedAt: written at most once an hour.
      await storage.setClient(platform, { ...refetched.client, status: 'active', metadata: { ...refetched.client.metadata, expiresAt: t + 10 ** 9 } });
      const before = (await getClient(platform, key)).metadata.lastUsedAt;
      await resolve(before + 1000);
      assert.equal((await getClient(platform, key)).metadata.lastUsedAt, before);
      await resolve(before + 3600 * 1000 + 1);
      assert.equal((await getClient(platform, key)).metadata.lastUsedAt, before + 3600 * 1000 + 1);
    });
  });

  it('[OCMD07] configuration', () => {
    const problems = (raw) => conf.describeClientMetadataConfig(raw).problems;
    assert.deepEqual(problems(undefined), []);
    assert.deepEqual(problems({ mode: 'off' }), []);
    assert.deepEqual(problems({ mode: false }), [], 'off as YAML 1.1 reads it');
    assert.deepEqual(problems({ mode: 'off', client: { nonsense: 1 } }), [], 'off ignores the rest');
    assert.match(conf.describeClientMetadataConfig({ mode: 'off', allowedHosts: ['a.example'] }).warnings[0], /allowedHosts/);
    assert.deepEqual(problems(block()), []);
    assert.deepEqual(problems(block({ mode: 'allowList', allowedHosts: ['client.example', '*.tools.example', 'port.example:8443'] })), []);
    const table = [
      [{ mode: 'open' }, /mode/],
      [block({ mode: 'allowList' }), /nothing would be accepted/],
      [block({ allowedHosts: ['Client.example'] }), /lower-case/],
      [block({ allowedHosts: ['https://client.example'] }), /host name|port/],
      [block({ allowedHosts: ['client.example:443'] }), /443/],
      [block({ allowedHosts: ['*.example'] }), /two labels/],
      [block({ deniedHosts: ['10.0.0.1'] }), /IP address/],
      [block({ cacheSeconds: 0 }), /cacheSeconds/],
      [block({ maxDocumentBytes: 10 }), /maxDocumentBytes/],
      [block({ authMethods: ['client_secret_basic'] }), /authMethods/],
      [block({ unknown: 1 }), /not a setting/],
      [block({}, { scope: '' }), /scope is required/],
      [block({}, { allowedAudiences: [] }), /allowedAudiences is required/],
      [block({}, { allowedAudiences: ['http://x.example/'] }), /https URL/],
      [block({}, { anyAudience: true }), /not a template setting/],
      [block({}, { canExchange: true }), /not a template setting/],
      [block({}, { subjectType: 'other' }), /subjectType/],
      [block({}, { maxEntries: 1001 }), /maxEntries/],
      [block({}, { refreshTokenTTL: 10, refreshTokenAbsoluteTTL: 5 }), /must not exceed/],
      [block({}, { regions: ['a', 'a'] }), /twice/],
    ];
    for (const [raw, re] of table) {
      const p = problems(raw);
      assert.ok(p.some((m) => re.test(m)), JSON.stringify(raw) + ' -> ' + JSON.stringify(p));
    }
    // A block with problems reads as off at runtime.
    assert.equal(conf.clientMetadataSettings(fakeConfig(block({ mode: 'allowList' }))).mode, 'off');
    assert.equal(conf.MAX_TEMPLATE_ENTRIES, require('../src/scopeGrammar.ts').MAX_SYNTH_ENTRIES);
    assert.match(conf.describeClientMetadataConfig(block()).warnings[0], /any party on the internet/);
  });

  it('[OCMD08] prune: a row unused past the absolute refresh lifetime + 7 days is deleted with a tombstone; suspended and recent rows are kept', async () => {
    const platform = fakePlatform();
    const s = settingsOf();
    const now = Date.now();
    const horizon = 90 * 24 * 3600 * 1000 + 7 * 24 * 3600 * 1000;
    const rowAt = (url, lastUsedAt, extra = {}) => {
      const r = meta.buildMetadataClientRow(url, meta.clientMetadataProblem(doc(url), url, s).fields, s, null, lastUsedAt);
      return { ...r, ...extra };
    };
    await persistClient(platform, rowAt(URL1, now - horizon - 1000));
    await persistClient(platform, rowAt(URL2, now - horizon - 1000, { status: 'suspended' }));
    await persistClient(platform, rowAt('https://recent.example/m.json', now - 1000));
    assert.equal(await meta.pruneMetadataClients(platform, fakeConfig(), now), 1);
    assert.equal(await getClient(platform, ids.metadataClientKey(URL1)), null);
    assert.notEqual(await storage.getRevokedAt(platform, ids.metadataClientKey(URL1)), null, 'tombstone written');
    assert.notEqual(await getClient(platform, ids.metadataClientKey(URL2)), null);
    assert.notEqual(await getClient(platform, ids.metadataClientKey('https://recent.example/m.json')), null);
  });

  it('[OCMD09] discovery: the flag per mode; none and the iss parameter are always advertised', () => {
    for (const on of [false, true]) {
      const d = buildDiscoveryDocument({ issuer: 'https://x', scopesSupported: [], clientMetadataDocuments: on });
      assert.equal(d.client_id_metadata_document_supported, on ? true : undefined);
      assert.ok(d.token_endpoint_auth_methods_supported.includes('none'));
      assert.equal(d.authorization_response_iss_parameter_supported, true);
    }
    assert.equal(conf.clientMetadataDocumentsOn(fakeConfig({ mode: 'off' })), false);
    assert.equal(conf.clientMetadataDocumentsOn(fakeConfig(block({ mode: 'allowList', allowedHosts: ['client.example'] }))), true);
    assert.equal(conf.clientMetadataDocumentsOn(fakeConfig(block())), true);
  });

  describe('[OCMD10] operator CLI', () => {
    let server, platform;
    const savedConfig = cli.cliEnv.config;
    beforeEach(() => {
      server = docServer();
      setPeerTransportForTests(server.transport);
      platform = fakePlatform();
      cli.cliEnv.config = async () => fakeConfig();
    });
    afterEach(() => { cli.cliEnv.config = savedConfig; });

    async function run (fn, argv, ...rest) {
      const args = cli.parseArgs(argv);
      const lines = [];
      const log = console.log;
      const err = console.error;
      console.log = (...a) => { lines.push(a.join(' ')); };
      console.error = (...a) => { lines.push(a.join(' ')); };
      let error = null;
      try {
        await fn(platform, args, ...rest);
      } catch (e) {
        error = e;
      } finally {
        console.log = log;
        console.error = err;
      }
      return { out: lines.join('\n'), error };
    }

    it('[OCMD10A] check-metadata prints the derived client and writes nothing; refresh-metadata writes it', async () => {
      server.set(URL1, doc(URL1, { scope: 'x' }));
      const c = await run(cli.runCheckMetadata, ['check-metadata', URL1]);
      assert.equal(c.error, null, c.out);
      assert.match(c.out, /OK {3}document valid/);
      assert.match(c.out, /members ignored: scope/);
      assert.match(c.out, /"origin": "metadata-document"/);
      assert.equal(platform.kv.size, 0, 'nothing written');
      server.set(URL2, doc(URL2, { redirect_uris: ['http://app.example/cb'] }));
      const bad = await run(cli.runCheckMetadata, ['check-metadata', URL2]);
      assert.match(bad.error.message, /invalid: redirect_uris/);
      const r = await run(cli.runRefreshMetadata, ['refresh-metadata', URL1], getClient);
      assert.equal(r.error, null, r.out);
      assert.match(r.out, /OK {3}created: url~/);
      server.set(URL1, doc(URL1, { client_name: 'New name' }));
      const r2 = await run(cli.runRefreshMetadata, ['refresh-metadata', ids.metadataClientKey(URL1)], getClient);
      assert.match(r2.out, /refreshed: .*\n.*changed: clientName/);
    });

    it('[OCMD10B] list --origin, show, revoke (with the deny-list hint), suspend by URL; update and rotate-secret refuse such a client', async () => {
      server.set(URL1, doc());
      await run(cli.runRefreshMetadata, ['refresh-metadata', URL1], getClient);
      await persistClient(platform, {
        clientId: 'curated',
        kind: 'registry',
        redirectUris: ['https://app.example/cb'],
        grantTypes: ['authorization_code'],
        tokenEndpointAuthMethod: 'none',
        scope: ['read/a'],
        allowedAudiences: [AUD],
        subjectType: 'pairwise',
      });
      const all = await run((p, a) => cli.runList(p, getClient, a), ['list']);
      assert.match(all.out, /curated {2}registry/);
      assert.match(all.out, /url~[0-9a-f]{40} {2}registry {2}active {2}pairwise {2}metadata-document https:\/\/client\.example/);
      const only = await run((p, a) => cli.runList(p, getClient, a), ['list', '--origin', 'metadata-document', '--host', 'client.example']);
      assert.doesNotMatch(only.out, /curated/);
      const none = await run((p, a) => cli.runList(p, getClient, a), ['list', '--origin', 'metadata-document', '--host', 'tools.example']);
      assert.doesNotMatch(none.out, /url~/);
      const shown = await run((p, a) => cli.runShow(p, a, getClient, () => 'TP'), ['show', URL1]);
      assert.match(shown.out, /metadata document: https:\/\/client\.example\/oauth\/client\.json/);
      assert.match(shown.out, /host: {10}client\.example/);
      const susp = await run((p, a) => cli.runSetStatus(p, a, getClient, persistClient), ['suspend', URL1]);
      assert.equal(susp.error, null, susp.out);
      assert.equal((await getClient(platform, ids.metadataClientKey(URL1))).status, 'suspended');
      for (const [fn, cmd] of [[cli.runUpdate, 'update'], [cli.runRotateSecret, 'rotate-secret']]) {
        for (const id of [URL1, ids.metadataClientKey(URL1)]) {
          const r = await run((p, a) => fn(p, a, getClient, persistClient), [cmd, id]);
          assert.match(r.error.message, /metadata-document client/, cmd + ' ' + id);
        }
      }
      const revoked = await run((p, a) => cli.runRevoke(p, a, require('../src/clientRegistry.ts').removeClient), ['revoke', URL1, '--yes']);
      assert.equal(revoked.error, null, revoked.out);
      assert.match(revoked.out, /deniedHosts/);
      assert.equal(await getClient(platform, ids.metadataClientKey(URL1)), null);
    });

    it('[OCMD10C] template-from prints a block that validates and reproduces the registry client\'s reach', async () => {
      await persistClient(platform, {
        clientId: 'connector',
        kind: 'registry',
        redirectUris: ['https://app.example/cb'],
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethod: 'none',
        scope: ['read/a', 'write/b'],
        allowedAudiences: [AUD],
        subjectType: 'pairwise',
        launchTypes: ['agent'],
        maxEntries: 120,
        refreshTokenTTL: 3600,
        refreshTokenAbsoluteTTL: 7200,
        regions: ['eu'],
      });
      const r = await run((p, a) => cli.runTemplateFrom(p, a, getClient), ['template-from', 'connector']);
      assert.equal(r.error, null, r.out);
      const parsed = yaml.load(r.out.split('\nNOTE')[0]);
      const block2 = { mode: 'any', ...parsed.oauth.clientMetadataDocuments };
      assert.deepEqual(conf.describeClientMetadataConfig(block2).problems, []);
      const t = conf.clientMetadataSettings(fakeConfig(block2)).client;
      assert.deepEqual([t.scope, t.allowedAudiences, t.launchTypes, t.subjectType, t.maxEntries, t.offlineAccessAllowed],
        [['read/a', 'write/b'], [AUD], ['agent'], 'pairwise', 120, true]);
      assert.deepEqual([t.accessTokenTTL, t.refreshTokenTTL, t.refreshTokenAbsoluteTTL, t.regions], [null, 3600, 7200, ['eu']]);
      await persistClient(platform, {
        clientId: 'anyaud',
        kind: 'registry',
        redirectUris: ['https://app.example/cb'],
        grantTypes: ['authorization_code'],
        tokenEndpointAuthMethod: 'none',
        scope: ['read/a'],
        anyAudience: true,
        allowedAudiences: [],
        subjectType: 'public',
      });
      const refused = await run((p, a) => cli.runTemplateFrom(p, a, getClient), ['template-from', 'anyaud']);
      assert.match(refused.error.message, /no audience list/);
    });
  });

  describe('[OCMD11] confidential documents (private_key_jwt)', () => {
    const s = settingsOf();
    const check = (d, settings = s) => meta.clientMetadataProblem(d, URL1, settings);
    const pkj = (extra = {}) => doc(URL1, { token_endpoint_auth_method: 'private_key_jwt', ...extra });
    let rsa, ec;
    before(() => {
      rsa = makeKey('RS256', 'rsa-1');
      ec = makeKey('ES256', 'ec-1');
    });

    it('[OCMD11A] the key set: jwks_uri on the document\'s host, or an inline jwks; jwks_uri wins over jwks', () => {
      const byUri = check(pkj({ jwks_uri: 'https://client.example/jwks.json' }));
      assert.equal(byUri.ok, true, byUri.detail);
      assert.deepEqual([byUri.fields.tokenEndpointAuthMethod, byUri.fields.jwksUri, byUri.fields.jwks], ['private_key_jwt', 'https://client.example/jwks.json', undefined]);
      for (const [uri, re] of [['https://keys.example/jwks.json', /host of the metadata document/], ['https://core-a.pryv.example/jwks', /host of the metadata document/],
        ['https://client.example:8443/jwks', /host of the metadata document/], ['http://client.example/jwks', /https/], ['https://client.example/j#k', /fragment/]]) {
        const r = check(pkj({ jwks_uri: uri }));
        assert.equal(r.ok, false, uri);
        assert.match(r.detail, re, uri);
      }
      const inline = check(pkj({ jwks: { keys: [rsa.publicJwk] } }));
      assert.equal(inline.ok, true, inline.detail);
      assert.deepEqual(inline.fields.jwks.keys.map((k) => k.kid), ['rsa-1']);
      assert.equal(check(pkj({ jwks: { keys: [{ ...rsa.rawPublic, d: 'secret' }] } })).ok, false, 'private material refused');
      const both = check(pkj({ jwks_uri: 'https://client.example/jwks.json', jwks: { keys: [rsa.publicJwk] } }));
      assert.equal(both.fields.jwksUri, 'https://client.example/jwks.json');
      assert.equal(both.fields.jwks, undefined);
      assert.ok(both.ignored.includes('jwks'));
      assert.match(check(pkj()).detail, /needs a jwks_uri or a jwks/);
    });

    it('[OCMD11B] the signing algorithm pins the row; the plural methods member is ignored; authMethods may refuse confidential documents', () => {
      const pinned = check(pkj({ jwks: { keys: [rsa.publicJwk] }, token_endpoint_auth_signing_alg: 'RS256' }));
      assert.deepEqual(pinned.fields.tokenEndpointAuthSigningAlgs, ['RS256']);
      assert.match(check(pkj({ jwks: { keys: [rsa.publicJwk] }, token_endpoint_auth_signing_alg: 'PS256' })).detail, /token_endpoint_auth_signing_alg/);
      assert.match(check(pkj({ jwks: { keys: [ec.publicJwk] }, token_endpoint_auth_signing_alg: 'RS256' })).detail, /no key of the jwks fits/);
      const plural = ['none', 'private_key_jwt'];
      const pub = check(doc(URL1, { token_endpoint_auth_method: 'none', token_endpoint_auth_methods_supported: plural, jwks_uri: 'https://client.example/jwks.json' }));
      assert.equal(pub.fields.tokenEndpointAuthMethod, 'none');
      assert.equal(pub.fields.jwksUri, undefined, 'a public document\'s key members are not read');
      assert.ok(pub.ignored.includes('token_endpoint_auth_methods_supported') && pub.ignored.includes('jwks_uri'));
      const conf2 = check(pkj({ token_endpoint_auth_methods_supported: plural, jwks_uri: 'https://client.example/jwks.json' }));
      assert.equal(conf2.fields.tokenEndpointAuthMethod, 'private_key_jwt');
      const publicOnly = settingsOf(block({ authMethods: ['none'] }));
      assert.match(check(pkj({ jwks_uri: 'https://client.example/jwks.json' }), publicOnly).detail, /unsupported-auth-method/);
      assert.equal(check(doc(), publicOnly).ok, true);
    });

    it('[OCMD11C] the row authenticates by its URL (iss = sub), burns the jti under its key, and still holds no role', async () => {
      const checked = check(pkj({ jwks: { keys: [rsa.publicJwk] } }));
      const row = meta.buildMetadataClientRow(URL1, checked.fields, s, null, Date.now());
      const platform = fakePlatform();
      await persistClient(platform, row);
      const stored = await getClient(platform, row.clientId);
      assert.equal(isConfidentialClient(stored), true);
      for (const [k, v] of [['canExchange', true], ['canIntrospect', true]]) {
        await assert.rejects(persistClient(platform, { ...row, [k]: v }), new RegExp('not available to such a client: ' + k), k);
      }
      await assert.rejects(persistClient(platform, { ...row, jwks: undefined, jwksUri: 'https://keys.example/jwks.json' }), /host of its metadata document/);
      const authAs = (token) => authenticateClient({
        client: stored, clientId: row.clientId, assertion: token, assertionType: CLIENT_ASSERTION_TYPE, platform, expectedAudiences: [ISSUER, ISSUER + '/oauth2/token'],
      });
      const good = signedAssertion(rsa, URL1);
      assert.equal((await authAs(good)).ok, true);
      assert.equal((await authAs(good)).ok, false, 'replayed');
      assert.ok([...platform.state.keys()].some((k) => k.includes('/' + row.clientId + '/')), 'jti burnt under the row key');
      assert.equal((await authAs(signedAssertion(rsa, row.clientId))).ok, false, 'iss = the row key');
      assert.equal((await authAs(signedAssertion(rsa, URL2))).ok, false, 'another URL');
      assert.equal((await authenticateClient({ client: stored, clientId: row.clientId, platform })).ok, false, 'no assertion: refused');
    });
  });

  it('[OCMD12] RS256: accepted for RSA keys only, advertised; an EC key never verifies it, nor an RSA key an ES256 header', async () => {
    assert.ok(jwks.CLIENT_ASSERTION_ALGS.includes('RS256'));
    assert.ok(buildDiscoveryDocument({ issuer: 'https://x', scopesSupported: [] }).token_endpoint_auth_signing_alg_values_supported.includes('RS256'));
    const rsa = makeKey('RS256', 'rsa-1');
    const ec = makeKey('ES256', 'ec-1');
    assert.equal(jwks.keyMatchesAlg(rsa.publicJwk, 'RS256'), true);
    assert.equal(jwks.keyMatchesAlg(rsa.publicJwk, 'RS384'), true);
    assert.equal(jwks.keyMatchesAlg({ ...rsa.publicJwk, alg: 'RS384' }, 'RS256'), false, 'a key pinned to RS384');
    assert.equal(jwks.keyMatchesAlg(ec.publicJwk, 'RS256'), false);
    assert.equal(jwks.keyMatchesAlg(rsa.publicJwk, 'ES256'), false);
    const opts = (keys) => ({ clientId: URL1, jwks: { keys }, expectedAudiences: [ISSUER, ISSUER + '/oauth2/token'] });
    assert.ok((await verifyClientAssertion(signedAssertion(rsa, URL1), opts([rsa.publicJwk]))).jti);
    // An RS256 header naming the EC key, and an ES256 header naming the RSA key.
    await assert.rejects(verifyClientAssertion(signedAssertion(ec, URL1, { alg: 'RS256' }), opts([ec.publicJwk])));
    await assert.rejects(verifyClientAssertion(signedAssertion(rsa, URL1, { alg: 'ES256' }), opts([rsa.publicJwk])));
    // An RS384 signature under an RS256 header does not verify.
    await assert.rejects(verifyClientAssertion(signedAssertion(rsa, URL1, { alg: 'RS256', signAs: 'RS384' }), opts([rsa.publicJwk])));
  });

  it('[OCMD13] the access stamp: name (first language of a set), host, url; none for a curated client', () => {
    const key = ids.metadataClientKey(URL1);
    assert.deepEqual(ids.metadataClientStamp({ origin: 'metadata-document', metadataUrl: URL1, clientName: 'Agent' }),
      { name: 'Agent', host: 'client.example', url: URL1 });
    assert.deepEqual(ids.metadataClientStamp({ origin: 'metadata-document', metadataUrl: URL1, name: { fr: 'Agent FR', de: 'Agent DE' } }),
      { name: 'Agent FR', host: 'client.example', url: URL1 });
    assert.deepEqual(ids.metadataClientStamp({ origin: 'metadata-document', metadataUrl: 'https://xn--bcher-kva.example/c.json' }),
      { host: 'xn--bcher-kva.example', url: 'https://xn--bcher-kva.example/c.json' });
    assert.equal(ids.metadataClientStamp({ clientId: 'curated', clientName: 'Curated' }), null);
    assert.equal(ids.isMetadataClientKey(key), true);
    assert.deepEqual(meta.metadataHostOf('https://xn--bcher-kva.example/c.json'),
      { metadataHost: 'xn--bcher-kva.example', metadataHostUnicode: 'bücher.example' });
  });
});
