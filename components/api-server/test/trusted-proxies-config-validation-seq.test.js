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
 * [CVTP] the boot validator checks http.trustedProxies: an entry that is not
 * an IP, a CIDR or a known name refuses the boot; leaving loopback out while
 * HFS workers run is a warning (the core's own HFS forwarding would then be
 * recorded as 127.0.0.1). The resolver itself is covered by [CLIP].
 *
 * `-seq` because the api-server mocha hooks run a Platform DB integrity
 * check; the tests themselves do not touch storage.
 */

describe('[CVTP] config-validation http.trustedProxies', () => {
  let validation;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    validation = require('../../../config/plugins/config-validation.js');
  });

  function fakeConfig (trustedProxies, hfsWorkers = 1) {
    const values = { 'http:trustedProxies': trustedProxies, 'cluster:hfsWorkers': hfsWorkers };
    return { get: (key) => values[key] };
  }

  it('[CVT1] valid lists are not problems', () => {
    for (const list of [['loopback'], [], ['loopback', '10.0.0.0/8', '2001:db8::/32', '203.0.113.7', 'uniquelocal']]) {
      const problems = [];
      validation.checkTrustedProxies(fakeConfig(list), problems);
      assert.deepStrictEqual(problems, [], JSON.stringify(list));
    }
  });

  it('[CVT2] a malformed entry or a non-list is a located problem', () => {
    let problems = [];
    validation.checkTrustedProxies(fakeConfig(['loopback', '10.0.0.0/99']), problems);
    assert.strictEqual(problems.length, 1, JSON.stringify(problems));
    assert.deepStrictEqual(problems[0].path, ['http', 'trustedProxies', 1]);
    problems = [];
    validation.checkTrustedProxies(fakeConfig('loopback'), problems);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0].message, /must be a list/);
    problems = [];
    validation.checkTrustedProxies(fakeConfig([42]), problems);
    assert.match(problems[0].message, /non-empty string/);
  });

  it('[CVT3] loopback left out while HFS workers run is a warning only', () => {
    const problems = [];
    validation.checkTrustedProxies(fakeConfig(['10.0.0.0/8'], 1), problems);
    assert.deepStrictEqual(problems, []);
    const warnings = validation.collectWarnings(fakeConfig(['10.0.0.0/8'], 1));
    assert.ok(warnings.some((w) => /does not include loopback/.test(w)), JSON.stringify(warnings));
    const noHfs = validation.collectWarnings(fakeConfig(['10.0.0.0/8'], 0));
    assert.ok(!noHfs.some((w) => /does not include loopback/.test(w)));
  });

  it('[CVT4] the running test configuration validates', async () => {
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    const problems = [];
    validation.checkTrustedProxies(config, problems);
    assert.deepStrictEqual(problems, []);
  });
});
