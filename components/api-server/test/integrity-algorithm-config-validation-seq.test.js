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
 * [CVIA] the boot validator refuses md5 and sha1 (and any value outside the
 * accepted list) for integrity.algorithm, the hash of the checksums of
 * events, accesses and attachments.
 *
 * `-seq` because the api-server mocha hooks run a Platform DB integrity
 * check; the tests themselves do not touch storage.
 */

describe('[CVIA] config-validation integrity.algorithm', () => {
  let validation;
  let getConfigUnsafe;
  let withInjectedConfig;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    validation = require('../../../config/plugins/config-validation.js');
    getConfigUnsafe = require('@pryv/boiler').getConfigUnsafe;
    withInjectedConfig = require('test-helpers').withInjectedConfig;
  });

  async function algorithmProblems (algorithm) {
    return await withInjectedConfig({ integrity: { algorithm } }, async () => {
      const problems = await validation.validate(getConfigUnsafe(true));
      return problems.filter((p) => JSON.stringify(p.path) === JSON.stringify(['integrity', 'algorithm']));
    });
  }

  it('[CVIA1] md5 and sha1 refuse the boot, naming the accepted algorithms', async () => {
    for (const algorithm of ['md5', 'sha1']) {
      const problems = await algorithmProblems(algorithm);
      assert.strictEqual(problems.length, 1, algorithm);
      assert.match(problems[0].message, /sha256, sha512/);
      assert.match(problems[0].message, /checksums/);
    }
  });

  it('[CVIA2] sha256 and sha512 pass, an unknown value is refused', async () => {
    for (const algorithm of ['sha256', 'sha512']) {
      assert.deepStrictEqual(await algorithmProblems(algorithm), [], algorithm);
    }
    assert.strictEqual((await algorithmProblems('crc32')).length, 1);
  });
});
