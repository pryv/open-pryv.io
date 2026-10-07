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
 * [CVCI] the boot validator checks core.id (one lowercase DNS label) and, on
 * a multi-core deployment, core.url: peers send it the admin key, so it must
 * be an https origin unless cluster.allowInsecurePeerUrl is set.
 *
 * `-seq` because the api-server mocha hooks run a Platform DB integrity
 * check; the tests themselves do not touch storage.
 */

describe('[CVCI] config-validation core identity', () => {
  let validation;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    validation = require('../../../config/plugins/config-validation.js');
  });

  function check (values) {
    const problems = [];
    validation.checkCoreIdentity({ get: (key) => values[key] }, problems);
    return problems;
  }

  it('[CVCI1] valid ids and https core URLs are not problems', () => {
    assert.deepEqual(check({ 'core:id': 'single', 'core:isSingleCore': true, 'core:url': 'http://127.0.0.1:3000' }), []);
    assert.deepEqual(check({ 'core:id': 'use1', 'core:isSingleCore': false, 'core:url': 'https://use1.pryv.me' }), []);
  });

  it('[CVCI2] refuses a core id outside the grammar', () => {
    for (const id of ['Use1', 'core_a', 'a/b', 'x.y']) {
      const problems = check({ 'core:id': id, 'core:isSingleCore': true });
      assert.equal(problems.length, 1, id);
      assert.deepEqual(problems[0].path, ['core', 'id']);
    }
  });

  it('[CVCI3] refuses an http, credential-bearing or path-carrying multi-core core.url', () => {
    for (const url of ['http://core-a.example.com', 'https://u:p@core-a.example.com', 'https://core-a.example.com/x', 'https://core-a.example.com/#f']) {
      const problems = check({ 'core:id': 'core-a', 'core:isSingleCore': false, 'core:url': url });
      assert.equal(problems.length, 1, url);
      assert.deepEqual(problems[0].path, ['core', 'url']);
    }
  });

  it('[CVCI4] http is accepted with cluster.allowInsecurePeerUrl (development and test clusters)', () => {
    assert.deepEqual(check({
      'core:id': 'core-a', 'core:isSingleCore': false, 'core:url': 'http://127.0.0.1:3001', 'cluster:allowInsecurePeerUrl': true
    }), []);
  });
});
