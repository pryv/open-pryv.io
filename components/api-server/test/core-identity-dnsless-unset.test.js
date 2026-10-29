/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * [CVDU] `dns.domain` set without `dnsLess.isActive`, whatever `core.url` is:
 * the core-identity and public-url plugins (run before default-config.yml
 * loads) treat the core as multi-core under the domain while the shipped
 * default `dnsLess.isActive: true` routes it path-style, so boot refuses it.
 * Every other topology, the DNSless multi-core member among them, keeps its
 * classification.
 *
 * Each case builds the config the way boot does: a boiler config over the
 * shipped default-config.yml, the operator's files, and the core-identity
 * plugin registered as a synchronous extra.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Config } = require('@pryv/boiler/src/config.ts');
const coreIdentity = require('../../../config/plugins/core-identity.js');
const validation = require('../../../config/plugins/config-validation.js');

const DEFAULT_CONFIG = path.resolve(__dirname, '../../../config/default-config.yml');
const DNSLESS_PROBLEM = /'dns\.domain' is set \(example\.org\) but 'dnsLess\.isActive' is not: set it explicitly/;

describe('[CVDU] boot refuses dns.domain with dnsLess.isActive left unset', function () {
  let dir;
  const savedEnv = {};

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-identity-dnsless-'));
    fs.copyFileSync(DEFAULT_CONFIG, path.join(dir, 'default-config.yml'));
  });
  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
      delete savedEnv[k];
    }
  });

  function setEnv (key, value) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  // The operator's layers: override-config.yml and, optionally,
  // bootstrap-config.yml (what `--bootstrap` writes).
  function bootConfig (override, bootstrap = null) {
    fs.writeFileSync(path.join(dir, 'override-config.yml'), override);
    if (bootstrap != null) fs.writeFileSync(path.join(dir, 'bootstrap-config.yml'), bootstrap);
    const noop = () => {};
    const logging = {
      getLogger: () => ({ debug: noop, warn: noop, info: noop, error: noop }),
      initLoggerWithConfig: noop
    };
    return new Config().initSync({ baseConfigDir: dir, extras: [{ plugin: coreIdentity }] }, logging);
  }

  function dnsLessProblems (config) {
    const problems = [];
    validation.checkDnsLessExplicit(config, problems);
    return problems;
  }

  async function assertRefused (config) {
    // The contradiction: multi-core identity, path-style routing.
    assert.equal(config.get('core:isSingleCore'), false);
    assert.equal(config.get('dnsLess:isActive'), true);
    const problems = dnsLessProblems(config);
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, DNSLESS_PROBLEM);
    assert.match(problems[0].message, /'false' for a multi-core deployment.*'true' for a single core with path-style routing/);
    assert.match(problems[0].message, /DNSless multi-core member \(with 'core\.url'\) must remove 'dns\.domain'/);
    assert.deepEqual(problems[0].path, ['dnsLess', 'isActive']);
    // validate() runs it, so the boot (config-validation's load) exits on it.
    const all = await validation.validate(config);
    assert.ok(all.some((p) => DNSLESS_PROBLEM.test(p.message)), JSON.stringify(all.map((p) => p.message)));
  }

  it('[CVDU1] dns.domain, no core.url, dnsLess.isActive left out: refused, naming both settings', async function () {
    const config = bootConfig('dns:\n  domain: example.org\n');
    assert.equal(config.get('core:url'), 'https://single.example.org');
    await assertRefused(config);
  });

  it('[CVDU2] dns.domain with an explicit core.url, dnsLess.isActive left out: refused too', async function () {
    const config = bootConfig('core:\n  url: https://core-b.example.org\ndns:\n  domain: example.org\n');
    assert.equal(config.get('core:url'), 'https://core-b.example.org');
    await assertRefused(config);
  });

  it('[CVDU3] every other topology keeps its classification and is not refused', async function () {
    const cases = [
      // DNS multi-core, dnsLess explicitly off
      { yaml: 'dns:\n  domain: example.org\ndnsLess:\n  isActive: false\ncore:\n  id: core-a\n', single: false, url: 'https://core-a.example.org' },
      // single core with a domain, dnsLess explicitly on
      { yaml: 'dns:\n  domain: example.org\ndnsLess:\n  isActive: true\n  publicUrl: https://api.example.org/\n', single: true, url: 'https://api.example.org' },
      // no domain, dnsLess left to its default
      { yaml: 'dnsLess:\n  publicUrl: https://api.example.org/\n', single: true, url: 'https://api.example.org' },
      { yaml: 'http:\n  port: 3000\n', single: true, url: null },
      // DNSless multi-core member, as `bootstrap new-core --url` writes it
      { yaml: 'core:\n  id: core-b\n  url: https://core-b.example.org/\n', single: false, url: 'https://core-b.example.org' },
      // explicit core.url alongside a domain, dnsLess explicitly off
      { yaml: 'core:\n  url: https://core-b.example.org\ndns:\n  domain: example.org\ndnsLess:\n  isActive: false\n', single: false, url: 'https://core-b.example.org' },
      // explicit core.url alongside a domain, dnsLess explicitly on: single core
      { yaml: 'core:\n  url: https://api.example.org\ndns:\n  domain: example.org\ndnsLess:\n  isActive: true\n', single: true, url: 'https://api.example.org' },
      // core.url with dnsLess explicitly on: single core
      { yaml: 'core:\n  url: https://api.example.org\ndnsLess:\n  isActive: true\n', single: true, url: 'https://api.example.org' }
    ];
    for (const { yaml, single, url } of cases) {
      const config = bootConfig(yaml);
      assert.equal(config.get('core:isSingleCore'), single, yaml);
      assert.equal(config.get('core:url'), url, yaml);
      assert.deepEqual(dnsLessProblems(config), [], yaml);
      const all = await validation.validate(config);
      assert.ok(!all.some((p) => DNSLESS_PROBLEM.test(p.message)), yaml);
    }
  });

  it('[CVDU4] settings in a --config file (the base layer, a host config) are the operator\'s', function () {
    const hostConfig = path.join(dir, 'host-config.yml');
    setEnv('config', hostConfig);
    // dns.domain and dnsLess.isActive: false both in the host config
    fs.writeFileSync(hostConfig, 'dns:\n  domain: example.org\ndnsLess:\n  isActive: false\ncore:\n  id: core-a\n');
    const both = bootConfig('http:\n  port: 3000\n');
    assert.equal(both.getScopeAndValue('dns:domain').scope, 'base');
    assert.equal(both.get('core:isSingleCore'), false);
    assert.equal(both.get('core:url'), 'https://core-a.example.org');
    assert.deepEqual(dnsLessProblems(both), []);
    // dns.domain in the host config, dnsLess.isActive: false in bootstrap-config.yml
    fs.writeFileSync(hostConfig, 'dns:\n  domain: example.org\ncore:\n  id: core-a\n');
    const split = bootConfig('http:\n  port: 3000\n', 'dnsLess:\n  isActive: false\n');
    assert.equal(split.get('core:isSingleCore'), false);
    assert.deepEqual(dnsLessProblems(split), []);
    // dns.domain alone in the host config
    fs.rmSync(path.join(dir, 'bootstrap-config.yml'));
    const alone = bootConfig('http:\n  port: 3000\n');
    const problems = dnsLessProblems(alone);
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, DNSLESS_PROBLEM);
  });

  it('[CVDU5] an empty dns.domain is refused with a readable message', function () {
    const problems = dnsLessProblems(bootConfig("dns:\n  domain: ''\n"));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /'dns\.domain' is set to an empty string but 'dnsLess\.isActive' is not/);
  });

  it('[CVDU6] dnsLess.isActive set in another operator layer (bootstrap file, environment) counts as set', function () {
    const fromBootstrap = bootConfig('dns:\n  domain: example.org\n', 'dnsLess:\n  isActive: false\n');
    assert.equal(fromBootstrap.get('core:isSingleCore'), false);
    assert.deepEqual(dnsLessProblems(fromBootstrap), []);

    fs.rmSync(path.join(dir, 'bootstrap-config.yml'));
    setEnv('dnsLess__isActive', 'true');
    const fromEnv = bootConfig('dns:\n  domain: example.org\n');
    assert.equal(fromEnv.get('core:isSingleCore'), true);
    assert.deepEqual(dnsLessProblems(fromEnv), []);
  });
});
