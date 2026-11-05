/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [OCMDE] client metadata documents end to end: a client names itself by the
 * https URL of a document a stub host serves (an in-process HTTP server, the
 * counterparty transport pointing the document hosts at it); the core fetches
 * the document at /oauth2/authorize, serves the client as a registry client
 * with the reach of the operator's template, and every path runs with the URL
 * as the client's id on the wire.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import * as oauth2 from 'oauth2';
import * as storage from 'oauth2/src/storage.ts';
import { mintSecret } from 'oauth2/src/clientSecret.ts';
import { metadataClientKey } from 'oauth2/src/clientMetadataId.ts';
import { _resetClientMetadataForTests } from 'oauth2/src/clientMetadata.ts';
import { resetJwksCacheForTests } from 'oauth2/src/jwksUri.ts';
import { setPeerTransportForTests, getPeerTransportForTests } from 'business/src/outbound/peerFetch.ts';
import * as storages from 'storages';
import { injectTestConfigSnapshot, withInjectedConfig } from 'test-helpers';
import { getConfigUnsafe } from '@pryv/boiler';
import auditModule from 'audit';
import { purgeClientGrants } from '../src/methods/helpers/oauthGrantPurge.ts';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cli = require('../../../bin/oauth-client.js');

const REDIRECT_URI = 'https://client.example/cb';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const STATE_KEY = 'test-oauth-state-key-' + 'm3Ta0dOc5x'.repeat(2);
const RS_AUD = 'https://rs.example.test/adapter';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const STUB_HOSTS = ['client.example', 'tools.example', 'agent.anywhere.example'];
const TEMPLATE = { scope: 'read/a read/b write/a', allowedAudiences: [RS_AUD], subjectType: 'pairwise', maxEntries: 20 };
const CMD = { mode: 'allowList', allowedHosts: ['client.example', 'tools.example'], deniedHosts: [], client: TEMPLATE };
const OAUTH = { consentUrl: CONSENT_URL, stateKey: STATE_KEY, clientMetadataDocuments: CMD };

// Toy grammar: `read/<s>`, `write/<s>` give one stream a level.
const LEVEL_OF = { read: 'read', write: 'contribute' };
const toyExtension = {
  apiVersion: 1,
  name: 'toy-metadata',
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
      const has = (s, levels) => permissions.some((p) => p.streamId === s && levels.includes(p.level));
      return requestedTokens.filter((t) => {
        const [kind, s] = t.split('/');
        return kind === 'read' ? has(s, ['read', 'contribute']) : has(s, ['contribute']);
      });
    },
  },
};

const CLIENT_ASSERTION_TYPE_URN = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** A signing key for `alg` (RS256: RSA 2048, ES256: P-256) and its public JWK. */
function signingKey (alg, kid) {
  const { privateKey, publicKey } = alg === 'RS256'
    ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const jwk = pub.kty === 'RSA' ? { kty: 'RSA', n: pub.n, e: pub.e } : { kty: 'EC', crv: pub.crv, x: pub.x, y: pub.y };
  return { alg, kid, privateKey, publicJwk: { ...jwk, kid } };
}

/** A fresh client assertion (iss = sub = `clientId`, a new jti) for `aud`. */
function clientAssertion (key, clientId, aud) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = enc({ alg: key.alg, typ: 'JWT', kid: key.kid }) + '.' +
    enc({ iss: clientId, sub: clientId, aud, jti: 'j-' + crypto.randomUUID(), exp: now + 120, iat: now });
  const sig = key.alg === 'RS256'
    ? crypto.sign('sha256', Buffer.from(input), key.privateKey)
    : crypto.sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return input + '.' + sig.toString('base64url');
}

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

describe('[OCMDE] client metadata documents end to end', function () {
  this.timeout(90000);

  let fixtures, restoreConfig, platformDB, stub, stubOrigin, savedTransport, rsId, rsSecret;
  const docs = new Map(); // '/<host><path>' -> { status, headers, body }
  const hits = new Map();
  const clientIds = [];
  let seq = 0;

  /** A fresh document URL on `host`, serving `doc` (a function of the URL, or extra members). */
  function publish (extra = {}, host = 'client.example') {
    const url = `https://${host}/apps/${cuid().slice(-8)}-${++seq}.json`;
    serve(url, { client_id: url, client_name: 'Example agent', redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'], ...extra });
    clientIds.push(metadataClientKey(url));
    return url;
  }

  function serve (url, body, { status = 200, headers = { 'content-type': 'application/json' } } = {}) {
    const u = new URL(url);
    docs.set('/' + u.host + u.pathname + u.search, { status, headers, body });
  }

  const hitsOf = (url) => { const u = new URL(url); return hits.get('/' + u.host + u.pathname + u.search) ?? 0; };

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = injectTestConfigSnapshot({ oauth: OAUTH });
    oauth2.extension.setExtension(toyExtension);
    platformDB = storages.platformDB;
    stub = http.createServer((req, res) => {
      hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
      const d = docs.get(req.url);
      if (d == null) { res.statusCode = 404; return res.end('not found'); }
      res.writeHead(d.status, d.headers);
      res.end(typeof d.body === 'string' ? d.body : JSON.stringify(d.body));
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubOrigin = 'http://127.0.0.1:' + stub.address().port;
    savedTransport = getPeerTransportForTests();
    setPeerTransportForTests(async (rawUrl, init) => {
      const u = new URL(rawUrl);
      if (STUB_HOSTS.includes(u.hostname)) return await fetch(stubOrigin + '/' + u.host + u.pathname + u.search, init);
      return await (savedTransport ?? fetch)(rawUrl, init);
    });
    rsSecret = await mintSecret();
    rsId = 'MetaRs.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, {
      clientId: rsId,
      kind: 'registry',
      redirectUris: ['https://rs.example.test/cb'],
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'client_secret_basic',
      clientSecretHash: rsSecret.hash,
      allowedAudiences: [RS_AUD],
      subjectType: 'public',
      scope: ['read/a'],
      canExchange: true,
      canIntrospect: true,
    });
    clientIds.push(rsId);
  });

  beforeEach(() => { _resetClientMetadataForTests(); });
  afterEach(() => { storage._setRevokeClockMarginForTests(null); });

  after(async function () {
    setPeerTransportForTests(savedTransport);
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of clientIds) {
      try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
    }
    if (stub != null) await new Promise((resolve) => stub.close(resolve));
    if (fixtures != null) await fixtures.clean();
  });

  async function newUser () {
    const username = cuid();
    const token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    for (const id of ['a', 'b']) {
      const s = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id, name: id });
      assert.equal(s.status, 201, JSON.stringify(s.body));
    }
    return { username, token, userId: user.attrs.id };
  }

  function authorize (clientId, { redirectUri = REDIRECT_URI, scope = 'offline_access write/a read/b', resource = RS_AUD, challenge } = {}) {
    return coreRequest.get('/oauth2/authorize').query({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge ?? pkce().challenge,
      code_challenge_method: 'S256',
      scope,
      ...(resource != null ? { resource } : {}),
    });
  }

  async function consent (who, state) {
    const o = await coreRequest.post('/oauth2/authorize/offer').send({ state, username: who.username, userToken: who.token });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const granted = o.body.offer.permissions.map(({ currentlyGranted: _c, currentLevel: _l, ...p }) => p);
    const a = await coreRequest.post('/oauth2/authorize/accept')
      .send({ state, username: who.username, userToken: who.token, grantedPermissions: granted, shownDigest: o.body.shownDigest });
    return { offer: o.body, accept: a };
  }

  /** Authorization, consent and code exchange; the token response, the offer answer. */
  async function connect (who, url, opts = {}) {
    const { verifier, challenge } = pkce();
    const res = await authorize(url, { ...opts, challenge });
    assert.equal(res.status, 302, res.text);
    const state = new URL(res.headers.location).searchParams.get('state');
    const { offer, accept } = await consent(who, state);
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    const code = new URL(accept.body.redirectTo).searchParams.get('code');
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: url,
      redirect_uri: opts.redirectUri ?? REDIRECT_URI,
      resource: RS_AUD,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    return { token: t.body, offer };
  }

  /** Authorization and consent: the code and its PKCE verifier. */
  async function codeFor (who, url) {
    const { verifier, challenge } = pkce();
    const res = await authorize(url, { challenge });
    assert.equal(res.status, 302, res.text);
    const { accept } = await consent(who, new URL(res.headers.location).searchParams.get('state'));
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    return { code: new URL(accept.body.redirectTo).searchParams.get('code'), verifier };
  }

  async function accesses (who, query = {}) {
    const res = await coreRequest.get('/' + who.username + '/accesses').query(query).set('Authorization', who.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accesses;
  }

  async function rowOf (who, token) {
    return (await accesses(who)).find((a) => a.token === token) ?? null;
  }

  function readStream (token, streamId, name) {
    return coreRequest.get('/' + name + '/events').query({ streams: JSON.stringify([streamId]) }).set('Authorization', token);
  }

  function basic (id, secret) {
    return 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');
  }

  function exchange (subjectToken, auth = basic(rsId, rsSecret.plaintext), body = {}) {
    return coreRequest.post('/oauth2/token').type('form').set('Authorization', auth)
      .send({ grant_type: TOKEN_EXCHANGE, subject_token: subjectToken, subject_token_type: ACCESS_TOKEN_TYPE, ...body });
  }

  function introspect (token) {
    return coreRequest.post('/oauth2/introspect').type('form').set('Authorization', basic(rsId, rsSecret.plaintext)).send({ token });
  }

  function refresh (refreshToken, clientId) {
    return coreRequest.post('/oauth2/token').type('form').send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  }

  async function rowFor (url) {
    return await storage.getClient(platformDB, metadataClientKey(url));
  }

  /** Move a row's cache state in time (ms before now). */
  async function ageRow (url, { fetchedAgo, expiredAgo }) {
    const row = await rowFor(url);
    await storage.setClient(platformDB, {
      ...row,
      metadata: { ...row.metadata, fetchedAt: Date.now() - fetchedAgo, expiresAt: Date.now() - expiredAgo },
    });
  }

  async function auditRows (body) {
    const original = auditModule.eventForUser;
    const rows = [];
    auditModule.eventForUser = async function (userId, row, event) {
      if (String(event).startsWith('oauth.')) rows.push({ event, record: row.content.record });
      return await original.apply(this, arguments);
    };
    try {
      await body();
    } finally {
      auditModule.eventForUser = original;
    }
    return rows;
  }

  async function eventually (probe, status, ms = 6000) {
    const deadline = Date.now() + ms;
    let last;
    while (Date.now() < deadline) {
      last = (await probe()).status;
      if (last === status) return last;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return last;
  }

  it('[OCMDE01] the full flow: discovery flag, /authorize fetches the document, the consent shows its host, the code exchange by the URL', async () => {
    const disc = await coreRequest.get('/.well-known/oauth-authorization-server');
    assert.equal(disc.body.client_id_metadata_document_supported, true);
    assert.ok(disc.body.token_endpoint_auth_methods_supported.includes('none'));
    assert.equal(disc.body.authorization_response_iss_parameter_supported, true);
    const url = publish({ logo_uri: 'https://cdn.example/logo.png', client_uri: 'https://client.example/about' });
    const who = await newUser();
    const { token, offer } = await connect(who, url);
    assert.equal(hitsOf(url), 1);
    assert.deepEqual(
      { origin: offer.client.origin, metadataUrl: offer.client.metadataUrl, metadataHost: offer.client.metadataHost, name: offer.client.clientName },
      { origin: 'metadata-document', metadataUrl: url, metadataHost: 'client.example', name: 'Example agent' });
    assert.equal(offer.client.clientId, metadataClientKey(url));
    assert.equal(offer.client.logoUri, undefined, 'no logo: not on the document\'s host');
    assert.equal(offer.client.clientUri, 'https://client.example/about');
    assert.equal(token.token_type, 'Bearer');
    assert.deepEqual(token.scope.split(' ').sort(), ['offline_access', 'read/b', 'write/a']);
    assert.ok(typeof token.refresh_token === 'string' && token.refresh_token.length > 0);
    assert.equal(token.client_id, undefined);
    const grant = (await accesses(who)).find((a) => a.name === 'oauth-grant:' + metadataClientKey(url));
    assert.match(grant.alias, /^r-/, 'pairwise: the grant is aliased');
    const session = await rowOf(who, token.access_token);
    assert.equal(session.name, 'oauth:' + metadataClientKey(url));
    assert.equal(session.alias, grant.alias);
    assert.equal(session.clientData.oauth.audience, RS_AUD);
    assert.equal((await readStream(token.access_token, 'a', grant.alias)).status, 200);
  });

  it('[OCMDE02] refresh rotation and revocation (RFC 7009) by the URL', async () => {
    const url = publish();
    const who = await newUser();
    const { token } = await connect(who, url);
    const r = await refresh(token.refresh_token, url);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(r.body.refresh_token, token.refresh_token);
    const bad = await refresh(token.refresh_token + 'x', url);
    assert.deepEqual([bad.status, bad.body.error], [400, 'invalid_grant']);
    const revoked = await coreRequest.post('/oauth2/revoke').type('form').send({ token: r.body.refresh_token, token_type_hint: 'refresh_token', client_id: url });
    assert.equal(revoked.status, 200);
    assert.equal((await refresh(r.body.refresh_token, url)).body.error, 'invalid_grant');
  });

  it('[OCMDE03] introspection answers the URL as client_id; a resource server exchanges the token; the client itself can never exchange', async () => {
    const url = publish();
    const who = await newUser();
    const { token } = await connect(who, url);
    const info = await introspect(token.access_token);
    assert.deepEqual([info.status, info.body.active, info.body.client_id], [200, true, url]);
    const x = await exchange(token.access_token);
    assert.equal(x.status, 200, JSON.stringify(x.body));
    const derivedInfo = await introspect(x.body.access_token);
    assert.equal(derivedInfo.body.client_id, url);
    assert.deepEqual(derivedInfo.body.act, { client_id: rsId });
    // The client: by Basic with its URL and a forged secret, by the body.
    assert.deepEqual([(await exchange(token.access_token, basic(url, 'forged'))).body.error], ['invalid_client']);
    const asBody = await coreRequest.post('/oauth2/token').type('form')
      .send({ grant_type: TOKEN_EXCHANGE, subject_token: token.access_token, subject_token_type: ACCESS_TOKEN_TYPE, client_id: url, client_secret: 'forged' });
    assert.deepEqual([asBody.status, asBody.body.error], [401, 'invalid_client']);
    // Nor introspect.
    const asIntro = await coreRequest.post('/oauth2/introspect').type('form').send({ token: token.access_token, client_id: url });
    assert.equal(asIntro.status, 401);
  });

  it('[OCMDE04] audienceBoundSessions: the client\'s token is refused at the data API, the derived one works', async () => {
    const url = publish();
    const who = await newUser();
    const { token } = await connect(who, url);
    const x = await exchange(token.access_token);
    assert.equal(x.status, 200, JSON.stringify(x.body));
    const grant = (await accesses(who)).find((a) => a.name === 'oauth-grant:' + metadataClientKey(url));
    await withInjectedConfig({ oauth: { ...OAUTH, audienceBoundSessions: true } }, async () => {
      assert.equal((await readStream(token.access_token, 'a', grant.alias)).status, 403);
      assert.equal((await readStream(x.body.access_token, 'a', grant.alias)).status, 200);
    });
  });

  it('[OCMDE05] loopback redirect URIs: any port on the listed host string; plain http elsewhere makes the document invalid', async () => {
    const url = publish({ redirect_uris: ['http://localhost/callback'] });
    const ok = await authorize(url, { redirectUri: 'http://localhost:51234/callback' });
    assert.equal(ok.status, 302, ok.text);
    assert.match(ok.headers.location, /^https:\/\/auth\.test\//);
    const other = await authorize(url, { redirectUri: 'http://127.0.0.1:51234/callback' });
    assert.equal(other.status, 400);
    const insecure = publish({ redirect_uris: ['http://app.example/cb'] });
    const refused = await authorize(insecure, { redirectUri: 'http://app.example/cb' });
    assert.equal(refused.status, 400);
    assert.match(refused.text, /client metadata document invalid/);
    assert.equal(await rowFor(insecure), null);
  });

  it('[OCMDE06] host policy: outside the allow-list refused before any fetch; the deny-list wins; off: unknown client', async () => {
    const outside = publish({}, 'agent.anywhere.example');
    const r = await authorize(outside);
    assert.equal(r.status, 400);
    assert.match(r.text, /not accepted here/);
    assert.equal(hitsOf(outside), 0, 'no fetch');
    const url = publish();
    await withInjectedConfig({ oauth: { ...OAUTH, clientMetadataDocuments: { ...CMD, deniedHosts: ['client.example'] } } }, async () => {
      const denied = await authorize(url);
      assert.equal(denied.status, 400);
      assert.equal(hitsOf(url), 0);
    });
    await withInjectedConfig({ oauth: { ...OAUTH, clientMetadataDocuments: { mode: 'off' } } }, async () => {
      const off = await authorize(url);
      assert.equal(off.status, 400);
      assert.match(off.text, /Unknown client_id/);
      assert.equal(hitsOf(url), 0);
      const disc = await coreRequest.get('/.well-known/oauth-authorization-server');
      assert.equal(disc.body.client_id_metadata_document_supported, undefined);
    });
    // URL rules: the reason is shown (HTML, no redirect).
    const bad = await authorize('https://Client.example/apps/x.json');
    assert.equal(bad.status, 400);
    assert.match(bad.text, /normal form/);
    const plain = await authorize('http://client.example/apps/x.json');
    assert.match(plain.text, /https URL/);
    // The stored key is no client_id: an existing row of a denied host, or
    // with the feature off, is not reached through it.
    const known = publish();
    assert.equal((await authorize(known)).status, 302);
    const byKey = await authorize(metadataClientKey(known));
    assert.equal(byKey.status, 400);
    assert.match(byKey.text, /Unknown client_id/);
    await withInjectedConfig({ oauth: { ...OAUTH, clientMetadataDocuments: { ...CMD, deniedHosts: ['client.example'] } } }, async () => {
      assert.equal((await authorize(metadataClientKey(known))).status, 400);
    });
  });

  it('[OCMDE07] a document changed between consents: the new name is shown, a new redirect URI works at the next authorization, an old code exchanges against its own', async () => {
    const url = publish();
    const who = await newUser();
    const { verifier, challenge } = pkce();
    const first = await authorize(url, { challenge });
    const state = new URL(first.headers.location).searchParams.get('state');
    const { accept } = await consent(who, state);
    const code = new URL(accept.body.redirectTo).searchParams.get('code');
    serve(url, { client_id: url, client_name: 'Renamed agent', redirect_uris: [REDIRECT_URI, 'https://client.example/cb2'], grant_types: ['authorization_code', 'refresh_token'] });
    await ageRow(url, { fetchedAgo: 1000, expiredAgo: 1 });
    const second = await authorize(url, { redirectUri: 'https://client.example/cb2' });
    assert.equal(second.status, 302, second.text);
    const o = await coreRequest.post('/oauth2/authorize/offer').send({ state: new URL(second.headers.location).searchParams.get('state') });
    assert.equal(o.body.client.clientName, 'Renamed agent');
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: url, redirect_uri: REDIRECT_URI, resource: RS_AUD,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
  });

  it('[OCMDE08] operator revoke: sessions refused, refresh ends; a new authorization creates the client again', async () => {
    // A flow right after the revoke is inside its clock margin: tested without it here.
    storage._setRevokeClockMarginForTests(0);
    const url = publish();
    const who = await newUser();
    const { token } = await connect(who, url);
    const grant = (await accesses(who)).find((a) => a.name === 'oauth-grant:' + metadataClientKey(url));
    await withInjectedConfig({ oauth: { ...OAUTH, clientRevokeCheckSeconds: 1 } }, async () => {
      const r = await (async () => {
        const args = cli.parseArgs(['revoke', url, '--yes']);
        const log = console.log;
        console.log = () => {};
        try { await cli.runRevoke(platformDB, args, oauth2.removeClient); } finally { console.log = log; }
      })();
      assert.equal(r, undefined);
      assert.equal(await rowFor(url), null);
      assert.equal(await eventually(() => readStream(token.access_token, 'a', grant.alias), 403), 403);
      const rf = await refresh(token.refresh_token, url);
      assert.notEqual(rf.status, 200);
    });
    const again = await connect(who, url);
    assert.equal((await readStream(again.token.access_token, 'a', (await accesses(who)).find((a) => a.name === 'oauth-grant:' + metadataClientKey(url)).alias)).status, 200);
    // The row is back: the refresh token issued before the revoke is still void.
    const old = await refresh(token.refresh_token, url);
    assert.deepEqual([old.status, old.body.error], [400, 'invalid_grant']);
    assert.equal((await refresh(again.token.refresh_token, url)).status, 200, 'the new chain works');
  });

  it('[OCMDE08B] revoke epoch: a code issued before the revoke is void after the row is re-created; the old grant is not reused; the five-second clock margin', async () => {
    storage._setRevokeClockMarginForTests(0);
    const url = publish();
    const who = await newUser();
    const before = await connect(who, url);
    const oldGrant = (await accesses(who)).find((a) => a.name === 'oauth-grant:' + metadataClientKey(url));
    const sessionIds = async () => (await accesses(who)).filter((a) => a.name === 'oauth:' + metadataClientKey(url)).map((a) => a.id);
    const idsBefore = await sessionIds();
    const pending = await codeFor(who, url);
    const pendingAccess = (await sessionIds()).filter((id) => !idsBefore.includes(id));
    assert.equal(pendingAccess.length, 1, 'the access minted at /accept for the pending code');
    const log = console.log;
    console.log = () => {};
    try { await cli.runRevoke(platformDB, cli.parseArgs(['revoke', url, '--yes']), oauth2.removeClient); } finally { console.log = log; }
    assert.equal((await authorize(url)).status, 302, 'the row is created again');
    // No consent in between: only the refresh grant's epoch check refuses the old token here.
    const oldRefresh = await refresh(before.token.refresh_token, url);
    assert.deepEqual([oldRefresh.status, oldRefresh.body.error], [400, 'invalid_grant']);
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code: pending.code, code_verifier: pending.verifier, client_id: url, redirect_uri: REDIRECT_URI, resource: RS_AUD,
    });
    assert.deepEqual([t.status, t.body.error], [400, 'invalid_grant']);
    assert.ok(!(await sessionIds()).includes(pendingAccess[0]), 'its accept-time access is gone');
    const intro = await introspect(before.token.access_token);
    assert.equal(intro.body.active, false, 'a pre-revoke session is inactive');
    await withInjectedConfig({ oauth: { ...OAUTH, clientRevokeCheckSeconds: 1 } }, async () => {
      assert.equal(await eventually(() => readStream(before.token.access_token, 'a', oldGrant.alias), 403), 403, 'a pre-revoke session is 403 after the re-creation');
    });
    // A new flow: a full consent (nothing kept from the old grant), a new grant, end to end.
    const { verifier, challenge } = pkce();
    const res = await authorize(url, { challenge });
    const { offer, accept } = await consent(who, new URL(res.headers.location).searchParams.get('state'));
    assert.ok(offer.offer.permissions.every((p) => p.currentlyGranted !== true), 'no entry kept from the pre-revoke grant');
    const code = new URL(accept.body.redirectTo).searchParams.get('code');
    const fresh = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: url, redirect_uri: REDIRECT_URI, resource: RS_AUD,
    });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    const newGrant = (await accesses(who)).find((a) => a.name === 'oauth-grant:' + metadataClientKey(url));
    assert.notEqual(newGrant.id, oldGrant.id);
    // A curated client revoked, then registered again under the same id: its old refresh token is void too.
    const curatedId = 'MetaCur.' + cuid().slice(-10);
    const curated = {
      clientId: curatedId,
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      allowedAudiences: [RS_AUD],
      subjectType: 'pairwise',
      scope: ['read/a', 'read/b', 'write/a'],
    };
    await oauth2.persistClient(platformDB, curated);
    clientIds.push(curatedId);
    const c1 = await connect(who, curatedId);
    await storage.deleteClient(platformDB, curatedId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await oauth2.persistClient(platformDB, curated);
    const oldCurated = await refresh(c1.token.refresh_token, curatedId);
    assert.deepEqual([oldCurated.status, oldCurated.body.error], [400, 'invalid_grant']);

    // The clock margin (the cases above ran without it: a flow right after a
    // revoke is inside it): an artefact issued up to five seconds after the
    // epoch is void too. The epoch is written by hand, relative to each artefact.
    storage._setRevokeClockMarginForTests(null);
    const url2 = publish();
    const tombstone = 'oauth-client-revoked/' + metadataClientKey(url2);
    const epochAt = (ms) => platformDB.setPlatformKv(tombstone, JSON.stringify({ revokedAt: ms }));
    const coreId = String(getConfigUnsafe(true).get('core:id') ?? 'single');
    const a = await connect(who, url2);
    const b = await connect(who, url2);
    const issuedOf = async (t) => (await storage.getRefresh(platformDB, coreId, t.refresh_token)).issuedAt;
    await epochAt((await issuedOf(a.token)) - 3000);
    const ra = await refresh(a.token.refresh_token, url2);
    assert.deepEqual([ra.status, ra.body.error], [400, 'invalid_grant'], 'issued 3 s after the epoch: void');
    await epochAt((await issuedOf(b.token)) - 6000);
    assert.equal((await refresh(b.token.refresh_token, url2)).status, 200, 'issued 6 s after the epoch: honoured');
    const created = (await rowOf(who, a.token.access_token)).created;
    await epochAt(created * 1000 - 3000);
    assert.equal((await introspect(a.token.access_token)).body.active, false, 'a session made 3 s after the epoch');
    await epochAt(created * 1000 - 6000);
    assert.equal((await introspect(a.token.access_token)).body.active, true, 'a session made 6 s after the epoch');
    await platformDB.deletePlatformKv(tombstone);
    assert.equal((await refresh(a.token.refresh_token, url2)).body.error, 'invalid_grant', 'the refused token was ended');
  });

  it('[OCMDE09] the document host down: a fresh row serves; a stale row within the grace serves; past it the client is refused, the row kept', async () => {
    const url = publish();
    assert.equal((await authorize(url)).status, 302);
    serve(url, 'down', { status: 503, headers: { 'content-type': 'text/plain' } });
    assert.equal((await authorize(url)).status, 302, 'fresh');
    assert.equal(hitsOf(url), 1);
    await ageRow(url, { fetchedAgo: 3600 * 1000 + 1000, expiredAgo: 1000 });
    assert.equal((await authorize(url)).status, 302, 'stale, within the grace');
    assert.equal(hitsOf(url), 2);
    _resetClientMetadataForTests();
    await ageRow(url, { fetchedAgo: 86400 * 1000 + 1000, expiredAgo: 1000 });
    const past = await authorize(url);
    assert.equal(past.status, 400);
    assert.match(past.text, /client metadata document unavailable/);
    assert.notEqual(await rowFor(url), null);
  });

  it('[OCMDE11] a content-identical refetch between /authorize and /accept keeps the consent valid', async () => {
    const url = publish();
    const who = await newUser();
    const res = await authorize(url);
    const before = await rowFor(url);
    await ageRow(url, { fetchedAgo: 1000, expiredAgo: 1 });
    assert.equal((await authorize(url)).status, 302);
    const afterRow = await rowFor(url);
    assert.equal(hitsOf(url), 2, 'fetched again');
    assert.equal(afterRow.updatedAt, before.updatedAt);
    const { accept } = await consent(who, new URL(res.headers.location).searchParams.get('state'));
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
  });

  it('[OCMDE12] purge-grants by the URL removes the grant and its sessions', async () => {
    const url = publish();
    const who = await newUser();
    const { token } = await connect(who, url);
    const log = console.log;
    console.log = () => {};
    try {
      await cli.runPurgeGrants(platformDB, cli.parseArgs(['purge-grants', url, '--yes']), purgeClientGrants);
    } finally {
      console.log = log;
    }
    const left = (await accesses(who)).filter((a) => a.name === 'oauth-grant:' + metadataClientKey(url) || a.token === token.access_token);
    assert.deepEqual(left, []);
  });

  it('[OCMDE13] audit: metadata_fetched (created, unchanged), metadata_refused, consent.shown with the host; never the document body', async () => {
    const url = publish({ client_name: 'Audited agent' });
    const outside = publish({}, 'agent.anywhere.example');
    const rows = await auditRows(async () => {
      await authorize(url);
      await ageRow(url, { fetchedAgo: 1000, expiredAgo: 1 });
      await authorize(url);
      await authorize(outside);
    });
    const fetched = rows.filter((r) => r.event === 'oauth.client.metadata_fetched').map((r) => r.record);
    assert.deepEqual(fetched.map((r) => [r.metadataUrl, r.host, r.outcome]), [[url, 'client.example', 'created'], [url, 'client.example', 'unchanged']]);
    assert.equal(fetched[0].clientId, metadataClientKey(url));
    const refused = rows.filter((r) => r.event === 'oauth.client.metadata_refused').map((r) => r.record);
    assert.deepEqual(refused.map((r) => [r.metadataUrl, r.reason]), [[outside, 'host-policy']]);
    const shown = rows.filter((r) => r.event === 'oauth.consent.shown').map((r) => r.record);
    assert.deepEqual(shown.map((r) => r.metadataHost), ['client.example', 'client.example']);
    assert.ok(!JSON.stringify(rows).includes('Audited agent'), 'the document body never reaches the audit');
  });

  it('[OCMDE14] a confidential client (private_key_jwt, its key set on its host): assertions by the URL, replay, rotation, refresh, revoke; no introspection', async () => {
    resetJwksCacheForTests();
    const disc = await coreRequest.get('/.well-known/oauth-authorization-server');
    const tokenEndpoint = disc.body.token_endpoint;
    assert.ok(disc.body.token_endpoint_auth_signing_alg_values_supported.includes('RS256'));
    const rsa = signingKey('RS256', 'rsa-1');
    const ec = signingKey('ES256', 'ec-2');
    const jwksUrl = `https://client.example/keys/${cuid().slice(-8)}.json`;
    serve(jwksUrl, { keys: [rsa.publicJwk] });
    // Both members, as a confidential client publishes them: the singular decides.
    const url = publish({ token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], jwks_uri: jwksUrl });
    const who = await newUser();
    const assertion = (key) => clientAssertion(key, url, tokenEndpoint);
    const withAssertion = (body, a) => coreRequest.post('/oauth2/token').type('form')
      .send({ ...body, client_assertion_type: CLIENT_ASSERTION_TYPE_URN, client_assertion: a });

    const first = await codeFor(who, url);
    const codeBody = { grant_type: 'authorization_code', code: first.code, code_verifier: first.verifier, redirect_uri: REDIRECT_URI, resource: RS_AUD };
    const a1 = assertion(rsa);
    const t = await withAssertion(codeBody, a1);
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal((await rowFor(url)).tokenEndpointAuthMethod, 'private_key_jwt');
    // The same assertion again: its jti is burnt.
    const replay = await withAssertion({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token }, a1);
    assert.deepEqual([replay.status, replay.body.error], [401, 'invalid_client']);
    // A code exchange without the assertion: the client must authenticate.
    const second = await codeFor(who, url);
    let bare;
    const authRows = await auditRows(async () => {
      bare = await coreRequest.post('/oauth2/token').type('form').send({
        grant_type: 'authorization_code', code: second.code, code_verifier: second.verifier, redirect_uri: REDIRECT_URI, resource: RS_AUD, client_id: url,
      });
    });
    assert.deepEqual([bare.status, bare.body.error], [401, 'invalid_client']);
    // Recorded for the operator, with the endpoint and grant type.
    const authRefused = authRows.filter((r) => r.event === 'oauth.client.metadata_refused').map((r) => r.record);
    assert.deepEqual(authRefused.map((r) => [r.reason, r.metadataUrl, r.detail]),
      [['client-auth', url, '/oauth2/token authorization_code: client authentication failed']]);
    // The key rotated at the client's host (another kid, another algorithm):
    // the set is fetched again and the new key verifies, the withdrawn one no
    // longer does (the cache lapse is simulated).
    serve(jwksUrl, { keys: [ec.publicJwk] });
    resetJwksCacheForTests();
    const old = await withAssertion({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token }, assertion(rsa));
    assert.equal(old.status, 401, 'the withdrawn key');
    const r = await withAssertion({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token }, assertion(ec));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Revocation (RFC 7009) with an assertion; introspection is refused.
    const revoked = await coreRequest.post('/oauth2/revoke').type('form')
      .send({ token: r.body.refresh_token, token_type_hint: 'refresh_token', client_assertion_type: CLIENT_ASSERTION_TYPE_URN, client_assertion: assertion(ec) });
    assert.equal(revoked.status, 200);
    assert.equal((await withAssertion({ grant_type: 'refresh_token', refresh_token: r.body.refresh_token }, assertion(ec))).body.error, 'invalid_grant');
    const intro = await coreRequest.post('/oauth2/introspect').type('form')
      .send({ token: r.body.access_token, client_assertion_type: CLIENT_ASSERTION_TYPE_URN, client_assertion: assertion(ec) });
    assert.equal(intro.status, 401);
    // An assertion alone, naming a URL no row exists for (never authorized, or revoked): 401, recorded with the URL.
    const unseen = `https://client.example/apps/unseen-${cuid().slice(-8)}.json`;
    let noRow;
    const noRowRows = await auditRows(async () => {
      noRow = await withAssertion({ grant_type: 'refresh_token', refresh_token: 'x' }, clientAssertion(ec, unseen, tokenEndpoint));
    });
    assert.deepEqual([noRow.status, noRow.body.error], [401, 'invalid_client']);
    assert.deepEqual(noRowRows.filter((r) => r.event === 'oauth.client.metadata_refused').map((r) => [r.record.reason, r.record.metadataUrl, r.record.detail]),
      [['client-auth', unseen, '/oauth2/token refresh_token: client authentication failed']]);
    // A key set on another host makes the document invalid.
    const elsewhere = publish({ token_endpoint_auth_method: 'private_key_jwt', jwks_uri: 'https://tools.example/keys.json' });
    assert.equal((await authorize(elsewhere)).status, 400);
  });

  it('[OCMDE15] the access stamp: grant and sessions carry clientData.oauth.client, refreshed on refresh; the API refuses to change it; a derived session carries none', async () => {
    const url = publish();
    const who = await newUser();
    const { token } = await connect(who, url);
    const stamp = { name: 'Example agent', host: 'client.example', url };
    const grant = (await accesses(who)).find((a) => a.name === 'oauth-grant:' + metadataClientKey(url));
    assert.deepEqual(grant.clientData.oauth.client, stamp);
    const session = await rowOf(who, token.access_token);
    assert.deepEqual(session.clientData.oauth.client, stamp);
    const update = await coreRequest.put('/' + who.username + '/accesses/' + session.id).set('Authorization', who.token)
      .send({ clientData: { ...session.clientData, oauth: { ...session.clientData.oauth, client: { ...stamp, name: 'Forged' } } } });
    assert.notEqual(update.status, 200);
    // The document's name changes: the next refresh re-stamps the session.
    serve(url, { client_id: url, client_name: 'New name', redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'] });
    await ageRow(url, { fetchedAgo: 1000, expiredAgo: 1 });
    assert.equal((await authorize(url)).status, 302);
    const r = await refresh(token.refresh_token, url);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await rowOf(who, r.body.access_token)).clientData.oauth.client.name, 'New name');
    const x = await exchange(r.body.access_token);
    assert.equal((await rowOf(who, x.body.access_token)).clientData.oauth.client, undefined);
    // A curated client's accesses are not stamped.
    const rsGrantless = (await accesses(who)).filter((a) => a.name === 'oauth:' + rsId);
    assert.ok(rsGrantless.every((a) => a.clientData?.oauth?.client == null));
  });

  it('[OCMDE16] grant types: an unknown one drops out; offline_access yields a refresh token; a bad refresh token is invalid_grant', async () => {
    const url = publish({ grant_types: ['urn:ietf:params:oauth:grant-type:jwt-bearer', 'authorization_code', 'refresh_token'] });
    const who = await newUser();
    const { token } = await connect(who, url);
    assert.deepEqual((await rowFor(url)).grantTypes, ['authorization_code', 'refresh_token']);
    assert.ok(token.refresh_token != null);
    assert.equal((await refresh('nope', url)).body.error, 'invalid_grant');
    const noRefresh = publish({ grant_types: undefined });
    const other = await connect(who, noRefresh);
    assert.equal(other.token.refresh_token, undefined, 'RFC 7591 default: authorization_code only');
  });

  it('[OCMDE18] a row is provisional until the first consent, which records firstConsentAt once; its /offer works before', async () => {
    const url = publish();
    const who = await newUser();
    const res = await authorize(url);
    assert.equal(res.status, 302);
    const row0 = await rowFor(url);
    assert.equal(row0.metadata.firstConsentAt, undefined, 'provisional');
    const state = new URL(res.headers.location).searchParams.get('state');
    const { offer, accept } = await consent(who, state);
    assert.equal(offer.client.metadataUrl, url, '/offer on a provisional row');
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    const first = (await rowFor(url)).metadata.firstConsentAt;
    assert.ok(Number.isFinite(first));
    assert.equal((await rowFor(url)).updatedAt, row0.updatedAt, 'not a derived field');
    await connect(who, url);
    assert.equal((await rowFor(url)).metadata.firstConsentAt, first, 'written once');
    const lines = [];
    const log = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
      await cli.runShow(platformDB, cli.parseArgs(['show', url]), storage.getClient, () => 'TP');
    } finally {
      console.log = log;
    }
    assert.match(lines.join('\n'), /first consent: \d{4}-/);
  });

  /** Run `body` with some platform store methods wrapped (`wrap(original)`), restored after. */
  async function withPlatformHooks (hooks, body) {
    const own = {};
    for (const [name, wrap] of Object.entries(hooks)) {
      own[name] = Object.prototype.hasOwnProperty.call(platformDB, name) ? platformDB[name] : undefined;
      platformDB[name] = wrap(platformDB[name].bind(platformDB));
    }
    try {
      return await body();
    } finally {
      for (const name of Object.keys(hooks)) {
        if (own[name] === undefined) delete platformDB[name];
        else platformDB[name] = own[name];
      }
    }
  }

  it('[OCMDE19] permanence is written before the code (a failed or impossible write mints none) and healed by the code and refresh grants', async () => {
    const who = await newUser();
    const codeWrites = [];
    const watchCodes = (orig) => async (k, ...rest) => {
      if (String(k).startsWith('oauth-ac/')) codeWrites.push(k);
      return await orig(k, ...rest);
    };
    // (a) The marker write fails: server_error, no code, the row still provisional.
    const a = publish();
    const resA = await authorize(a);
    assert.equal(resA.status, 302);
    let failures = 0;
    const acceptA = await withPlatformHooks({
      setPlatformKv: (orig) => async (k, v) => {
        if (k === 'oauth-client/' + metadataClientKey(a) && failures++ === 0) throw new Error('store down');
        return await orig(k, v);
      },
      setAccessState: watchCodes,
    }, async () => (await consent(who, new URL(resA.headers.location).searchParams.get('state'))).accept);
    assert.deepEqual([acceptA.status, acceptA.body.error, failures], [500, 'server_error', 1], JSON.stringify(acceptA.body));
    assert.deepEqual(codeWrites, [], 'no code row');
    assert.equal((await rowFor(a)).metadata.firstConsentAt, undefined, 'still provisional');
    // (b) The row gone between the state's read and the marker: 400, no code.
    const b = publish();
    const resB = await authorize(b);
    assert.equal(resB.status, 302);
    const acceptB = await withPlatformHooks({
      setAccessState: (orig) => async (k, ...rest) => {
        // The session index write of /accept: the row vanishes right then.
        if (String(k).startsWith('oauth-at/')) await storage.deleteClientRow(platformDB, metadataClientKey(b));
        return await watchCodes(orig)(k, ...rest);
      },
    }, async () => (await consent(who, new URL(resB.headers.location).searchParams.get('state'))).accept);
    assert.equal(acceptB.status, 400, JSON.stringify(acceptB.body));
    assert.match(acceptB.body.error_description, /client metadata document unavailable/);
    assert.deepEqual(codeWrites, [], 'no code row');
    // (c) A consented row whose marker was lost: the code exchange marks it
    // again; lost again, the refresh does.
    const c = publish();
    const pending = await codeFor(who, c);
    const strip = async () => {
      const row = await rowFor(c);
      const { firstConsentAt: _f, ...rest } = row.metadata;
      await storage.setClient(platformDB, { ...row, metadata: rest });
      assert.equal((await rowFor(c)).metadata.firstConsentAt, undefined);
    };
    await strip();
    const t = await coreRequest.post('/oauth2/token').type('form').send({
      grant_type: 'authorization_code', code: pending.code, code_verifier: pending.verifier, client_id: c, redirect_uri: REDIRECT_URI, resource: RS_AUD,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.ok(Number.isFinite((await rowFor(c)).metadata.firstConsentAt), 'the code exchange marks it again');
    await strip();
    const r = await refresh(t.body.refresh_token, c);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Number.isFinite((await rowFor(c)).metadata.firstConsentAt), 'the refresh marks it again');
  });

  it('[OCMDE17] mode any: an arbitrary host is accepted; this platform\'s hosts (public URL, issuer) and a denied host are refused before any fetch', async () => {
    const anyCmd = { ...CMD, mode: 'any', allowedHosts: [], deniedHosts: ['tools.example'] };
    await withInjectedConfig({
      oauth: { ...OAUTH, issuer: 'https://issuer.platform.example', clientMetadataDocuments: anyCmd },
      dnsLess: { publicUrl: 'https://public.platform.example/' },
    }, async () => {
      const url = publish({}, 'agent.anywhere.example');
      assert.equal((await authorize(url)).status, 302);
      for (const host of ['issuer.platform.example', 'public.platform.example']) {
        const r = await authorize(`https://${host}/apps/x.json`);
        assert.equal(r.status, 400, host);
        assert.match(r.text, /host of this platform/, host);
      }
      const denied = publish({}, 'tools.example');
      const r = await authorize(denied);
      assert.equal(r.status, 400);
      assert.equal(hitsOf(denied), 0);
    });
  });
});
