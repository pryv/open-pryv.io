/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [DPOP-RS] Resource-server enforcement of DPoP (RFC 9449) key binding.
 *
 * An access carrying `clientData.dpop.jkt` must present a valid proof
 * (right key, right request line, fresh single-use jti, token-bound
 * ath) on EVERY request; an unbound access must never be usable under
 * the DPoP scheme; and the binding cannot be stripped via
 * accesses.update. All refusals are uniform.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { webcrypto } = require('node:crypto');
const { computeJkt } = require('oauth2/src/dpop.ts');

const { subtle } = webcrypto;
// The client-facing host a DPoP client signs into htu. Delivered via the
// reverse-proxy forwarding headers (which externalRequestUri prefers),
// so the server reconstructs THIS host even though supertest's own Host
// is 127.0.0.1 — and subdomain→path routing, which reads the real Host,
// never sees it. Exercises the F5 proxy path.
const HOST = 'api.example.com';
const fwd = (req) => req.set('X-Forwarded-Host', HOST).set('X-Forwarded-Proto', 'http');

async function makeKeyPair () {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  return { pair, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

async function makeProof (key, { htm, path, accessToken, jti }) {
  const b64url = (buf) => Buffer.from(buf).toString('base64url');
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk };
  const payload = {
    jti: jti ?? 'jti-' + crypto.randomUUID(),
    htm,
    htu: `http://${HOST}${path}`,
    iat: Math.floor(Date.now() / 1000),
    ...(accessToken != null ? { ath: crypto.createHash('sha256').update(accessToken).digest('base64url') } : {}),
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, Buffer.from(`${h}.${p}`, 'utf8'));
  return `${h}.${p}.${b64url(sig)}`;
}

describe('[DPOP-RS] DPoP sender-constraint enforcement on the resource server', function () {
  this.timeout(40000);

  let fixtures, username, personalToken, boundToken, boundAccessId, unboundToken, unboundAccessId, key;

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    key = await makeKeyPair();
    username = cuid();
    personalToken = cuid();
    boundToken = cuid();
    unboundToken = cuid();
    const user = await fixtures.user(username);
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);
    await user.stream({ id: 'health', name: 'Health' });
    const bound = await user.access({
      type: 'app',
      token: boundToken,
      name: 'dpop-bound-app',
      permissions: [{ streamId: 'health', level: 'read' }],
      clientData: { dpop: { jkt: computeJkt(key.publicJwk) } },
    });
    boundAccessId = bound.attrs.id;
    const unbound = await user.access({
      type: 'app',
      token: unboundToken,
      name: 'plain-bearer-app',
      permissions: [{ streamId: 'health', level: 'read' }],
    });
    unboundAccessId = unbound.attrs.id;
  });

  after(async function () {
    if (fixtures) await fixtures.context.cleanEverything();
  });

  function accessInfo () {
    return fwd(coreRequest.get(`/${username}/access-info`));
  }
  const path = () => `/${username}/access-info`;

  it('[DPN01] bound access + valid proof under the DPoP scheme succeeds', async function () {
    const proof = await makeProof(key, { htm: 'GET', path: path(), accessToken: boundToken });
    const res = await accessInfo().set('Authorization', 'DPoP ' + boundToken).set('DPoP', proof);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'dpop-bound-app');
  });

  it('[DPN02] bound access WITHOUT a proof is refused — bare and Bearer alike', async function () {
    const bare = await accessInfo().set('Authorization', boundToken);
    assert.equal(bare.status, 403, JSON.stringify(bare.body));
    const bearer = await accessInfo().set('Authorization', 'Bearer ' + boundToken);
    assert.equal(bearer.status, 403, JSON.stringify(bearer.body));
    assert.match(bearer.headers['www-authenticate'] ?? '', /DPoP/);
  });

  it('[DPN03] a proof for another request line (htm/htu) is refused', async function () {
    const wrongPath = await makeProof(key, { htm: 'GET', path: `/${username}/events`, accessToken: boundToken });
    const res = await accessInfo().set('Authorization', 'DPoP ' + boundToken).set('DPoP', wrongPath);
    assert.equal(res.status, 403);
    const wrongMethod = await makeProof(key, { htm: 'POST', path: path(), accessToken: boundToken });
    const res2 = await accessInfo().set('Authorization', 'DPoP ' + boundToken).set('DPoP', wrongMethod);
    assert.equal(res2.status, 403);
  });

  it('[DPN04] a proof signed by a DIFFERENT key is refused', async function () {
    const otherKey = await makeKeyPair();
    const proof = await makeProof(otherKey, { htm: 'GET', path: path(), accessToken: boundToken });
    const res = await accessInfo().set('Authorization', 'DPoP ' + boundToken).set('DPoP', proof);
    assert.equal(res.status, 403);
  });

  it('[DPN05] a proof missing/mismatching ath is refused', async function () {
    const noAth = await makeProof(key, { htm: 'GET', path: path() });
    const res = await accessInfo().set('Authorization', 'DPoP ' + boundToken).set('DPoP', noAth);
    assert.equal(res.status, 403);
    const wrongAth = await makeProof(key, { htm: 'GET', path: path(), accessToken: 'some-other-token' });
    const res2 = await accessInfo().set('Authorization', 'DPoP ' + boundToken).set('DPoP', wrongAth);
    assert.equal(res2.status, 403);
  });

  it('[DPN06] jti single-use: replaying a successful proof is refused', async function () {
    const proof = await makeProof(key, { htm: 'GET', path: path(), accessToken: boundToken });
    const first = await accessInfo().set('Authorization', 'DPoP ' + boundToken).set('DPoP', proof);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const replay = await accessInfo().set('Authorization', 'DPoP ' + boundToken).set('DPoP', proof);
    assert.equal(replay.status, 403);
  });

  it('[DPN07] an UNBOUND access under the DPoP scheme is refused (kind is fixed at issuance)', async function () {
    const proof = await makeProof(key, { htm: 'GET', path: path(), accessToken: unboundToken });
    const res = await accessInfo().set('Authorization', 'DPoP ' + unboundToken).set('DPoP', proof);
    assert.equal(res.status, 403);
    // And stays fully usable as plain Bearer.
    const bearer = await accessInfo().set('Authorization', unboundToken);
    assert.equal(bearer.status, 200, JSON.stringify(bearer.body));
  });

  it('[DPN08] the batch route enforces the binding too', async function () {
    const batch = await fwd(coreRequest.post(`/${username}`))
      .set('Authorization', boundToken)
      .send([{ method: 'events.get', params: {} }]);
    // The bound token without a proof must not execute batch calls.
    const results = batch.body.results ?? [];
    const anyOk = results.some((r) => r.error == null);
    assert.equal(anyOk, false, 'batch with a bound token and no proof must not succeed: ' + JSON.stringify(batch.body));
  });

  it('[DPN09] accesses.update cannot strip or alter the binding (wholesale clientData replace)', async function () {
    // Rejected updates do not bump the access serial, so the base id
    // stays addressable across them; the successful ones return the new
    // composite id to reuse.
    const upd = (id, body) => coreRequest
      .put(`/${username}/accesses/${id}`).set('Authorization', personalToken).send(body);

    const strip = await upd(boundAccessId, { clientData: { harmless: true } });
    assert.equal(strip.status, 403, JSON.stringify(strip.body));
    const alter = await upd(boundAccessId, { clientData: { dpop: { jkt: 'attacker-thumbprint' } } });
    assert.equal(alter.status, 403, JSON.stringify(alter.body));
    // Preserving the binding verbatim is allowed.
    const keep = await upd(boundAccessId, { clientData: { dpop: { jkt: computeJkt(key.publicJwk) }, note: 'kept' } });
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    // An update that does not touch clientData is unaffected (use the new head id).
    const rename = await upd(keep.body.access.id, { name: 'dpop-bound-app-renamed' });
    assert.equal(rename.status, 200, JSON.stringify(rename.body));
  });

  it('[DPN10] a binding cannot be FORGED onto an unbound access via accesses.update', async function () {
    const forge = await coreRequest
      .put(`/${username}/accesses/${unboundAccessId}`)
      .set('Authorization', personalToken)
      .send({ clientData: { dpop: { jkt: 'attacker-thumbprint' } } });
    assert.equal(forge.status, 403, JSON.stringify(forge.body));
    // A clientData update that leaves dpop absent (as it was) is fine.
    const ok = await coreRequest
      .put(`/${username}/accesses/${unboundAccessId}`)
      .set('Authorization', personalToken)
      .send({ clientData: { note: 'plain' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});
