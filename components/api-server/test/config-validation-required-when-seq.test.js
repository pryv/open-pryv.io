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
 * [CV-REQ] — boot-time feature-gated required-keys check.
 *
 * Pure unit tests for `checkRequiredWhen` in
 * `config/plugins/config-validation.js`. Pins the contract that:
 *   1. When the gating predicate is true, a missing / sentinel value
 *      pushes a problem.
 *   2. When the gating predicate is false, a missing value is fine
 *      (the feature isn't enabled, so the key isn't needed).
 *
 * The validator's job is to refuse boot when a feature is enabled but
 * its required config is unset — strictly better than the same
 * misconfiguration silently degrading a downstream consumer (e.g.
 * PR #71's broken password-reset email).
 *
 * `-seq` because the api-server mocha hooks run a Platform DB integrity
 * check; the tests themselves do not touch storage.
 */

describe('[CV-REQ] config-validation REQUIRED_WHEN', () => {
  let checkRequiredWhen, isMissingOrSentinel, REQUIRED_WHEN;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ checkRequiredWhen, isMissingOrSentinel, REQUIRED_WHEN } =
      require('../../../config/plugins/config-validation.js'));
  });

  // Build a `config`-shaped object that responds to `.get(key)` lookups
  // by hierarchical colon-separated path. Mirrors the boiler store
  // interface that REQUIRED_WHEN entries use.
  function fakeConfig (map) {
    return {
      get: (key) => map[key]
    };
  }

  const allHappy = {
    'services:email:enabled': { welcome: true, resetPassword: true },
    'services:email:resetPassword': true,
    'auth:passwordResetPageURL': 'https://example.com/reset',
    'auth:adminAccessKey': 'some-real-admin-key',
    'auth:filesReadTokenSecret': 'some-real-secret',
    'letsEncrypt:enabled': false
  };

  it('[CV-REQ-01] happy path: all required keys present, no problems', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({ ...allHappy }), problems);
    assert.strictEqual(problems.length, 0, JSON.stringify(problems, null, 2));
  });

  it('[CV-REQ-02] passwordResetPageURL missing while reset-password email is enabled → problem', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      ...allHappy,
      'auth:passwordResetPageURL': undefined
    }), problems);
    const p = problems.find((p) => p.payload && p.payload.path === 'auth:passwordResetPageURL');
    assert.ok(p, 'expected a problem for auth:passwordResetPageURL');
  });

  it('[CV-REQ-03] passwordResetPageURL not required when whole email feature is disabled', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      ...allHappy,
      'services:email:enabled': false,
      'auth:passwordResetPageURL': undefined
    }), problems);
    const p = problems.find((p) => p.payload && p.payload.path === 'auth:passwordResetPageURL');
    assert.ok(!p, 'expected NO problem when services.email.enabled === false');
  });

  it('[CV-REQ-04] passwordResetPageURL not required when only resetPassword sub-feature is off', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      ...allHappy,
      'services:email:enabled': { welcome: true, resetPassword: false },
      'auth:passwordResetPageURL': undefined
    }), problems);
    const p = problems.find((p) => p.payload && p.payload.path === 'auth:passwordResetPageURL');
    assert.ok(!p, 'expected NO problem when services.email.enabled.resetPassword === false');
  });

  it('[CV-REQ-05] adminAccessKey always required — empty string flagged', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      ...allHappy,
      'auth:adminAccessKey': ''
    }), problems);
    const p = problems.find((p) => p.payload && p.payload.path === 'auth:adminAccessKey');
    assert.ok(p, 'expected a problem for empty auth:adminAccessKey');
    assert.strictEqual(p.payload.presentButEmpty, true);
  });

  it('[CV-REQ-06] adminAccessKey always required — REPLACE sentinel flagged', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      ...allHappy,
      'auth:adminAccessKey': 'REPLACE ME'
    }), problems);
    const p = problems.find((p) => p.payload && p.payload.path === 'auth:adminAccessKey');
    assert.ok(p, 'expected a problem for REPLACE-sentinel auth:adminAccessKey');
    assert.strictEqual(p.payload.presentButEmpty, true);
  });

  it('[CV-REQ-07] filesReadTokenSecret always required — null flagged', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      ...allHappy,
      'auth:filesReadTokenSecret': null
    }), problems);
    const p = problems.find((p) => p.payload && p.payload.path === 'auth:filesReadTokenSecret');
    assert.ok(p, 'expected a problem for null auth:filesReadTokenSecret');
  });

  it('[CV-REQ-08] letsEncrypt secrets only required when feature is enabled', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      ...allHappy,
      'letsEncrypt:enabled': false,
      'letsEncrypt:atRestKey': undefined,
      'letsEncrypt:email': undefined
    }), problems);
    const le = problems.filter((p) => p.payload && p.payload.path && p.payload.path.startsWith('letsEncrypt:'));
    assert.strictEqual(le.length, 0, 'expected NO letsEncrypt problems when feature is off');
  });

  it('[CV-REQ-09] letsEncrypt.atRestKey missing while enabled → problem', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      ...allHappy,
      'letsEncrypt:enabled': true,
      'letsEncrypt:atRestKey': undefined,
      'letsEncrypt:email': 'ops@example.com'
    }), problems);
    const p = problems.find((p) => p.payload && p.payload.path === 'letsEncrypt:atRestKey');
    assert.ok(p, 'expected a problem for missing letsEncrypt:atRestKey when enabled');
  });

  it('[CV-REQ-10] letsEncrypt.email REPLACE sentinel while enabled → problem', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      ...allHappy,
      'letsEncrypt:enabled': true,
      'letsEncrypt:atRestKey': 'base64key',
      'letsEncrypt:email': 'REPLACE ME'
    }), problems);
    const p = problems.find((p) => p.payload && p.payload.path === 'letsEncrypt:email');
    assert.ok(p, 'expected a problem for REPLACE-sentinel letsEncrypt:email when enabled');
  });

  it('[CV-REQ-11] every key in REQUIRED_WHEN exposed with `path` + `when`', () => {
    assert.ok(Array.isArray(REQUIRED_WHEN));
    assert.ok(REQUIRED_WHEN.length >= 5);
    for (const entry of REQUIRED_WHEN) {
      assert.strictEqual(typeof entry.path, 'string');
      assert.strictEqual(typeof entry.when, 'function');
    }
  });

  it('[CV-REQ-12] isMissingOrSentinel: classifies values correctly', () => {
    assert.strictEqual(isMissingOrSentinel(undefined), true, 'undefined → missing');
    assert.strictEqual(isMissingOrSentinel(null), true, 'null → missing');
    assert.strictEqual(isMissingOrSentinel(''), true, 'empty string → missing');
    assert.strictEqual(isMissingOrSentinel('REPLACE ME'), true, 'REPLACE sentinel → missing');
    // eslint-disable-next-line no-template-curly-in-string
    assert.strictEqual(isMissingOrSentinel('${VAR}'), true, 'dollar-curly env placeholder → missing');
    assert.strictEqual(isMissingOrSentinel('https://example.com/'), false, 'real URL → ok');
    assert.strictEqual(isMissingOrSentinel('some-token'), false, 'normal token → ok');
    // Non-strings short-circuit to "not missing" — they have their own validators.
    assert.strictEqual(isMissingOrSentinel(42), false, 'number → not missing');
    assert.strictEqual(isMissingOrSentinel(true), false, 'boolean → not missing');
    assert.strictEqual(isMissingOrSentinel({}), false, 'object → not missing');
  });
});

describe('[CV-AOUD] config-validation audit.onUserDelete', () => {
  let checkAuditOnUserDeleteMode, AUDIT_ON_USER_DELETE_MODES;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ checkAuditOnUserDeleteMode, AUDIT_ON_USER_DELETE_MODES } =
      require('../../../config/plugins/config-validation.js'));
  });

  function fakeConfig (value) {
    return { get: (key) => (key === 'audit:onUserDelete' ? value : undefined) };
  }

  it('[CV-AOUD-01] erase mode accepted', () => {
    const problems = [];
    checkAuditOnUserDeleteMode(fakeConfig('erase'), problems);
    assert.strictEqual(problems.length, 0);
  });

  it('[CV-AOUD-02] keep mode accepted', () => {
    const problems = [];
    checkAuditOnUserDeleteMode(fakeConfig('keep'), problems);
    assert.strictEqual(problems.length, 0);
  });

  it('[CV-AOUD-03] pseudonymise refused at boot (depends on ALIASES, #38)', () => {
    const problems = [];
    checkAuditOnUserDeleteMode(fakeConfig('pseudonymise'), problems);
    assert.strictEqual(problems.length, 1);
    assert.ok(problems[0].message.includes('ALIASES'),
      'expected message to mention ALIASES dependency');
    assert.ok(problems[0].message.includes('#38'),
      'expected message to mention the open-pryv.io issue number');
    assert.strictEqual(problems[0].payload.dependsOn, 'ALIASES (open-pryv.io#38)');
  });

  it('[CV-AOUD-04] unknown mode rejected with allowed list', () => {
    const problems = [];
    checkAuditOnUserDeleteMode(fakeConfig('shred'), problems);
    assert.strictEqual(problems.length, 1);
    assert.ok(problems[0].message.includes('erase, keep, pseudonymise'),
      'expected message to list the allowed enum values');
    assert.deepEqual(problems[0].payload.allowed, ['erase', 'keep', 'pseudonymise']);
  });

  it('[CV-AOUD-05] absent value tolerated (consumer falls back to default \'erase\')', () => {
    const problems = [];
    checkAuditOnUserDeleteMode(fakeConfig(null), problems);
    assert.strictEqual(problems.length, 0);
  });

  it('[CV-AOUD-06] AUDIT_ON_USER_DELETE_MODES enum exposed', () => {
    assert.deepEqual(AUDIT_ON_USER_DELETE_MODES, ['erase', 'keep', 'pseudonymise']);
  });
});

describe('[CVDT] config-validation DNS topology consistency', () => {
  let checkDnsTopologyConsistency;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ checkDnsTopologyConsistency } =
      require('../../../config/plugins/config-validation.js'));
  });

  function fakeConfig (map) {
    return { get: (key) => map[key] };
  }

  it('[CVDT1] dns.active + dnsLess.isActive both true → problem with the one-line fix', () => {
    const problems = [];
    checkDnsTopologyConsistency(fakeConfig({ 'dns:active': true, 'dnsLess:isActive': true }), problems);
    assert.strictEqual(problems.length, 1);
    assert.ok(problems[0].message.includes('dnsLess.isActive: false'),
      'expected message to name the fix: ' + problems[0].message);
    assert.deepEqual(problems[0].path, ['dnsLess', 'isActive']);
  });

  it('[CVDT2] dns.active with dnsLess.isActive false → no problem', () => {
    const problems = [];
    checkDnsTopologyConsistency(fakeConfig({ 'dns:active': true, 'dnsLess:isActive': false }), problems);
    assert.strictEqual(problems.length, 0);
  });

  it('[CVDT3] dnsLess deployment (dns.active false/unset) → no problem', () => {
    const problems = [];
    checkDnsTopologyConsistency(fakeConfig({ 'dnsLess:isActive': true }), problems);
    checkDnsTopologyConsistency(fakeConfig({ 'dns:active': false, 'dnsLess:isActive': true }), problems);
    assert.strictEqual(problems.length, 0);
  });
});
