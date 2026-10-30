/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [CVOA] Boot warnings of the OAuth settings: the consent-state key still
 * borrowed from the admin key, a weak or shared state key, a removed key still
 * set, an unusable id_token lifetime. Warnings never stop the boot.
 */

const assert = require('node:assert/strict');
const { collectWarnings } = require('../../../config/plugins/config-validation.js');

/** A config with mail off (no unrelated warning) plus the given values. */
function config (values) {
  const all = { services: { email: { enabled: false } }, auth: { adminAccessKey: 'admin-key-'.repeat(4) }, ...values };
  const get = (key) => key.split(':').reduce((node, seg) => (node == null ? undefined : node[seg]), all);
  return { get, getScopeAndValue: (key) => ({ value: get(key), scope: 'override-file', info: '' }) };
}

const oauthWarnings = (values) => collectWarnings(config(values)).filter((w) => w.includes("'oauth."));

describe('[CVOA] OAuth boot warnings', () => {
  it('[CVOA1] no state key while the consent flow is configured: one warning naming the fallback; none without a consent page', () => {
    const w = oauthWarnings({ oauth: { consentUrl: 'https://account.example.com/oauth2-authorize', stateKey: '' } });
    assert.equal(w.length, 1, JSON.stringify(w));
    assert.match(w[0], /'oauth\.stateKey' is not set: OAuth consent states are signed with a key derived from 'auth\.adminAccessKey'/);
    assert.match(w[0], /a later release will require it/);
    assert.deepEqual(oauthWarnings({ oauth: { consentUrl: '', stateKey: '' } }), []);
    assert.deepEqual(oauthWarnings({}), []);
  });

  it('[CVOA2] a state key equal to the admin key, or short, is reported; a long own key is silent', () => {
    const consentUrl = 'https://account.example.com/oauth2-authorize';
    assert.match(oauthWarnings({ oauth: { consentUrl, stateKey: 'admin-key-'.repeat(4) } })[0], /equals 'auth\.adminAccessKey'/);
    assert.match(oauthWarnings({ oauth: { consentUrl, stateKey: 'short' } })[0], /shorter than 32 characters/);
    assert.deepEqual(oauthWarnings({ oauth: { consentUrl, stateKey: 'k'.repeat(43) } }), []);
  });

  it('[CVOA3] the removed audAllowList key is reported when present, even empty', () => {
    for (const audAllowList of [[], ['https://x.example']]) {
      const w = oauthWarnings({ oauth: { audAllowList } });
      assert.equal(w.length, 1, JSON.stringify(w));
      assert.match(w[0], /'oauth\.audAllowList' is no longer read and can be removed/);
    }
  });

  it('[CVOA4] an id_token lifetime that is not a positive integer is reported; the shipped default is silent', () => {
    for (const idTokenTTL of [0, -5, 'abc', 1.5]) {
      assert.match(oauthWarnings({ oauth: { idTokenTTL } })[0], /'oauth\.idTokenTTL' is .*300 is used/, String(idTokenTTL));
    }
    const yaml = require('js-yaml');
    const fs = require('node:fs');
    const defaults = yaml.load(fs.readFileSync(new URL('../../../config/default-config.yml', import.meta.url), 'utf8'));
    assert.equal(defaults.oauth.idTokenTTL, 300);
    assert.equal(Object.hasOwn(defaults.oauth, 'audAllowList'), false);
    assert.deepEqual(oauthWarnings({ oauth: defaults.oauth }), []);
  });
});
