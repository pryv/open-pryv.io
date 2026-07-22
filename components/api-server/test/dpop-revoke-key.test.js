/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [RJKT20] Resource-server enforcement of operator revoke-by-jkt.
 *
 * An operator tombstones a DPoP key thumbprint; every access bound to that
 * key stops working cluster-wide within the cache TTL, regardless of when its
 * token was minted (PRESENCE / blocklist semantics — a token rotated onto the
 * same key AFTER the revoke stays dead, which a token-EPOCH check would wrongly
 * honour). Other keys, plain Bearer, and personal accesses are untouched.
 * unrevoke restores access.
 */

/* global initTests, initCore, coreRequest, getNewFixture, cuid */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { webcrypto } = require('node:crypto');
const { computeJkt } = require('oauth2/src/dpop.ts');
const storage = require('oauth2/src/storage.ts');
const revokedKeysCache = require('oauth2/src/revokedKeysCache.ts');

const { subtle } = webcrypto;
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

describe('[RJKT20] operator revoke-by-jkt enforcement on the resource server', function () {
  this.timeout(40000);

  let fixtures, user, username, personalToken, key, otherKey, jkt, otherJkt;
  let boundToken, otherBoundToken, unboundToken;

  // Writing a tombstone is a per-core cached read on the hot path; reset the
  // cache so the very next request observes the revoke deterministically
  // (production converges within keyRevokeCheckSeconds — proven by [RJKT10]).
  function revoke (thumbprint) {
    return storage.revokeDpopKey(require('storages').platformDB, thumbprint)
      .then(() => revokedKeysCache._resetForTests());
  }
  function unrevoke (thumbprint) {
    return storage.unrevokeDpopKey(require('storages').platformDB, thumbprint)
      .then(() => revokedKeysCache._resetForTests());
  }

  before(async function () {
    await initTests();
    await initCore();
    fixtures = getNewFixture();
    key = await makeKeyPair();
    otherKey = await makeKeyPair();
    jkt = computeJkt(key.publicJwk);
    otherJkt = computeJkt(otherKey.publicJwk);
    username = cuid();
    personalToken = cuid();
    boundToken = cuid();
    otherBoundToken = cuid();
    unboundToken = cuid();
    user = await fixtures.user(username);
    await user.access({ token: personalToken, type: 'personal' });
    await user.session(personalToken);
    await user.stream({ id: 'health', name: 'Health' });
    await user.access({
      type: 'app',
      token: boundToken,
      name: 'oauth:appA',
      permissions: [{ streamId: 'health', level: 'read' }],
      clientData: { dpop: { jkt } },
    });
    await user.access({
      type: 'app',
      token: otherBoundToken,
      name: 'oauth:appB',
      deviceName: 'other-key',
      permissions: [{ streamId: 'health', level: 'read' }],
      clientData: { dpop: { jkt: otherJkt } },
    });
    await user.access({
      type: 'app',
      token: unboundToken,
      name: 'oauth:appC',
      deviceName: 'bearer',
      permissions: [{ streamId: 'health', level: 'read' }],
    });
  });

  after(async function () {
    if (fixtures) await fixtures.context.cleanEverything();
    revokedKeysCache._resetForTests();
  });

  const path = () => `/${username}/access-info`;
  function accessInfoDpop (token, proofKey) {
    return makeProof(proofKey, { htm: 'GET', path: path(), accessToken: token })
      .then((proof) => fwd(coreRequest.get(path())).set('Authorization', 'DPoP ' + token).set('DPoP', proof));
  }

  it('[RJKT20a] a bound access works, then is refused after its jkt is revoked; a different key is unaffected', async function () {
    const ok = await accessInfoDpop(boundToken, key);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    await revoke(jkt);

    const denied = await accessInfoDpop(boundToken, key);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    // A DIFFERENT key's bound access still works.
    const otherOk = await accessInfoDpop(otherBoundToken, otherKey);
    assert.equal(otherOk.status, 200, JSON.stringify(otherOk.body));

    await unrevoke(jkt); // leave the fixture clean for later cases
  });

  it('[RJKT20b] revoking a jkt does not affect a plain Bearer (unbound) access', async function () {
    await revoke(jkt);
    const bearer = await coreRequest.get(path()).set('Authorization', unboundToken);
    assert.equal(bearer.status, 200, JSON.stringify(bearer.body));
    await unrevoke(jkt);
  });

  it('[RJKT20c] revoking a jkt does not affect a personal access', async function () {
    await revoke(jkt);
    const personal = await coreRequest.get(path()).set('Authorization', personalToken);
    assert.equal(personal.status, 200, JSON.stringify(personal.body));
    await unrevoke(jkt);
  });

  it('[RJKT20d] PRESENCE semantics: a token bound to the same key MINTED AFTER the revoke is still dead', async function () {
    await revoke(jkt);
    // Simulate a post-revoke rotation/mint onto the same compromised key: a
    // fresh access (later `created`) bound to the revoked jkt. An epoch check
    // (created > revokedAt) would honour it; presence refuses it.
    const freshToken = cuid();
    await user.access({
      type: 'app',
      token: freshToken,
      name: 'oauth:appA',
      deviceName: 'post-revoke-rotation',
      permissions: [{ streamId: 'health', level: 'read' }],
      clientData: { dpop: { jkt } },
    });
    const res = await accessInfoDpop(freshToken, key);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    await unrevoke(jkt);
  });

  it('[RJKT20e] an attachment readToken minted for a revoked-key session is refused; a non-revoked key still downloads', async function () {
    // Seed an event with an attachment in the readable stream.
    const created = await coreRequest.post(`/${username}/events`).set('Authorization', personalToken)
      .field('event', JSON.stringify({ streamIds: ['health'], type: 'note/txt', content: 'x' }))
      .attach('file', Buffer.from('hello-attachment'), 'a.txt');
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // The bound access lists it (with a proof) → gets a readToken bound to it.
    const list = await fwd(coreRequest.get(`/${username}/events`).query({ streams: ['health'] }))
      .set('Authorization', 'DPoP ' + boundToken)
      .set('DPoP', await makeProof(key, { htm: 'GET', path: `/${username}/events`, accessToken: boundToken }));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const evt = list.body.events.find((e) => (e.attachments ?? []).length > 0);
    assert.ok(evt != null, 'an event with an attachment is listed');
    const att = evt.attachments[0];
    const attPath = `/${username}/events/${evt.id}/${att.id}`;

    // Before revoke: the readToken downloads with no Authorization/DPoP header.
    const okDl = await coreRequest.get(attPath).query({ readToken: att.readToken });
    assert.equal(okDl.status, 200, JSON.stringify({ s: okDl.status, t: okDl.text }));

    // After revoking the key, the same readToken is refused — the revoke check
    // does NOT exempt readToken (unlike the proof check).
    await revoke(jkt);
    const deniedDl = await coreRequest.get(attPath).query({ readToken: att.readToken });
    assert.equal(deniedDl.status, 403, JSON.stringify({ s: deniedDl.status, t: deniedDl.text }));
    await unrevoke(jkt);
  });

  it('[RJKT20f] unrevoke restores a bound access (pre-expiry tokens resume)', async function () {
    await revoke(jkt);
    const denied = await accessInfoDpop(boundToken, key);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    await unrevoke(jkt);
    const restored = await accessInfoDpop(boundToken, key);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
  });
});
