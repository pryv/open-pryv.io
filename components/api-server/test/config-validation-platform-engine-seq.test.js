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
 * [CVPE] — boot-time topology guard for `storages.platform.engine`.
 *
 * Pure unit tests for `checkPlatformEngineTopology` in
 * `config/plugins/config-validation.js`. The PostgreSQL platform engine
 * is a single-core, dnsLess-only, full-PG-mode option (diskless shape);
 * any multi-core signal alongside it must refuse the boot with an
 * explicit message rather than silently breaking cross-core
 * registration uniqueness.
 *
 * `-seq` because the api-server mocha hooks run a Platform DB integrity
 * check; the tests themselves do not touch storage.
 */

describe('[CVPE] config-validation platform-engine topology', () => {
  let checkPlatformEngineTopology;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ checkPlatformEngineTopology } =
      require('../../../config/plugins/config-validation.js'));
  });

  function fakeConfig (map) {
    return {
      get: (key) => map[key]
    };
  }

  const disklessHappy = {
    'storages:platform:engine': 'postgresql',
    'storages:base:engine': 'postgresql',
    'dnsLess:isActive': true,
    'dns:active': false,
    'cluster:discoveryEnabled': false
  };

  it('[CVPE1] postgresql platform + dnsLess + full PG mode → no problems', () => {
    const problems = [];
    checkPlatformEngineTopology(fakeConfig({ ...disklessHappy }), problems);
    assert.strictEqual(problems.length, 0, JSON.stringify(problems, null, 2));
  });

  it('[CVPE2] rqlite platform engine → guard does not apply, any topology fine', () => {
    const problems = [];
    checkPlatformEngineTopology(fakeConfig({
      'storages:platform:engine': 'rqlite',
      'storages:base:engine': 'sqlite',
      'dnsLess:isActive': false,
      'dns:active': true,
      'cluster:discoveryEnabled': true
    }), problems);
    assert.strictEqual(problems.length, 0);
  });

  it('[CVPE3] postgresql platform without dnsLess → problem naming the migration path', () => {
    const problems = [];
    checkPlatformEngineTopology(fakeConfig({
      ...disklessHappy,
      'dnsLess:isActive': false
    }), problems);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0].message, /dnsLess\.isActive: true/);
    assert.match(problems[0].message, /migrate-platform/);
  });

  it('[CVPE4] postgresql platform with embedded DNS active → problem', () => {
    const problems = [];
    checkPlatformEngineTopology(fakeConfig({
      ...disklessHappy,
      'dns:active': true
    }), problems);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0].message, /dns\.active/);
  });

  it('[CVPE5] postgresql platform with sqlite base engine → problem requiring full PG mode', () => {
    const problems = [];
    checkPlatformEngineTopology(fakeConfig({
      ...disklessHappy,
      'storages:base:engine': 'sqlite'
    }), problems);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0].message, /storages\.base\.engine: postgresql/);
  });

  it('[CVPE6] postgresql platform with cluster discovery → problem', () => {
    const problems = [];
    checkPlatformEngineTopology(fakeConfig({
      ...disklessHappy,
      'cluster:discoveryEnabled': true
    }), problems);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0].message, /discoveryEnabled/);
  });

  it('[CVPE7] every violation reported in one pass (single boot-and-fail cycle)', () => {
    const problems = [];
    checkPlatformEngineTopology(fakeConfig({
      'storages:platform:engine': 'postgresql',
      'storages:base:engine': 'sqlite',
      'dnsLess:isActive': false,
      'dns:active': true,
      'cluster:discoveryEnabled': true
    }), problems);
    assert.strictEqual(problems.length, 4, JSON.stringify(problems, null, 2));
  });
});

/**
 * [CVSD] The PostgreSQL series engine runs on the base storage's
 * PostgreSQL connection, which only exists with a PostgreSQL base: a SQLite
 * base with PostgreSQL series must refuse the boot (it would otherwise boot
 * and fail every series call). The PostgreSQL audit and file engines open
 * their own pool and stay accepted with a SQLite base.
 */
describe('[CVSD] config-validation series engine dependency', () => {
  let checkSeriesEngineDependency, validate;

  before(async function () {
    this.timeout(30000);
    await initTests();
    ({ checkSeriesEngineDependency, validate } = require('../../../config/plugins/config-validation.js'));
  });

  function engines (base, series, extra = {}) {
    const map = { 'storages:base:engine': base, 'storages:series:engine': series, ...extra };
    return { get: (key) => map[key] };
  }

  it('[CVSD1] SQLite base with PostgreSQL series → one problem naming the valid choices', () => {
    const problems = [];
    checkSeriesEngineDependency(engines('sqlite', 'postgresql'), problems);
    assert.strictEqual(problems.length, 1, JSON.stringify(problems, null, 2));
    assert.deepStrictEqual(problems[0].path, ['storages', 'series', 'engine']);
    assert.match(problems[0].message, /requires 'storages\.base\.engine: postgresql'/);
    assert.match(problems[0].message, /'storages\.series\.engine: sqlite' or 'influxdb'/);
  });

  it('[CVSD2] the valid pairings, and PostgreSQL audit / file engines with a SQLite base, pass', () => {
    for (const [base, series] of [['postgresql', 'postgresql'], ['postgresql', 'sqlite'], ['postgresql', 'influxdb'],
      ['sqlite', 'sqlite'], ['sqlite', 'influxdb']]) {
      const problems = [];
      checkSeriesEngineDependency(engines(base, series, {
        'storages:audit:engine': 'postgresql',
        'storages:file:engine': 'postgresql'
      }), problems);
      assert.strictEqual(problems.length, 0, `${base} + ${series}: ${JSON.stringify(problems)}`);
    }
  });

  it('[CVSD3] validate() runs the check', async () => {
    const config = await require('@pryv/boiler').getConfig();
    const base = config.get('storages:base:engine');
    const series = config.get('storages:series:engine');
    try {
      config.set('storages:base:engine', 'sqlite');
      config.set('storages:series:engine', 'postgresql');
      const problems = await validate(config);
      assert.ok(problems.some((p) => p.path.join(':') === 'storages:series:engine'), JSON.stringify(problems, null, 2));
    } finally {
      config.set('storages:base:engine', base);
      config.set('storages:series:engine', series);
    }
  });
});
