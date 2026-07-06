/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OAUTH-ISS] OAuth2 — issuer derivation from the `service:api` template.
 *
 * `service:api` is a per-user endpoint template; the issuer must be a
 * concrete URL. Regression test for the dnsLess live-deployment bug
 * where the discovery doc and the consent-UI `pryvApi` parameter
 * carried a literal `{username}` placeholder.
 */

const assert = require('node:assert/strict');
const { issuerFromConfig } = require('../src/issuer.ts');

function fakeConfig (values) {
  return { get: (key) => values[key] };
}

describe('[OAUTH-ISS] issuerFromConfig', () => {
  it('[OAUTH-ISS-1] dnsLess shape: strips the trailing /{username}/ path segment', () => {
    assert.equal(
      issuerFromConfig(fakeConfig({ 'service:api': 'https://demo.backloop.dev:2443/{username}/' })),
      'https://demo.backloop.dev:2443');
    assert.equal(
      issuerFromConfig(fakeConfig({ 'service:api': 'http://127.0.0.1:3000/{username}' })),
      'http://127.0.0.1:3000');
  });

  it('[OAUTH-ISS-2] multi-core shape (host placeholder): falls back to core:url', () => {
    assert.equal(
      issuerFromConfig(fakeConfig({
        'service:api': 'https://{username}.pryv.me/',
        'core:url': 'https://co1.pryv.me/'
      })),
      'https://co1.pryv.me');
  });

  it('[OAUTH-ISS-3] host placeholder without core:url yields empty (routes not mounted)', () => {
    assert.equal(
      issuerFromConfig(fakeConfig({ 'service:api': 'https://{username}.pryv.me/' })),
      '');
  });

  it('[OAUTH-ISS-4] concrete URL passes through, trailing slash trimmed', () => {
    assert.equal(
      issuerFromConfig(fakeConfig({ 'service:api': 'https://reg.pryv.me/' })),
      'https://reg.pryv.me');
  });

  it('[OAUTH-ISS-5] missing service:api yields empty', () => {
    assert.equal(issuerFromConfig(fakeConfig({})), '');
    assert.equal(issuerFromConfig(fakeConfig({ 'service:api': '' })), '');
  });
});
