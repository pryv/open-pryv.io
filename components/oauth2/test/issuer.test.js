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

  it('[OAUTH-ISS-6] explicit oauth:issuer overrides everything (reverse-proxy / custom domain)', () => {
    assert.equal(
      issuerFromConfig(fakeConfig({
        'oauth:issuer': 'https://auth.example.com/',
        'dnsLess:isActive': true,
        'dnsLess:publicUrl': 'http://127.0.0.1:3000/',
        'service:api': 'https://{username}.pryv.me/'
      })),
      'https://auth.example.com');
  });

  it('[OAUTH-ISS-7] publicUrl set: derives the issuer from it, ignoring an inconsistent service:api template', () => {
    // The exact in-process test-matrix shape: a multi-core service-info
    // template loaded into a dnsLess-configured core, no core:url. The
    // topology base URL wins, so /oauth2/* mounts instead of soft-degrading.
    assert.equal(
      issuerFromConfig(fakeConfig({
        'dnsLess:publicUrl': 'http://127.0.0.1:3000/',
        'service:api': 'https://{username}.pryv.me/'
      })),
      'http://127.0.0.1:3000');
  });

  it('[OAUTH-ISS-8] publicUrl wins regardless of the timing-dependent dnsLess:isActive flag', () => {
    // isActive false at this mount (pre-inject / spawned child) must NOT
    // gate the derivation — publicUrl presence alone decides.
    assert.equal(
      issuerFromConfig(fakeConfig({
        'dnsLess:isActive': false,
        'dnsLess:publicUrl': 'http://127.0.0.1:3000/',
        'service:api': 'https://{username}.pryv.me/'
      })),
      'http://127.0.0.1:3000');
  });

  it('[OAUTH-ISS-9] no publicUrl (real multi-core): falls through to the service:api template + core:url', () => {
    assert.equal(
      issuerFromConfig(fakeConfig({
        'dnsLess:isActive': false,
        'service:api': 'https://{username}.pryv.me/',
        'core:url': 'https://co1.pryv.me/'
      })),
      'https://co1.pryv.me');
  });
});
