/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [OCKE] OAuth client authentication and lifetimes end to end: a registry
 * client with two inline keys (RS384 + ES384) and both algorithms pinned
 * authenticates at /oauth2/token with real signed assertions; a key named
 * for another algorithm is refused without using up the token; per-client
 * lifetimes and withheld offline access; the rotated secret window; the
 * `scope` length cap at /oauth2/authorize.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as oauth2 from 'oauth2';
import * as storage from 'oauth2/src/storage.ts';
import { mintSecret } from 'oauth2/src/clientSecret.ts';
import { tokenEndpointAudiences } from 'oauth2/src/issuer.ts';
import * as storages from 'storages';
import { injectTestConfigSnapshot } from 'test-helpers';
import { getConfigUnsafe } from '@pryv/boiler';

const REDIRECT_URI = 'https://app.keys.test/redirect';
const CONSENT_URL = 'https://auth.test/oauth2-authorize';
const AUD = 'https://resource.test/base';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

const toyExtension = {
  apiVersion: 1,
  name: 'toy-keys',
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

function makeKey (alg, kid) {
  const { privateKey, publicKey } = alg === 'RS384'
    ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    : crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const pub = publicKey.export({ format: 'jwk' });
  const jwk = pub.kty === 'RSA' ? { kty: 'RSA', n: pub.n, e: pub.e } : { kty: 'EC', crv: pub.crv, x: pub.x, y: pub.y };
  return { alg, privateKey, publicJwk: { ...jwk, kid } };
}

function pkce () {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

describe('[OCKE] OAuth client keys, algorithms and lifetimes, end to end', function () {
  this.timeout(60000);

  let fixtures, restoreConfig, platformDB, rs, es, pkjId, secId, offId, oldSecret, newSecret;

  function assertionFor (key, clientId, { alg = key.alg, kid = key.publicJwk.kid } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const [tokenEndpoint] = tokenEndpointAudiences(getConfigUnsafe(true)).slice(-1);
    const h = b64url(JSON.stringify({ alg, typ: 'JWT', kid }));
    const p = b64url(JSON.stringify({ iss: clientId, sub: clientId, aud: tokenEndpoint, jti: crypto.randomUUID(), iat: now, exp: now + 120 }));
    const input = Buffer.from(h + '.' + p);
    const sig = key.alg === 'RS384'
      ? crypto.sign('sha384', input, key.privateKey)
      : crypto.sign('sha384', input, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
    return h + '.' + p + '.' + b64url(sig);
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    restoreConfig = injectTestConfigSnapshot({ oauth: { consentUrl: CONSENT_URL } });
    oauth2.extension.setExtension(toyExtension);
    platformDB = storages.platformDB;
    rs = makeKey('RS384', 'rsa-1');
    es = makeKey('ES384', 'ec-1');
    const row = {
      kind: 'registry',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
      allowedAudiences: [AUD],
      subjectType: 'public',
      scope: ['read/a'],
    };
    pkjId = 'Pkj.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, {
      ...row,
      clientId: pkjId,
      tokenEndpointAuthMethod: 'private_key_jwt',
      jwks: { keys: [rs.publicJwk, es.publicJwk] },
      tokenEndpointAuthSigningAlgs: ['RS384', 'ES384'],
      accessTokenTTL: 600,
    });
    oldSecret = await mintSecret();
    newSecret = await mintSecret();
    secId = 'Sec.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, {
      ...row,
      clientId: secId,
      tokenEndpointAuthMethod: 'client_secret_basic',
      clientSecretHash: newSecret.hash,
      previousSecretHash: oldSecret.hash,
      previousSecretExpiresAt: Date.now() + 3600 * 1000,
    });
    offId = 'Off.' + cuid().slice(-10);
    await oauth2.persistClient(platformDB, { ...row, clientId: offId, tokenEndpointAuthMethod: 'none', offlineAccessAllowed: false });
  });

  after(async function () {
    oauth2.extension._resetForTests();
    if (restoreConfig != null) restoreConfig();
    for (const id of [pkjId, secId, offId]) {
      try { await storage.deleteClient(platformDB, id); } catch (_) { /* best-effort */ }
    }
    if (fixtures != null) await fixtures.clean();
  });

  async function newUser () {
    const username = cuid();
    const token = cuid();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    const s = await coreRequest.post('/' + username + '/streams').set('Authorization', token).send({ id: 'a', name: 'a' });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    return { username, token };
  }

  function authorize (cid, scope, challenge) {
    return coreRequest.get('/oauth2/authorize').query({
      client_id: cid,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'csrf-' + cuid(),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      aud: AUD,
    });
  }

  async function consent (who, cid, scope = 'offline_access read/a') {
    const { verifier, challenge } = pkce();
    const res = await authorize(cid, scope, challenge);
    assert.equal(res.status, 302, res.text);
    const state = new URL(res.headers.location).searchParams.get('state');
    assert.ok(state != null, res.headers.location);
    const o = await coreRequest.post('/oauth2/authorize/offer').send({ state, username: who.username, userToken: who.token });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const granted = o.body.offer.permissions.map(({ currentlyGranted: _c, currentLevel: _l, ...p }) => p);
    const a = await coreRequest.post('/oauth2/authorize/accept')
      .send({ state, username: who.username, userToken: who.token, grantedPermissions: granted, shownDigest: o.body.shownDigest });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    return { verifier, code: new URL(a.body.redirectTo).searchParams.get('code') };
  }

  function token (body, basic = null) {
    const req = coreRequest.post('/oauth2/token').type('form');
    if (basic != null) req.set('Authorization', 'Basic ' + Buffer.from(basic[0] + ':' + basic[1]).toString('base64'));
    return req.send(body);
  }

  const codeBody = (flow, extra) => ({ grant_type: 'authorization_code', code: flow.code, code_verifier: flow.verifier, redirect_uri: REDIRECT_URI, ...extra });

  it('[OCKE1] RS384 and ES384 assertions of one two-key client: the exchange and the refresh pass, expires_in is the client\'s; an RS384 header naming the ES384 key is refused and uses nothing up', async () => {
    const who = await newUser();
    const flow = await consent(who, pkjId);
    // Client named by the assertion alone (no client_id).
    const t = await token(codeBody(flow, { client_assertion: assertionFor(rs, pkjId), client_assertion_type: ASSERTION_TYPE }));
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.expires_in, 600);
    assert.ok(typeof t.body.refresh_token === 'string');
    const read = await coreRequest.get('/' + who.username + '/events').query({ streams: JSON.stringify(['a']) }).set('Authorization', t.body.access_token);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const session = (await coreRequest.get('/' + who.username + '/accesses').set('Authorization', who.token)).body.accesses
      .find((x) => x.token === t.body.access_token);
    assert.ok(session.expires <= Date.now() / 1000 + 601, 'the session lives the client\'s lifetime');

    const confused = await token({
      grant_type: 'refresh_token',
      refresh_token: t.body.refresh_token,
      client_id: pkjId,
      client_assertion: assertionFor(rs, pkjId, { kid: 'ec-1' }),
      client_assertion_type: ASSERTION_TYPE,
    });
    assert.equal(confused.status, 401, JSON.stringify(confused.body));
    assert.equal(confused.body.error, 'invalid_client');
    const wrongAlg = await token({
      grant_type: 'refresh_token',
      refresh_token: t.body.refresh_token,
      client_id: pkjId,
      client_assertion: assertionFor(es, pkjId, { alg: 'ES256' }),
      client_assertion_type: ASSERTION_TYPE,
    });
    assert.equal(wrongAlg.status, 401);
    const r = await token({
      grant_type: 'refresh_token',
      refresh_token: t.body.refresh_token,
      client_id: pkjId,
      client_assertion: assertionFor(es, pkjId),
      client_assertion_type: ASSERTION_TYPE,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.expires_in, 600);
  });

  it('[OCKE2] the secret replaced by a rotation authenticates until its expiry, then is refused; the current one keeps working', async () => {
    const who = await newUser();
    const t = await token(codeBody(await consent(who, secId), {}), [secId, oldSecret.plaintext]);
    assert.equal(t.status, 200, JSON.stringify(t.body));
    const client = await storage.getClient(platformDB, secId);
    await storage.setClient(platformDB, { ...client, previousSecretExpiresAt: Date.now() - 1000 });
    const expired = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token }, [secId, oldSecret.plaintext]);
    assert.equal(expired.status, 401, JSON.stringify(expired.body));
    const current = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token }, [secId, newSecret.plaintext]);
    assert.equal(current.status, 200, JSON.stringify(current.body));
  });

  it('[OCKE3] offline access withheld from a client: offline_access is dropped from the answer and no refresh token is issued', async () => {
    const who = await newUser();
    const t = await token(codeBody(await consent(who, offId), { client_id: offId }));
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.refresh_token, undefined);
    assert.equal(t.body.scope.split(' ').includes('offline_access'), false, t.body.scope);
    assert.equal(t.body.expires_in, Number(getConfigUnsafe(true).get('oauth:accessTokenTTL') ?? 3600));
  });

  it('[OCKE4] /oauth2/authorize refuses a scope longer than 8 KiB with invalid_scope', async () => {
    const { challenge } = pkce();
    const res = await authorize(pkjId, 'read/a ' + 'read/x'.repeat(1400), challenge);
    assert.equal(res.status, 302, res.text);
    const loc = new URL(res.headers.location);
    assert.equal(loc.origin + loc.pathname, REDIRECT_URI);
    assert.equal(loc.searchParams.get('error'), 'invalid_scope');
    assert.match(loc.searchParams.get('error_description'), /8192 bytes/);
  });

  it('[OCKE5] discovery lists the assertion algorithms', async () => {
    const res = await coreRequest.get('/.well-known/oauth-authorization-server');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.token_endpoint_auth_signing_alg_values_supported, ['ES256', 'ES384', 'RS384']);
  });
});
