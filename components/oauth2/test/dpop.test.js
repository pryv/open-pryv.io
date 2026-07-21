/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const { verifyDPoPProof, computeJkt, normalizeHtu, DPoPProofError } = require('../src/dpop.ts');

const { subtle } = webcrypto;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function makeKeyPair () {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  return { pair, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

async function signProof (pair, header, payload) {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.from(`${h}.${p}`, 'utf8')
  );
  return `${h}.${p}.${b64url(sig)}`;
}

/** Build a valid proof, with per-call overrides for header/payload. */
async function makeProof (key, opts = {}) {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk, ...opts.header };
  const payload = {
    jti: 'jti-' + Math.random().toString(36).slice(2),
    htm: 'POST',
    htu: 'https://api.example.com/oauth2/token',
    iat: Math.floor(NOW / 1000),
    ...opts.payload,
  };
  return signProof(key.pair, header, payload);
}

const NOW = 1_700_000_000_000; // fixed clock — tests are deterministic
const OPTS = {
  htm: 'POST',
  htu: 'https://api.example.com/oauth2/token',
  clockSkewSeconds: 120,
  now: NOW,
};

async function rejects (proof, opts, reasonPattern) {
  await assert.rejects(
    () => verifyDPoPProof(proof, { ...OPTS, ...opts }),
    (err) => {
      assert.ok(err instanceof DPoPProofError, `expected DPoPProofError, got ${err?.constructor?.name}: ${err?.message}`);
      assert.equal(err.code, 'invalid_dpop_proof');
      if (reasonPattern) assert.match(err.reason, reasonPattern);
      return true;
    }
  );
}

describe('[OAUTH-DPV] DPoP proof verification (RFC 9449)', () => {
  let key;
  before(async () => { key = await makeKeyPair(); });

  it('[DPV01] a valid proof verifies and returns jkt + jti + iat', async () => {
    const proof = await makeProof(key, { payload: { jti: 'the-jti' } });
    const res = await verifyDPoPProof(proof, OPTS);
    assert.equal(res.jti, 'the-jti');
    assert.equal(res.iat, Math.floor(NOW / 1000));
    // Independent RFC 7638 computation: sha256 of the canonical
    // lexicographic required-members JSON.
    const canonical = `{"crv":"${key.publicJwk.crv}","kty":"${key.publicJwk.kty}","x":"${key.publicJwk.x}","y":"${key.publicJwk.y}"}`;
    assert.equal(res.jkt, createHash('sha256').update(canonical).digest('base64url'));
    assert.equal(res.jkt, computeJkt(key.publicJwk));
  });

  it('[DPV02] a tampered payload fails signature verification', async () => {
    const proof = await makeProof(key);
    const [h, p, s] = proof.split('.');
    const tampered = JSON.parse(Buffer.from(p, 'base64url').toString());
    tampered.htu = 'https://evil.example.com/oauth2/token';
    await rejects(`${h}.${b64url(JSON.stringify(tampered))}.${s}`, { htu: 'https://evil.example.com/oauth2/token' }, /signature/);
  });

  it('[DPV03] wrong typ is rejected', async () => {
    await rejects(await makeProof(key, { header: { typ: 'JWT' } }), {}, /typ/);
  });

  it('[DPV04] alg confusion is rejected: none and HS256', async () => {
    await rejects(await makeProof(key, { header: { alg: 'none' } }), {}, /alg/);
    await rejects(await makeProof(key, { header: { alg: 'HS256' } }), {}, /alg/);
  });

  it('[DPV05] private key material in the jwk is rejected', async () => {
    const jwkWithD = { ...key.publicJwk, d: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    await rejects(await makeProof(key, { header: { jwk: jwkWithD } }), {}, /private/);
  });

  it('[DPV06] htm mismatch is rejected', async () => {
    await rejects(await makeProof(key, { payload: { htm: 'GET' } }), {}, /htm/);
  });

  it('[DPV07] htu: query is ignored, default port elided, host case-folded; path mismatch rejected', async () => {
    const q = await makeProof(key, { payload: { htu: 'https://API.example.com:443/oauth2/token?state=x#frag' } });
    const res = await verifyDPoPProof(q, OPTS);
    assert.ok(res.jkt);
    await rejects(await makeProof(key, { payload: { htu: 'https://api.example.com/oauth2/token/' } }), {}, /htu/);
    await rejects(await makeProof(key, { payload: { htu: '/oauth2/token' } }), {}, /htu|URI/);
  });

  it('[DPV08] iat outside the ±skew window is rejected, inside passes', async () => {
    const sec = Math.floor(NOW / 1000);
    await rejects(await makeProof(key, { payload: { iat: sec - 121 } }), {}, /iat/);
    await rejects(await makeProof(key, { payload: { iat: sec + 121 } }), {}, /iat/);
    await verifyDPoPProof(await makeProof(key, { payload: { iat: sec - 119 } }), OPTS);
    await verifyDPoPProof(await makeProof(key, { payload: { iat: sec + 119 } }), OPTS);
  });

  it('[DPV09] ath binds the proof to the access token', async () => {
    const token = 'the-access-token';
    const ath = createHash('sha256').update(token).digest('base64url');
    const good = await makeProof(key, { payload: { ath } });
    await verifyDPoPProof(good, { ...OPTS, accessToken: token });
    // Wrong token → mismatch; missing ath → mismatch.
    await rejects(good, { accessToken: 'another-token' }, /ath/);
    await rejects(await makeProof(key), { accessToken: token }, /ath/);
    // A proof carrying ath still verifies when the caller expects none
    // (token endpoint: no token exists yet).
    await verifyDPoPProof(good, OPTS);
  });

  it('[DPV10] malformed inputs are rejected: not a string, bad JWS shape, oversized, garbage segments', async () => {
    await rejects(null, {}, /missing/);
    await rejects('only.two', {}, /compact JWS/);
    await rejects('a.b.c.d', {}, /compact JWS/);
    await rejects('x'.repeat(5000), {}, /too large/);
    await rejects('!!.??.!!', {}, /base64url/);
    const [h, , s] = (await makeProof(key)).split('.');
    await rejects(`${h}.${b64url('"just a string"')}.${s}`, {}, /JSON object|signature/);
  });

  it('[DPV11] jti missing or out of bounds is rejected', async () => {
    await rejects(await makeProof(key, { payload: { jti: undefined } }), {}, /jti/);
    await rejects(await makeProof(key, { payload: { jti: '' } }), {}, /jti/);
    await rejects(await makeProof(key, { payload: { jti: 'x'.repeat(300) } }), {}, /jti/);
  });

  it('[DPV12] a key from a DIFFERENT pair fails verification (signature, not shape)', async () => {
    const otherKey = await makeKeyPair();
    // Proof signed with key A but advertising key B in the header.
    const proof = await makeProof({ pair: key.pair, publicJwk: otherKey.publicJwk });
    await rejects(proof, {}, /signature/);
  });

  it('[DPV13] off-curve public key coordinates are rejected as a proof defect, not a crash', async () => {
    const badJwk = { ...key.publicJwk, x: b64url(Buffer.alloc(32, 7)) };
    await rejects(await makeProof(key, { header: { jwk: badJwk } }), {}, /key|signature/);
  });

  it('[DPV14] normalizeHtu is exported and stable for the enforcement layer', () => {
    assert.equal(normalizeHtu('HTTPS://Api.Example.com:443/a/B?q=1#f'), 'https://api.example.com/a/B');
    assert.equal(normalizeHtu('http://host:80/x'), 'http://host/x');
    assert.equal(normalizeHtu('http://host:8080/x'), 'http://host:8080/x');
  });
});
