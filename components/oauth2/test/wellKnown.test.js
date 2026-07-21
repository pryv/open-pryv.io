/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-WK] OAuth2 — .well-known/oauth-authorization-server tests.
 */

const assert = require('node:assert/strict');
const { buildDiscoveryDocument, handleWellKnown } = require('../src/wellKnown.ts');

describe('[OAUTH-WK] discovery document', () => {
  describe('[OAUTH-WK-1] buildDiscoveryDocument', () => {
    it('[OAUTH-WK-1a] builds the canonical RFC 8414 shape', () => {
      const doc = buildDiscoveryDocument({
        issuer: 'https://reg.pryv.me',
        scopesSupported: ['pryv:read', 'pryv:write', 'pryv:manage'],
      });
      assert.equal(doc.issuer, 'https://reg.pryv.me');
      assert.equal(doc.authorization_endpoint, 'https://reg.pryv.me/oauth2/authorize');
      assert.equal(doc.token_endpoint, 'https://reg.pryv.me/oauth2/token');
      assert.deepEqual(doc.scopes_supported, ['pryv:read', 'pryv:write', 'pryv:manage']);
      assert.deepEqual(doc.response_types_supported, ['code']);
      assert.deepEqual(doc.grant_types_supported, ['authorization_code']);
      assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
      assert.equal(doc.authorization_response_iss_parameter_supported, true);
      assert.deepEqual(doc.dpop_signing_alg_values_supported, ['ES256']);
    });
    it('[OAUTH-WK-1b] trims trailing slash on issuer', () => {
      const doc = buildDiscoveryDocument({
        issuer: 'https://reg.pryv.me/',
        scopesSupported: [],
      });
      assert.equal(doc.issuer, 'https://reg.pryv.me');
      assert.equal(doc.token_endpoint, 'https://reg.pryv.me/oauth2/token');
    });
    it('[OAUTH-WK-1c] grantTypesSupported override is honoured', () => {
      const doc = buildDiscoveryDocument({
        issuer: 'https://x',
        scopesSupported: [],
        grantTypesSupported: ['authorization_code', 'refresh_token', 'client_credentials'],
      });
      assert.deepEqual(doc.grant_types_supported, ['authorization_code', 'refresh_token', 'client_credentials']);
    });
    it('[OAUTH-WK-1d] no plain in code_challenge_methods (RFC 9700 §2.1.1)', () => {
      const doc = buildDiscoveryDocument({ issuer: 'https://x', scopesSupported: [] });
      assert.ok(!doc.code_challenge_methods_supported.includes('plain'));
    });
    it('[OAUTH-WK-1e] no implicit / RoPC in grant_types', () => {
      const doc = buildDiscoveryDocument({ issuer: 'https://x', scopesSupported: [] });
      assert.ok(!doc.grant_types_supported.includes('implicit'));
      assert.ok(!doc.grant_types_supported.includes('password'));
    });
  });

  describe('[OAUTH-WK-2] handleWellKnown', () => {
    function fakeRes () {
      const headers = {};
      let body = ''; let statusCode = 0;
      return {
        setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
        end: (b) => { body = b; },
        get statusCode () { return statusCode; },
        set statusCode (v) { statusCode = v; },
        getHeader: (k) => headers[k.toLowerCase()],
        getBody: () => body,
      };
    }
    it('[OAUTH-WK-2a] emits 200 + JSON + Cache-Control + CORS', () => {
      const handler = handleWellKnown({ issuer: 'https://x', scopesSupported: ['pryv:read'] });
      const res = fakeRes();
      handler({}, res);
      assert.equal(res.statusCode, 200);
      assert.match(res.getHeader('content-type'), /application\/json/);
      assert.equal(res.getHeader('cache-control'), 'public, max-age=300');
      assert.equal(res.getHeader('access-control-allow-origin'), '*');
      const parsed = JSON.parse(res.getBody());
      assert.equal(parsed.issuer, 'https://x');
    });
  });
});
