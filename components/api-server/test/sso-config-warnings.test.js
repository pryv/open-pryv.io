/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [CVSS] Boot checks of the third-party sign-in state key. Warnings (never
 * stop the boot): the state-cookie key still borrowed from the admin key while
 * sign-in is enabled, a key shared with another secret, a short key. Problem
 * (refuses the boot): a set state key that is no secret.
 */

const assert = require('node:assert/strict');
const { collectWarnings, checkOptionalSecrets, validate } = require('../../../config/plugins/config-validation.js');

/** A config with mail off (no unrelated warning) plus the given values. */
function config (values) {
  const all = { services: { email: { enabled: false } }, auth: { adminAccessKey: 'admin-key-'.repeat(4) }, ...values };
  const get = (key) => key == null ? all : key.split(':').reduce((node, seg) => (node == null ? undefined : node[seg]), all);
  return { get, getScopeAndValue: (key) => ({ value: get(key), scope: 'override-file', info: '' }) };
}

const ssoWarnings = (values) => collectWarnings(config(values)).filter((w) => w.includes("'sso."));

describe('[CVSS] sign-in state key boot checks', () => {
  it('[CVSS1] a set state key that is a placeholder, an unexpanded reference or a stand-in refuses the boot; empty or random passes', () => {
    const problemsFor = (stateKey) => { const p = []; checkOptionalSecrets(config({ sso: { stateKey } }), p); return p; };
    for (const stateKey of ['REPLACE_ME', '$' + '{SSO_STATE_KEY}', 'changeme', 'override me', 42]) {
      const p = problemsFor(stateKey);
      assert.equal(p.length, 1, JSON.stringify(stateKey));
      assert.match(p[0].message, /secret 'sso:stateKey' (is a placeholder value|must be a string)/);
      assert.deepEqual(p[0].payload, { path: 'sso:stateKey', weakSecret: true });
    }
    for (const stateKey of ['', undefined, 'k3yV4lue-' + 'a1B2c3D4e5'.repeat(4)]) {
      assert.deepEqual(problemsFor(stateKey), [], JSON.stringify(stateKey));
    }
  });

  it('[CVSS2] the full boot validation reports a placeholder state key', async () => {
    const problems = await validate(config({ sso: { stateKey: 'REPLACE_ME' } }));
    assert.ok(problems.some((p) => p.payload && p.payload.path === 'sso:stateKey' && p.payload.weakSecret),
      JSON.stringify(problems.map((p) => p.message)));
  });

  it('[CVSS3] no state key while sign-in is enabled: one warning naming the fallback; none while disabled', () => {
    const w = ssoWarnings({ sso: { enabled: true, stateKey: '' } });
    assert.equal(w.length, 1, JSON.stringify(w));
    assert.match(w[0], /'sso\.stateKey' is not set: sign-in state cookies are signed with a key derived from 'auth\.adminAccessKey'/);
    assert.match(w[0], /a later release will require it/);
    assert.deepEqual(ssoWarnings({ sso: { enabled: false, stateKey: '' } }), []);
    assert.deepEqual(ssoWarnings({}), []);
  });

  it('[CVSS4] a state key equal to the admin key or the consent-state key, or short, is reported; a long own key is silent', () => {
    const shared = 'shared-key-'.repeat(4);
    assert.match(ssoWarnings({ sso: { enabled: true, stateKey: 'admin-key-'.repeat(4) } })[0], /equals 'auth\.adminAccessKey'/);
    assert.match(ssoWarnings({ sso: { enabled: true, stateKey: shared }, oauth: { stateKey: shared } })[0], /equals 'oauth\.stateKey'/);
    assert.match(ssoWarnings({ sso: { enabled: true, stateKey: 'short' } })[0], /shorter than 32 characters/);
    assert.deepEqual(ssoWarnings({ sso: { enabled: true, stateKey: 'k'.repeat(43) } }), []);
  });

  it('[CVSS5] the shipped defaults declare an empty state key and boot silent', () => {
    const yaml = require('js-yaml');
    const fs = require('node:fs');
    const defaults = yaml.load(fs.readFileSync(new URL('../../../config/default-config.yml', import.meta.url), 'utf8'));
    assert.equal(defaults.sso.stateKey, '');
    assert.deepEqual(ssoWarnings({ sso: defaults.sso }), []);
  });
});
