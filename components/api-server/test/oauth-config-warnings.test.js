/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [CVOA] Boot checks of the OAuth settings. Warnings (never stop the boot):
 * a short or shared state key, a removed key still set, an unusable or too
 * long id_token lifetime. Problems (refuse the boot): no state key while a
 * consent page is set, a set state key that is no secret.
 */

const assert = require('node:assert/strict');
const { collectWarnings, checkOptionalSecrets, checkRequiredWhen, validate } = require('../../../config/plugins/config-validation.js');

/** A config with mail off (no unrelated warning) plus the given values. */
function config (values) {
  const all = { services: { email: { enabled: false } }, auth: { adminAccessKey: 'admin-key-'.repeat(4) }, ...values };
  const get = (key) => key == null ? all : key.split(':').reduce((node, seg) => (node == null ? undefined : node[seg]), all);
  return { get, getScopeAndValue: (key) => ({ value: get(key), scope: 'override-file', info: '' }) };
}

const oauthWarnings = (values) => collectWarnings(config(values)).filter((w) => w.includes("'oauth."));

describe('[CVOA] OAuth boot warnings', () => {
  it('[CVOA1] no state key is never a warning: with a consent page it is a boot problem, without one it is unused', () => {
    assert.deepEqual(oauthWarnings({ oauth: { consentUrl: 'https://account.example.com/oauth2-authorize', stateKey: '' } }), []);
    assert.deepEqual(oauthWarnings({ oauth: { consentUrl: '', stateKey: '' } }), []);
    assert.deepEqual(oauthWarnings({}), []);
  });

  it('[CVOA7] with a consent page, a missing or weak state key refuses the boot (one problem, no value echoed); without one it is optional', () => {
    const consentUrl = 'https://account.example.com/oauth2-authorize';
    const stateKeyProblems = (oauth) => { const p = []; checkRequiredWhen(config({ oauth }), p); checkOptionalSecrets(config({ oauth }), p); return p.filter((x) => x.payload?.path === 'oauth:stateKey'); };
    for (const stateKey of [undefined, '', 'REPLACE_ME', '$' + '{OAUTH_STATE_KEY}', 42]) {
      const p = stateKeyProblems({ consentUrl, stateKey });
      assert.equal(p.length, 1, JSON.stringify(stateKey));
      assert.match(p[0].message, /required configuration key 'oauth:stateKey' is missing or unset/);
      assert.match(p[0].message, /openssl rand -base64 32/);
    }
    for (const stateKey of ['changeme', 'override me']) {
      const p = stateKeyProblems({ consentUrl, stateKey });
      assert.equal(p.length, 1, stateKey);
      assert.match(p[0].message, /secret 'oauth:stateKey' is a placeholder value/);
      assert.deepEqual(p[0].payload, { path: 'oauth:stateKey', weakSecret: true });
      assert.ok(!p[0].message.includes(stateKey), 'the message does not echo the value');
    }
    assert.deepEqual(stateKeyProblems({ consentUrl, stateKey: 'k3yV4lue-' + 'a1B2c3D4e5'.repeat(4) }), []);
    assert.deepEqual(stateKeyProblems({ consentUrl: '', stateKey: '' }), []);
    assert.deepEqual(stateKeyProblems({ stateKey: undefined }), []);
    // In production a short key is refused as for the other required secrets.
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.match(stateKeyProblems({ consentUrl, stateKey: 'short-key' })[0].message, /secret 'oauth:stateKey' is shorter than 16 characters/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('[CVOA8] the full boot validation names a missing state key when a consent page is set', async () => {
    const problems = await validate(config({ oauth: { consentUrl: 'https://account.example.com/oauth2-authorize' } }));
    assert.equal(problems.filter((p) => p.payload?.path === 'oauth:stateKey').length, 1, JSON.stringify(problems.map((p) => p.message)));
    const without = await validate(config({ oauth: { consentUrl: '' } }));
    assert.equal(without.filter((p) => p.payload?.path === 'oauth:stateKey').length, 0);
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
    // Above the bound: clamped, and said so.
    assert.match(oauthWarnings({ oauth: { idTokenTTL: 3000000 } })[0], /'oauth\.idTokenTTL' is 3000000 s, above the 3600 s maximum/);
    assert.deepEqual(oauthWarnings({ oauth: { idTokenTTL: 3600 } }), []);
    const yaml = require('js-yaml');
    const fs = require('node:fs');
    const defaults = yaml.load(fs.readFileSync(new URL('../../../config/default-config.yml', import.meta.url), 'utf8'));
    assert.equal(defaults.oauth.idTokenTTL, 300);
    assert.equal(Object.hasOwn(defaults.oauth, 'audAllowList'), false);
    assert.deepEqual(oauthWarnings({ oauth: defaults.oauth }), []);
  });

  it('[CVOA6] a refresh retire grace below the reuse grace is reported; equal or above is silent', () => {
    const w = oauthWarnings({ oauth: { refreshRetireGraceSeconds: 5, refreshReuseGraceSeconds: 10 } });
    assert.equal(w.length, 1, JSON.stringify(w));
    assert.match(w[0], /'oauth\.refreshRetireGraceSeconds' \(5\) is below 'oauth\.refreshReuseGraceSeconds' \(10\)/);
    assert.deepEqual(oauthWarnings({ oauth: { refreshRetireGraceSeconds: 10, refreshReuseGraceSeconds: 10 } }), []);
    // Only the reuse grace set, above the retire default (60).
    assert.equal(oauthWarnings({ oauth: { refreshReuseGraceSeconds: 120 } }).length, 1);
  });

  it('[CVOA5] a set state key that is a placeholder, an unexpanded reference or a stand-in refuses the boot; empty or random passes', () => {
    const problemsFor = (stateKey) => { const p = []; checkOptionalSecrets(config({ oauth: { stateKey } }), p); return p; };
    for (const stateKey of ['REPLACE_ME', '$' + '{OAUTH_STATE_KEY}', 'changeme', 'override me', 42]) {
      const p = problemsFor(stateKey);
      assert.equal(p.length, 1, JSON.stringify(stateKey));
      assert.match(p[0].message, /secret 'oauth:stateKey' (is a placeholder value|must be a string)/);
      assert.deepEqual(p[0].payload, { path: 'oauth:stateKey', weakSecret: true });
    }
    for (const stateKey of ['', undefined, 'k3yV4lue-' + 'a1B2c3D4e5'.repeat(4)]) {
      assert.deepEqual(problemsFor(stateKey), [], JSON.stringify(stateKey));
    }
  });
});
