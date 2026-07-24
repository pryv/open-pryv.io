/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-CASSERT] private_key_jwt client-assertion verifier (RFC 7521/7523)
 * + public JWK Set validation. Real P-256 key pairs + real ES256
 * signatures via node:crypto webcrypto — no mocked crypto.
 */

const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const {
  verifyClientAssertion, ClientAssertionError, CLIENT_ASSERTION_TYPE,
} = require('../src/clientAssertion.ts');
const {
  validatePublicJwk, validatePublicJwkSet, computeThumbprint,
} = require('../src/jwks.ts');

const { subtle } = webcrypto;

const CLIENT_ID = 'myapp';
const ISSUER = 'https://reg.pryv.me';
const TOKEN_ENDPOINT = ISSUER + '/oauth2/token';
const AUDS = [ISSUER, TOKEN_ENDPOINT];

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function makeKeyPair () {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await subtle.exportKey('jwk', pair.publicKey);
  const priv = await subtle.exportKey('jwk', pair.privateKey); // carries `d`
  return { pair, publicJwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, privateJwk: priv };
}

async function sign (key, header, payload) {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, Buffer.from(`${h}.${p}`, 'utf8'));
  return `${h}.${p}.${b64url(sig)}`;
}

function nowSec () { return Math.floor(Date.now() / 1000); }

async function makeAssertion (key, { header = {}, payload = {} } = {}) {
  const h = { alg: 'ES256', typ: 'JWT', ...header };
  const p = {
    iss: CLIENT_ID,
    sub: CLIENT_ID,
    aud: TOKEN_ENDPOINT,
    jti: 'jti-' + Math.random().toString(36).slice(2),
    exp: nowSec() + 120,
    iat: nowSec(),
    ...payload,
  };
  return sign(key, h, p);
}

function opts (key, over = {}) {
  return { clientId: CLIENT_ID, jwks: { keys: [key.publicJwk] }, expectedAudiences: AUDS, ...over };
}

async function assertRejected (promise) {
  await assert.rejects(promise, (e) => e instanceof ClientAssertionError);
}

describe('[OAUTH-CASSERT] private_key_jwt client assertion', () => {
  let key;
  before(async () => { key = await makeKeyPair(); });

  describe('[OAUTH-CASSERT-OK] valid', () => {
    it('[OCA1] a well-formed assertion verifies and returns jti + exp', async () => {
      const exp = nowSec() + 90;
      const a = await makeAssertion(key, { payload: { jti: 'good-1', exp } });
      const v = await verifyClientAssertion(a, opts(key));
      assert.equal(v.jti, 'good-1');
      assert.equal(v.exp, exp);
    });
    it('[OCA2] aud may be the issuer URL (not only the token endpoint)', async () => {
      const a = await makeAssertion(key, { payload: { aud: ISSUER } });
      const v = await verifyClientAssertion(a, opts(key));
      assert.ok(v.jti);
    });
    it('[OCA3] aud may be an array containing an accepted value', async () => {
      const a = await makeAssertion(key, { payload: { aud: ['https://other', TOKEN_ENDPOINT] } });
      const v = await verifyClientAssertion(a, opts(key));
      assert.ok(v.jti);
    });
    it('[OCA4] a matching kid selects the right key', async () => {
      const withKid = { ...key.publicJwk, kid: 'k1' };
      const a = await makeAssertion(key, { header: { kid: 'k1' } });
      const v = await verifyClientAssertion(a, opts(key, { jwks: { keys: [withKid] } }));
      assert.ok(v.jti);
    });
    it('[OCA5] with no kid, every registered key is tried (signer is second in set)', async () => {
      const other = await makeKeyPair();
      const a = await makeAssertion(key);
      const v = await verifyClientAssertion(a, opts(key, { jwks: { keys: [other.publicJwk, key.publicJwk] } }));
      assert.ok(v.jti);
    });
  });

  describe('[OAUTH-CASSERT-SIG] signature / algorithm', () => {
    it('[OCA6] a tampered signature is rejected', async () => {
      const a = await makeAssertion(key);
      await assertRejected(verifyClientAssertion(a.slice(0, -4) + 'AAAA', opts(key)));
    });
    it('[OCA7] a different key than the registered one is rejected', async () => {
      const other = await makeKeyPair();
      const a = await makeAssertion(other); // signed by a key NOT on file
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA8] alg=RS256 is rejected (no alg confusion)', async () => {
      const a = await makeAssertion(key, { header: { alg: 'RS256' } });
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA9] alg=HS256 is rejected', async () => {
      const a = await makeAssertion(key, { header: { alg: 'HS256' } });
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA10] alg=none is rejected', async () => {
      const a = await makeAssertion(key, { header: { alg: 'none' } });
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA11] a named kid that matches nothing is rejected (no fall-through to all keys)', async () => {
      const withKid = { ...key.publicJwk, kid: 'k1' };
      const a = await makeAssertion(key, { header: { kid: 'nope' } });
      await assertRejected(verifyClientAssertion(a, opts(key, { jwks: { keys: [withKid] } })));
    });
    it('[OCA12] no JWKS on file is rejected', async () => {
      const a = await makeAssertion(key);
      await assertRejected(verifyClientAssertion(a, opts(key, { jwks: null })));
    });
  });

  describe('[OAUTH-CASSERT-CLAIMS] claims', () => {
    it('[OCA13] iss != client_id is rejected', async () => {
      const a = await makeAssertion(key, { payload: { iss: 'attacker' } });
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA14] sub != client_id is rejected', async () => {
      const a = await makeAssertion(key, { payload: { sub: 'attacker' } });
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA15] client_id mismatch (verifier expects a different id) is rejected', async () => {
      const a = await makeAssertion(key); // iss=sub=myapp
      await assertRejected(verifyClientAssertion(a, opts(key, { clientId: 'someoneelse' })));
    });
    it('[OCA16] aud that matches neither issuer nor token endpoint is rejected', async () => {
      const a = await makeAssertion(key, { payload: { aud: 'https://evil.example/token' } });
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA17] missing aud is rejected', async () => {
      const a = await makeAssertion(key, { payload: { aud: undefined } });
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA18] server with no derivable audiences rejects (fail-closed)', async () => {
      const a = await makeAssertion(key);
      await assertRejected(verifyClientAssertion(a, opts(key, { expectedAudiences: [] })));
    });
    it('[OCA19] missing jti is rejected', async () => {
      const a = await makeAssertion(key, { payload: { jti: undefined } });
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA20] missing exp is rejected', async () => {
      const a = await makeAssertion(key, { payload: { exp: undefined } });
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA21] an expired assertion is rejected', async () => {
      const a = await makeAssertion(key, { payload: { exp: nowSec() - 3600, iat: nowSec() - 3660 } });
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA22] exp too far in the future is rejected (> 300s)', async () => {
      const a = await makeAssertion(key, { payload: { exp: nowSec() + 3600 } });
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA23] iat in the future is rejected', async () => {
      const a = await makeAssertion(key, { payload: { iat: nowSec() + 3600 } });
      await assertRejected(verifyClientAssertion(a, opts(key)));
    });
    it('[OCA24] iat is optional (absent is accepted)', async () => {
      const a = await makeAssertion(key, { payload: { iat: undefined } });
      const v = await verifyClientAssertion(a, opts(key));
      assert.ok(v.jti);
    });
  });

  describe('[OAUTH-CASSERT-SHAPE] structural', () => {
    it('[OCA25] a non-JWS string is rejected', async () => {
      await assertRejected(verifyClientAssertion('not-a-jwt', opts(key)));
    });
    it('[OCA26] a missing assertion is rejected', async () => {
      await assertRejected(verifyClientAssertion('', opts(key)));
    });
    it('[OCA27] CLIENT_ASSERTION_TYPE is the RFC 7521 jwt-bearer URN', () => {
      assert.equal(CLIENT_ASSERTION_TYPE, 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    });
  });

  describe('[OAUTH-CASSERT-JWKS] public JWK Set validation', () => {
    it('[OCA28] a valid public EC P-256 key validates', async () => {
      const out = validatePublicJwk(key.publicJwk);
      assert.equal(out.kty, 'EC');
      assert.equal(out.crv, 'P-256');
    });
    it('[OCA29] a key carrying private material ("d") is rejected', async () => {
      // key.privateJwk has a `d`. Rejected outright.
      assert.throws(() => validatePublicJwk(key.privateJwk), /private key material/);
    });
    it('[OCA30] wrong kty is rejected', () => {
      assert.throws(() => validatePublicJwk({ ...key.publicJwk, kty: 'RSA' }), /kty/);
    });
    it('[OCA31] wrong crv is rejected', () => {
      assert.throws(() => validatePublicJwk({ ...key.publicJwk, crv: 'P-384' }), /crv/);
    });
    it('[OCA32] a malformed coordinate is rejected', () => {
      assert.throws(() => validatePublicJwk({ ...key.publicJwk, x: 'short' }), /coordinate/);
    });
    it('[OCA33] validatePublicJwkSet requires a non-empty keys array', () => {
      assert.throws(() => validatePublicJwkSet({ keys: [] }), /non-empty/);
      assert.throws(() => validatePublicJwkSet({}), /keys/);
      assert.throws(() => validatePublicJwkSet(null), /object/);
    });
    it('[OCA34] validatePublicJwkSet rejects a set containing a private key', () => {
      assert.throws(() => validatePublicJwkSet({ keys: [key.publicJwk, key.privateJwk] }), /private key material/);
    });
    it('[OCA35] computeThumbprint is stable and 43 base64url chars', () => {
      const t1 = computeThumbprint(validatePublicJwk(key.publicJwk));
      const t2 = computeThumbprint(validatePublicJwk(key.publicJwk));
      assert.equal(t1, t2);
      assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
    });
  });
});
