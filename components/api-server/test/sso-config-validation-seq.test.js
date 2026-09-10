/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, assert */

/**
 * [SSOCFG] — boot-time validation of the third-party sign-in config.
 *
 * Pins the coupling that makes the no-downgrade handoff safe: the sign-in
 * callback hands the minted (non-MFA) session token to the auth app ONLY
 * through a one-time shared secret, never in the redirect URL, so
 * `sso.enabled` must not boot without `sharedSecrets.enabled`. Pure unit
 * tests over `checkSsoConfig`; `-seq` only because the api-server hooks run a
 * Platform integrity check (these tests touch no storage).
 */

describe('[SSOCFG] checkSsoConfig boot rules', () => {
  let checkSsoConfig;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ checkSsoConfig } = require('../../../config/plugins/config-validation.js'));
  });

  function fakeConfig (map) {
    return { get: (key) => map[key] };
  }

  function run (map) {
    const problems = [];
    checkSsoConfig(fakeConfig(map), problems);
    return problems;
  }

  it('[SCFG1] sso disabled → no problems even with shared secrets off', () => {
    assert.deepStrictEqual(run({ 'sso:enabled': false, 'sharedSecrets:enabled': false }), []);
  });

  it('[SCFG2] sso enabled with shared secrets on (default) → no shared-secrets problem', () => {
    // sharedSecrets:enabled undefined = default on; providers undefined = soft no-op.
    const problems = run({ 'sso:enabled': true });
    assert.strictEqual(problems.some((p) => JSON.stringify(p).includes('sharedSecrets')), false);
  });

  it('[SCFG3] sso enabled + sharedSecrets.enabled:false → refused at boot', () => {
    const problems = run({ 'sso:enabled': true, 'sharedSecrets:enabled': false });
    const hit = problems.find((p) => p.path && p.path[0] === 'sso' &&
      JSON.stringify(p).includes('sharedSecrets.enabled'));
    assert.ok(hit != null, 'expected a sso->sharedSecrets coupling problem, got ' + JSON.stringify(problems));
    assert.deepStrictEqual(hit.payload, { 'sharedSecrets.enabled': false });
  });

  it('[SCFG4] the pre-existing dns.active conflict still fires (regression)', () => {
    const problems = run({ 'sso:enabled': true, 'dns:active': true });
    assert.ok(problems.some((p) => JSON.stringify(p).includes('dns.active')),
      'dns.active conflict must still be reported');
  });

  it('[SCFG5] a landingPageURL carrying a fragment is refused (would corrupt the hand-off)', () => {
    const problems = run({ 'sso:enabled': true, 'sso:landingPageURL': 'https://auth.example/sso-signin#/route' });
    const hit = problems.find((p) => p.path && p.path[1] === 'landingPageURL');
    assert.ok(hit != null, 'expected a landingPageURL fragment problem, got ' + JSON.stringify(problems));
  });
});
