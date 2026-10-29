/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const { consentUrlWarning, CONSENT_URL_WARNING } = require('../src/consentUrlCheck.ts');

function configOf (values) {
  return { get: (key) => values[key] };
}

describe('[OCUW] oauth.consentUrl boot warning', () => {
  it('[OCUW1] warns when the OAuth routes mount (an issuer is derivable) and the consent URL is missing or blank', () => {
    for (const consentUrl of [undefined, null, '', '   ']) {
      assert.equal(consentUrlWarning(configOf({ 'dnsLess:publicUrl': 'https://core.example.com/', 'oauth:consentUrl': consentUrl })),
        CONSENT_URL_WARNING, 'consentUrl=' + JSON.stringify(consentUrl));
    }
    assert.equal(consentUrlWarning(configOf({ 'service:api': 'https://{username}.example.com/', 'core:url': 'https://core1.example.com' })),
      CONSENT_URL_WARNING);
  });

  it('[OCUW2] says nothing when the consent URL is set', () => {
    assert.equal(consentUrlWarning(configOf({
      'dnsLess:publicUrl': 'https://core.example.com/',
      'oauth:consentUrl': 'https://account.example.com/oauth2-authorize',
    })), null);
  });

  it('[OCUW3] says nothing when the OAuth routes do not mount (no issuer)', () => {
    assert.equal(consentUrlWarning(configOf({})), null);
  });
});
