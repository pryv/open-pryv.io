/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-SIGSTATE] OAuth2 — signed URL-parameter state.
 *
 * Round-trip + tamper-resistance + clock-window tests. The signed
 * state carries the validated /oauth2/authorize parameters across the
 * core → consent UI (different domain) handoff.
 */

const assert = require('node:assert/strict');
const { signState, verifyState, stateKeyFromConfig, SIGNED_STATE_TTL_SECONDS } = require('../src/signedState.ts');

const KEY_A = 'admin-key-aaaa-bbbb';
const KEY_B = 'admin-key-different';
const SAMPLE = {
  clientId: 'myapp',
  redirectUri: 'https://app.example/cb',
  state: 'csrf-xyz',
  codeChallenge: 'cc-base64url',
  codeChallengeMethod: 'S256',
  scope: ['pryv:read', 'pryv:write'],
};

describe('[OAUTH-SIGSTATE] signed URL-parameter state', () => {
  describe('[OAUTH-SIGSTATE-RT] round-trip', () => {
    it('[OSS-RT1] sign + verify round-trip yields the same payload (+ iat/exp stamps)', () => {
      const now = 1_700_000_000;
      const token = signState(KEY_A, SAMPLE, now);
      const result = verifyState(KEY_A, token, now);
      assert.equal(result.ok, true);
      assert.equal(result.payload.clientId, 'myapp');
      assert.deepEqual(result.payload.scope, ['pryv:read', 'pryv:write']);
      assert.equal(result.payload.iat, now);
      assert.equal(result.payload.exp, now + SIGNED_STATE_TTL_SECONDS);
    });
    it('[OSS-RT2] optional userIdHint round-trips when present', () => {
      const now = 1_700_000_000;
      const token = signState(KEY_A, { ...SAMPLE, userIdHint: 'alice' }, now);
      const result = verifyState(KEY_A, token, now);
      assert.equal(result.ok, true);
      assert.equal(result.payload.userIdHint, 'alice');
    });
    it('[OSS-RT3] wire format is body.signature (two base64url parts joined by dot)', () => {
      const token = signState(KEY_A, SAMPLE);
      const parts = token.split('.');
      assert.equal(parts.length, 2);
      assert.match(parts[0], /^[A-Za-z0-9_-]+$/);
      assert.match(parts[1], /^[A-Za-z0-9_-]+$/);
    });
  });

  describe('[OAUTH-SIGSTATE-TAMPER] tamper resistance', () => {
    it('[OSS-T1] body byte mutation invalidates the signature', () => {
      const token = signState(KEY_A, SAMPLE);
      const [body, mac] = token.split('.');
      const mutated = (body[0] === 'A' ? 'B' : 'A') + body.slice(1) + '.' + mac;
      const result = verifyState(KEY_A, mutated);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'bad_signature');
    });
    it('[OSS-T2] signature byte mutation rejected', () => {
      const token = signState(KEY_A, SAMPLE);
      const [body, mac] = token.split('.');
      const mutatedMac = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1);
      const result = verifyState(KEY_A, body + '.' + mutatedMac);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'bad_signature');
    });
    it('[OSS-T3] different admin key rejects', () => {
      const token = signState(KEY_A, SAMPLE);
      const result = verifyState(KEY_B, token);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'bad_signature');
    });
    it('[OSS-T4] malformed token (no dot) → malformed', () => {
      assert.equal(verifyState(KEY_A, 'nodothere').reason, 'malformed');
    });
    it('[OSS-T5] malformed token (dot at start/end) → malformed', () => {
      assert.equal(verifyState(KEY_A, '.signature').reason, 'malformed');
      assert.equal(verifyState(KEY_A, 'body.').reason, 'malformed');
    });
    it('[OSS-T6] non-string input → malformed', () => {
      assert.equal(verifyState(KEY_A, null).reason, 'malformed');
      assert.equal(verifyState(KEY_A, 12345).reason, 'malformed');
    });
    it('[OSS-T7] signature-length mismatch is rejected before timingSafeEqual', () => {
      const token = signState(KEY_A, SAMPLE);
      const [body, mac] = token.split('.');
      const result = verifyState(KEY_A, body + '.' + mac.slice(0, -1));
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'bad_signature');
    });
    it('[OSS-T8] signature of the right character length with a non-ASCII character → bad_signature, no throw', () => {
      const [body] = signState(KEY_A, SAMPLE).split('.');
      // 43 characters, but 44 bytes once UTF-8 encoded.
      const result = verifyState(KEY_A, body + '.' + 'é' + 'a'.repeat(42));
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'bad_signature');
    });
    it('[OSS-T9] signature of the right character length with a surrogate pair → bad_signature, no throw', () => {
      const [body] = signState(KEY_A, SAMPLE).split('.');
      // The emoji is 2 UTF-16 code units (43 in total) and 4 UTF-8 bytes.
      const result = verifyState(KEY_A, body + '.' + '😀' + 'a'.repeat(41));
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'bad_signature');
    });
  });

  describe('[OAUTH-SIGSTATE-TIME] clock window', () => {
    it('[OSS-TM1] expired token (now ≥ exp) rejected', () => {
      const iat = 1_700_000_000;
      const token = signState(KEY_A, SAMPLE, iat);
      const result = verifyState(KEY_A, token, iat + SIGNED_STATE_TTL_SECONDS);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'expired');
    });
    it('[OSS-TM2] not-yet-valid (now < iat) rejected — minor clock-skew defence', () => {
      const iat = 1_700_000_000;
      const token = signState(KEY_A, SAMPLE, iat);
      const result = verifyState(KEY_A, token, iat - 10);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'not_yet_valid');
    });
    it('[OSS-TM3] valid right at iat boundary', () => {
      const iat = 1_700_000_000;
      const token = signState(KEY_A, SAMPLE, iat);
      assert.equal(verifyState(KEY_A, token, iat).ok, true);
    });
    it('[OSS-TM4] valid at exp - 1', () => {
      const iat = 1_700_000_000;
      const token = signState(KEY_A, SAMPLE, iat);
      assert.equal(verifyState(KEY_A, token, iat + SIGNED_STATE_TTL_SECONDS - 1).ok, true);
    });
  });

  describe('[OAUTH-SIGSTATE-ERR] input errors', () => {
    it('[OSS-E1] sign with an empty key throws', () => {
      assert.throws(() => signState('', SAMPLE), /signing secret must be a non-empty string/);
    });
    it('[OSS-E2] sign with a non-string key throws', () => {
      assert.throws(() => signState(null, SAMPLE), /signing secret must be a non-empty string/);
    });
  });

  describe('[OAUTH-SIGSTATE-KEY] key selection', () => {
    const cfg = (m) => ({ get: (k) => m[k] });
    it('[OSS-K1] oauth:stateKey when set, else auth:adminAccessKey, else empty', () => {
      assert.equal(stateKeyFromConfig(cfg({ 'oauth:stateKey': 'own', 'auth:adminAccessKey': 'adm' })), 'own');
      assert.equal(stateKeyFromConfig(cfg({ 'oauth:stateKey': '', 'auth:adminAccessKey': 'adm' })), 'adm');
      assert.equal(stateKeyFromConfig(cfg({ 'auth:adminAccessKey': 'adm' })), 'adm');
      assert.equal(stateKeyFromConfig(cfg({})), '');
    });
    it('[OSS-K2] a state signed with one key does not verify with the other', () => {
      const token = signState('own', SAMPLE);
      assert.equal(verifyState('own', token).ok, true);
      assert.deepEqual(verifyState('adm', token), { ok: false, reason: 'bad_signature' });
    });
  });
});
