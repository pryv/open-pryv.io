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
 * [CVAD] the boot validator checks account.autoDeletion: malformed values and
 * an inactivity preset with access tracking off refuse the boot; a preset
 * that cannot send its reminders is a boot warning.
 *
 * `-seq` because the api-server mocha hooks run a Platform DB integrity
 * check; the tests themselves do not touch storage.
 */

describe('[CVAD] config-validation account.autoDeletion', () => {
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

  async function report (overrides) {
    return await withInjectedConfig(overrides, async () => {
      const config = getConfigUnsafe(true);
      const problems = (await validation.validate(config)).filter((p) => p.path[0] === 'account' && p.path[1] === 'autoDeletion');
      const warnings = validation.collectWarnings(config).filter((w) => w.includes('account.autoDeletion'));
      return { problems, warnings };
    });
  }

  it('[CVAD1] the shipped defaults pass with no warning', async () => {
    assert.deepStrictEqual(await report({}), { problems: [], warnings: [] });
  });

  it('[CVAD2] a malformed value refuses the boot, naming the key', async () => {
    const { problems } = await report({ account: { autoDeletion: { sweepIntervalMs: 60 } } });
    assert.strictEqual(problems.length, 1);
    assert.deepStrictEqual(problems[0].path, ['account', 'autoDeletion', 'sweepIntervalMs']);
    assert.match(problems[0].message, /^account\.autoDeletion: sweepIntervalMs must be a number of milliseconds/);
  });

  it('[CVAD3] an inactivity preset with access tracking off refuses the boot', async () => {
    const { problems } = await report({ accessTracking: { isActive: false }, account: { autoDeletion: { inactivity: { defaultDays: 365 } } } });
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0].message, /accessTracking\.isActive is false/);
  });

  it('[CVAD4] a preset without the account app URL is a warning', async () => {
    const { problems, warnings } = await report({ service: { account: null }, account: { autoDeletion: { inactivity: { defaultDays: 365 } } } });
    assert.deepStrictEqual(problems, []);
    assert.ok(warnings.some((w) => /service\.account/.test(w)), JSON.stringify(warnings));
  });
});
