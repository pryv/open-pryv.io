/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [SSOSC] SSO signed state cookie — sign/verify round-trip + tamper / expiry /
 * shape guards. Pure crypto, no core boot. The cookie binds an IdP round-trip
 * (provider + state + nonce + PKCE verifier); a forged or stale cookie must
 * fail closed so the callback cannot be replayed or cross-bound.
 */

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);

const {
  signStateCookie, verifyStateCookie, cookieOptions, ssoStateKeyFromConfig,
  STATE_COOKIE_NAME, STATE_COOKIE_PATH, STATE_COOKIE_TTL_SECONDS,
  RETURN_STATE_MAX_CHARS
} = require('../src/stateCookie.ts');

const STATE_KEY = 'sso-state-key-abc123';
const payload = { provider: 'google', state: 'st-123', nonce: 'nc-456', pkceVerifier: 'pkce-verifier-789' };

describe('[SSOSC] SSO state cookie', () => {
  it('[SSOSC1] sign → verify round-trips the payload', () => {
    const now = 1_000_000;
    const value = signStateCookie(STATE_KEY, payload, now);
    const res = verifyStateCookie(STATE_KEY, value, now + 5);
    assert.equal(res.ok, true);
    assert.equal(res.payload.provider, 'google');
    assert.equal(res.payload.state, 'st-123');
    assert.equal(res.payload.nonce, 'nc-456');
    assert.equal(res.payload.pkceVerifier, 'pkce-verifier-789');
    assert.equal(res.payload.exp - res.payload.iat, STATE_COOKIE_TTL_SECONDS);
  });

  it('[SSOSC2] a tampered body fails on the signature', () => {
    const now = 1_000_000;
    const value = signStateCookie(STATE_KEY, payload, now);
    const [, mac] = value.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, provider: 'evil', iat: now, exp: now + 600 }))
      .toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const res = verifyStateCookie(STATE_KEY, forgedBody + '.' + mac, now + 5);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad_signature');
  });

  it('[SSOSC3] a different secret rejects the signature', () => {
    const now = 1_000_000;
    const value = signStateCookie(STATE_KEY, payload, now);
    const res = verifyStateCookie('a-different-secret', value, now + 5);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad_signature');
  });

  it('[SSOSC13] the key is sso:stateKey when set, else auth:adminAccessKey, else empty', () => {
    const cfg = (values) => ({ get: (key) => values[key] });
    assert.equal(ssoStateKeyFromConfig(cfg({ 'sso:stateKey': 'own', 'auth:adminAccessKey': 'adm', 'oauth:stateKey': 'oa' })), 'own');
    assert.equal(ssoStateKeyFromConfig(cfg({ 'sso:stateKey': '', 'auth:adminAccessKey': 'adm', 'oauth:stateKey': 'oa' })), 'adm');
    assert.equal(ssoStateKeyFromConfig(cfg({ 'auth:adminAccessKey': 'adm' })), 'adm');
    assert.equal(ssoStateKeyFromConfig(cfg({ 'sso:stateKey': 42, 'auth:adminAccessKey': 'adm' })), 'adm');
    assert.equal(ssoStateKeyFromConfig(cfg({})), '');
  });

  it('[SSOSC14] once sso:stateKey is set, a cookie signed with the admin key is refused; until then it verifies', () => {
    const now = 1_000_000;
    const adminKey = 'operator-admin-key-abc123';
    const adminSigned = signStateCookie(adminKey, payload, now);
    const fallback = ssoStateKeyFromConfig({ get: (key) => ({ 'auth:adminAccessKey': adminKey })[key] });
    assert.equal(verifyStateCookie(fallback, adminSigned, now + 5).ok, true);
    const own = ssoStateKeyFromConfig({ get: (key) => ({ 'sso:stateKey': STATE_KEY, 'auth:adminAccessKey': adminKey })[key] });
    const res = verifyStateCookie(own, adminSigned, now + 5);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad_signature');
    assert.equal(verifyStateCookie(own, signStateCookie(STATE_KEY, payload, now), now + 5).ok, true);
  });

  it('[SSOSC15] an empty secret signs nothing and verifies nothing', () => {
    assert.throws(() => signStateCookie('', payload), /secret must be a non-empty string/);
    const value = signStateCookie(STATE_KEY, payload, 1_000_000);
    assert.equal(verifyStateCookie('', value, 1_000_005).reason, 'malformed');
  });

  it('[SSOSC4] an expired cookie is rejected', () => {
    const now = 1_000_000;
    const value = signStateCookie(STATE_KEY, payload, now, 600);
    const res = verifyStateCookie(STATE_KEY, value, now + 601);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'expired');
  });

  it('[SSOSC5] a not-yet-valid cookie (clock skew backwards) is rejected', () => {
    const now = 1_000_000;
    const value = signStateCookie(STATE_KEY, payload, now);
    const res = verifyStateCookie(STATE_KEY, value, now - 10);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not_yet_valid');
  });

  it('[SSOSC6] malformed values (no dot / empty / non-string) are rejected', () => {
    for (const bad of ['', 'no-dot-here', '.', 'body.', '.mac', 42, null, undefined]) {
      const res = verifyStateCookie(STATE_KEY, bad, 1_000_000);
      assert.equal(res.ok, false, `expected reject for ${JSON.stringify(bad)}`);
      assert.equal(res.reason, 'malformed');
    }
  });

  it('[SSOSC7] a validly-signed but shape-incomplete payload is malformed', () => {
    // Sign a payload missing the required string fields — signature is valid,
    // but verify must still reject on the shape check (fail closed).
    const now = 1_000_000;
    const value = signStateCookie(STATE_KEY, { provider: 'google', state: 'x', nonce: 'y', pkceVerifier: 'z' }, now);
    const [, mac] = value.split('.');
    const thinBody = Buffer.from(JSON.stringify({ provider: 'google', iat: now, exp: now + 600 }))
      .toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    // Re-sign the thin body so the signature is valid but the shape is wrong.
    const crypto = require('node:crypto');
    const key = crypto.createHmac('sha256', STATE_KEY).update(Buffer.from('pryv-sso-state-v1')).digest();
    const thinMac = crypto.createHmac('sha256', key).update(thinBody).digest('base64')
      .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    assert.notEqual(mac, thinMac); // sanity: different body → different mac
    const res = verifyStateCookie(STATE_KEY, thinBody + '.' + thinMac, now + 5);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'malformed');
  });

  // Re-sign an arbitrary body with the real key: the signature is valid, so the
  // only thing that can reject it is the payload shape check.
  function signBody (body) {
    const crypto = require('node:crypto');
    const key = crypto.createHmac('sha256', STATE_KEY).update(Buffer.from('pryv-sso-state-v1')).digest();
    const mac = crypto.createHmac('sha256', key).update(body).digest('base64')
      .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return body + '.' + mac;
  }

  function encodeBody (obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64')
      .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  it('[SSOSC9] an opaque returnState round-trips unchanged', () => {
    const now = 1_000_000;
    const returnState = 'returnURL=https%3A%2F%2Fapp.example%2Fcb&state=abc&h=n1';
    const value = signStateCookie(STATE_KEY, { ...payload, returnState }, now);
    const res = verifyStateCookie(STATE_KEY, value, now + 5);
    assert.equal(res.ok, true);
    assert.equal(res.payload.returnState, returnState);
  });

  it('[SSOSC10] a payload without returnState still verifies (older cookie / start without state)', () => {
    const now = 1_000_000;
    const value = signStateCookie(STATE_KEY, payload, now);
    const res = verifyStateCookie(STATE_KEY, value, now + 5);
    assert.equal(res.ok, true);
    assert.equal(res.payload.returnState, undefined);
  });

  it('[SSOSC11] a validly-signed but out-of-shape returnState is malformed', () => {
    const now = 1_000_000;
    const base = { ...payload, iat: now, exp: now + 600 };
    const bad = [
      42,
      'x'.repeat(RETURN_STATE_MAX_CHARS + 1),
      'has a space',
      'has#a#hash',
      'quote"inside',
      'semi;colon'
    ];
    for (const returnState of bad) {
      const res = verifyStateCookie(STATE_KEY, signBody(encodeBody({ ...base, returnState })), now + 5);
      assert.equal(res.ok, false, `expected reject for ${JSON.stringify(returnState)}`);
      assert.equal(res.reason, 'malformed');
    }
    // Boundary: exactly at the limit is accepted.
    const atLimit = 'x'.repeat(RETURN_STATE_MAX_CHARS);
    const ok = verifyStateCookie(STATE_KEY, signBody(encodeBody({ ...base, returnState: atLimit })), now + 5);
    assert.equal(ok.ok, true);
    assert.equal(ok.payload.returnState, atLimit);
  });

  it('[SSOSC12] a signature of the right character length with non-ASCII characters is rejected, no throw', () => {
    const now = 1_000_000;
    const [body] = signStateCookie(STATE_KEY, payload, now).split('.');
    // Each candidate is 43 UTF-16 code units but longer once UTF-8 encoded.
    for (const mac of ['é' + 'a'.repeat(42), '😀' + 'a'.repeat(41)]) {
      const res = verifyStateCookie(STATE_KEY, body + '.' + mac, now + 5);
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'bad_signature');
    }
  });

  it('[SSOSC8] cookie attributes are HttpOnly + Secure + SameSite=Lax + path-scoped', () => {
    const opts = cookieOptions();
    assert.equal(opts.httpOnly, true);
    assert.equal(opts.secure, true);
    assert.equal(opts.sameSite, 'lax');
    assert.equal(opts.path, STATE_COOKIE_PATH);
    assert.equal(opts.maxAge, STATE_COOKIE_TTL_SECONDS * 1000);
    assert.equal(STATE_COOKIE_NAME, 'pryv_sso_state');
  });
});
