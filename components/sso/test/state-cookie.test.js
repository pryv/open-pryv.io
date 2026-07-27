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
  signStateCookie, verifyStateCookie, cookieOptions,
  STATE_COOKIE_NAME, STATE_COOKIE_PATH, STATE_COOKIE_TTL_SECONDS
} = require('../src/stateCookie.ts');

const ADMIN = 'operator-admin-key-abc123';
const payload = { provider: 'google', state: 'st-123', nonce: 'nc-456', pkceVerifier: 'pkce-verifier-789' };

describe('[SSOSC] SSO state cookie', () => {
  it('[SSOSC1] sign → verify round-trips the payload', () => {
    const now = 1_000_000;
    const value = signStateCookie(ADMIN, payload, now);
    const res = verifyStateCookie(ADMIN, value, now + 5);
    assert.equal(res.ok, true);
    assert.equal(res.payload.provider, 'google');
    assert.equal(res.payload.state, 'st-123');
    assert.equal(res.payload.nonce, 'nc-456');
    assert.equal(res.payload.pkceVerifier, 'pkce-verifier-789');
    assert.equal(res.payload.exp - res.payload.iat, STATE_COOKIE_TTL_SECONDS);
  });

  it('[SSOSC2] a tampered body fails on the signature', () => {
    const now = 1_000_000;
    const value = signStateCookie(ADMIN, payload, now);
    const [, mac] = value.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, provider: 'evil', iat: now, exp: now + 600 }))
      .toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const res = verifyStateCookie(ADMIN, forgedBody + '.' + mac, now + 5);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad_signature');
  });

  it('[SSOSC3] a different admin key rejects the signature', () => {
    const now = 1_000_000;
    const value = signStateCookie(ADMIN, payload, now);
    const res = verifyStateCookie('a-different-admin-key', value, now + 5);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad_signature');
  });

  it('[SSOSC4] an expired cookie is rejected', () => {
    const now = 1_000_000;
    const value = signStateCookie(ADMIN, payload, now, 600);
    const res = verifyStateCookie(ADMIN, value, now + 601);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'expired');
  });

  it('[SSOSC5] a not-yet-valid cookie (clock skew backwards) is rejected', () => {
    const now = 1_000_000;
    const value = signStateCookie(ADMIN, payload, now);
    const res = verifyStateCookie(ADMIN, value, now - 10);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not_yet_valid');
  });

  it('[SSOSC6] malformed values (no dot / empty / non-string) are rejected', () => {
    for (const bad of ['', 'no-dot-here', '.', 'body.', '.mac', 42, null, undefined]) {
      const res = verifyStateCookie(ADMIN, bad, 1_000_000);
      assert.equal(res.ok, false, `expected reject for ${JSON.stringify(bad)}`);
      assert.equal(res.reason, 'malformed');
    }
  });

  it('[SSOSC7] a validly-signed but shape-incomplete payload is malformed', () => {
    // Sign a payload missing the required string fields — signature is valid,
    // but verify must still reject on the shape check (fail closed).
    const now = 1_000_000;
    const value = signStateCookie(ADMIN, { provider: 'google', state: 'x', nonce: 'y', pkceVerifier: 'z' }, now);
    const [, mac] = value.split('.');
    const thinBody = Buffer.from(JSON.stringify({ provider: 'google', iat: now, exp: now + 600 }))
      .toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    // Re-sign the thin body so the signature is valid but the shape is wrong.
    const crypto = require('node:crypto');
    const key = crypto.createHmac('sha256', ADMIN).update(Buffer.from('pryv-sso-state-v1')).digest();
    const thinMac = crypto.createHmac('sha256', key).update(thinBody).digest('base64')
      .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    assert.notEqual(mac, thinMac); // sanity: different body → different mac
    const res = verifyStateCookie(ADMIN, thinBody + '.' + thinMac, now + 5);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'malformed');
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
