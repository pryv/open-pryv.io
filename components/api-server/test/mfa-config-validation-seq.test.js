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
 * [CVMF] the boot validator reports services.mfa problems (refusing the
 * boot) and warnings (logged). The rules themselves are covered by the
 * business unit tests [MCHK]; this pins the wiring into the plugin.
 *
 * `-seq` because the api-server mocha hooks run a Platform DB integrity
 * check; the tests themselves do not touch storage.
 */

describe('[CVMF] config-validation services.mfa', () => {
  let validation;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    validation = require('../../../config/plugins/config-validation.js');
  });

  function fakeConfig (mfa) {
    return { get: (key) => (key === 'services:mfa' ? mfa : undefined) };
  }

  it('[CVMF1] a setting that cannot work is a problem, prefixed and located', () => {
    const problems = [];
    validation.checkMfaConfig(fakeConfig({ active: true, defaultMethod: 'push' }), problems);
    assert.strictEqual(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0].message, /^MFA: defaultMethod "push"/);
    assert.deepStrictEqual(problems[0].path, ['services', 'mfa', 'defaultMethod']);
  });

  it('[CVMF2] a removed key is a warning, never a problem', () => {
    const problems = [];
    const config = fakeConfig({ active: true, attempts: { lockoutSeconds: 900 } });
    validation.checkMfaConfig(config, problems);
    assert.deepStrictEqual(problems, []);
    const warnings = validation.collectWarnings({ get: (key) => (key === 'services:mfa' ? { active: true, attempts: { lockoutSeconds: 900 } } : undefined) });
    assert.ok(warnings.some((w) => /lockoutSeconds is no longer read/.test(w)), JSON.stringify(warnings));
  });

  it('[CVMF3] the running test configuration validates without an MFA problem', async () => {
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    const problems = [];
    validation.checkMfaConfig(config, problems);
    assert.deepStrictEqual(problems, []);
  });
});
