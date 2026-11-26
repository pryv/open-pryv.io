/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/* global initTests, initCore, assert, injectTestConfigSnapshot */

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
    'services:email:enabled': true,
    'services:email:sendWelcome': true,
    'services:email:sendResetPassword': true,
    'services:email:sendVerifyEmail': true,
    'auth:passwordResetPageURL': 'https://example.com/reset',
    'auth:emailVerificationPageURL': 'https://example.com/verify',
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
      'services:email:sendResetPassword': false,
      'auth:passwordResetPageURL': undefined
    }), problems);
    const p = problems.find((p) => p.payload && p.payload.path === 'auth:passwordResetPageURL');
    assert.ok(!p, 'expected NO problem when services.email.sendResetPassword === false');
  });

  it('[CV-REQ-4B] emailVerificationPageURL missing while verify-email is enabled → problem', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      ...allHappy,
      'auth:emailVerificationPageURL': undefined
    }), problems);
    const p = problems.find((p) => p.payload && p.payload.path === 'auth:emailVerificationPageURL');
    assert.ok(p, 'expected a problem for auth:emailVerificationPageURL');
  });

  it('[CV-REQ-4C] emailVerificationPageURL not required when verifyEmail sub-feature is off', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      ...allHappy,
      'services:email:sendVerifyEmail': false,
      'auth:emailVerificationPageURL': undefined
    }), problems);
    const p = problems.find((p) => p.payload && p.payload.path === 'auth:emailVerificationPageURL');
    assert.ok(!p, 'expected NO problem when services.email.sendVerifyEmail === false');
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

  it('[CV-REQ-10] letsEncrypt.email is optional while enabled (ACME account without a contact)', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      ...allHappy,
      'letsEncrypt:enabled': true,
      'letsEncrypt:atRestKey': 'base64key',
      'letsEncrypt:email': null
    }), problems);
    const le = problems.filter((p) => p.payload && p.payload.path && p.payload.path.startsWith('letsEncrypt:'));
    assert.strictEqual(le.length, 0, JSON.stringify(le, null, 2));
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

/**
 * [CV-DEF] — the SHIPPED defaults, not a hand-built map.
 *
 * Every [CV-REQ] case above feeds `checkRequiredWhen` a `fakeConfig`, so it
 * pins the predicate and nothing else. The incident this suite grew from did
 * not live in the predicate: `default-config.yml` shipped a beta sub-feature
 * ON, which silently promoted `auth.emailVerificationPageURL` to a required
 * key and stopped previously-valid deployments from booting on upgrade. No
 * fakeConfig test can catch that — it needs the real YAML.
 *
 * `js-yaml` is a declared dependency of the `@pryv/boiler` workspace package
 * (and the parser boiler itself uses for config files), hoisted to the root
 * tree; `dns-records-cli.test.js` reads YAML the same way.
 */
describe('[CV-DEF] shipped default-config keeps optional keys optional', () => {
  let checkRequiredWhen, REQUIRED_WHEN, defaults;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ checkRequiredWhen, REQUIRED_WHEN } =
      require('../../../config/plugins/config-validation.js'));
    const fs = require('node:fs');
    const path = require('node:path');
    const yaml = require('js-yaml');
    defaults = yaml.load(fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../config/default-config.yml'), 'utf8'));
  });

  // Wrap the parsed YAML in the colon-path getter the REQUIRED_WHEN
  // predicates expect, so they see exactly what boiler would hand them for a
  // deployment that overrides nothing.
  function defaultConfig () {
    const get = (key) => key.split(':').reduce(
      (node, seg) => (node == null ? undefined : node[seg]), defaults);
    return {
      get,
      // The soft-landing rule asks WHERE a value came from: everything here is
      // the shipped file, so the page URL must not become required.
      getScopeAndValue: (key) => ({ value: get(key), scope: 'default-file', info: '' })
    };
  }

  it('[CV-DEF-01] verifyEmail ships ON', () => {
    assert.strictEqual(defaults.services.email.sendVerifyEmail, true,
      'services.email.sendVerifyEmail must ship true: the feature is general ' +
      'availability. The page URL is only required when an operator sets this key ' +
      'explicitly, so a config that never mentions it still boots');
  });

  it('[CV-DEF-02] the shipped defaults do not make emailVerificationPageURL required', () => {
    const rule = REQUIRED_WHEN.find((r) => r.path === 'auth:emailVerificationPageURL');
    assert.ok(rule, 'the auth:emailVerificationPageURL rule still exists');
    assert.strictEqual(rule.when(defaultConfig()), false,
      'stock defaults must not gate on auth:emailVerificationPageURL');

    const problems = [];
    checkRequiredWhen(defaultConfig(), problems);
    const hit = problems.find((p) => p.payload &&
      p.payload.path === 'auth:emailVerificationPageURL');
    assert.strictEqual(hit, undefined,
      'stock defaults must not report auth:emailVerificationPageURL as missing');
    // Deliberately NOT asserting zero problems: default-config legitimately
    // leaves adminAccessKey / filesReadTokenSecret / passwordResetPageURL for
    // the operator to supply, and those SHOULD refuse to boot when unset.
  });

  // The soft landing: on by default, but only an operator who asked for the
  // feature explicitly is held to supplying the page URL.
  describe('[CV-GA] default-on email verification', () => {
    let collectWarnings;

    before(() => {
      ({ collectWarnings } = require('../../../config/plugins/config-validation.js'));
    });

    /** A config whose every value reports the given scope. */
    function scopedConfig (values, scope) {
      const get = (key) => key.split(':').reduce(
        (node, seg) => (node == null ? undefined : node[seg]), values);
      return {
        get,
        getScopeAndValue: (key) => ({ value: get(key), scope, info: '' })
      };
    }

    const GATE_VALUES = {
      services: { email: { sendVerifyEmail: true, method: 'mandrill', mergeLanguage: 'mailchimp', url: 'https://mail.example.com/send', key: 'k' } },
      auth: {}
    };

    it('[CV-GA1] an inherited default with no page URL warns instead of refusing the boot', () => {
      const config = scopedConfig(GATE_VALUES, 'default-file');
      const problems = [];
      checkRequiredWhen(config, problems);
      assert.strictEqual(
        problems.find((p) => p.payload && p.payload.path === 'auth:emailVerificationPageURL'),
        undefined,
        'a value inherited from the shipped file must not make the URL required');

      const warnings = collectWarnings(config);
      assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
      assert.match(warnings[0], /emailVerificationPageURL/);
    });

    it('[CV-GA2] an operator who set the flag is held to supplying the page URL', () => {
      const config = scopedConfig(GATE_VALUES, 'override-file');
      const problems = [];
      checkRequiredWhen(config, problems);
      assert.ok(
        problems.find((p) => p.payload && p.payload.path === 'auth:emailVerificationPageURL'),
        'an explicitly-set flag must still require the URL');
      assert.deepStrictEqual(collectWarnings(config), [],
        'a hard problem must not also be reported as a warning');
    });

    it('[CV-GA3] an explicitly-off platform is neither a problem nor a warning', () => {
      const config = scopedConfig({
        services: { email: { sendVerifyEmail: false, method: 'mandrill', mergeLanguage: 'mailchimp', url: 'u', key: 'k' } },
        auth: {}
      }, 'override-file');
      const problems = [];
      checkRequiredWhen(config, problems);
      assert.strictEqual(
        problems.find((p) => p.payload && p.payload.path === 'auth:emailVerificationPageURL'),
        undefined);
      assert.deepStrictEqual(collectWarnings(config), []);
    });

    it('[CV-GA4] a default-on platform with an incomplete mail setup says which keys are missing', () => {
      const config = scopedConfig({
        services: { email: { sendVerifyEmail: true, method: 'in-process' } },
        auth: { emailVerificationPageURL: 'https://app.example.com/verify-email' }
      }, 'default-file');
      const warnings = collectWarnings(config);
      assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
      assert.match(warnings[0], /services\.email' is incomplete/);
      assert.match(warnings[0], /smtp\.host/);
    });

    it('[CV-GA5] in-process mail with no SMTP host is one warning naming every enabled mail class', () => {
      const config = scopedConfig({
        services: { email: { sendWelcome: true, sendResetPassword: true, sendVerifyEmail: false, sendMfaChange: true, method: 'in-process', smtp: { host: null } } },
        auth: {}
      }, 'default-file');
      const warnings = collectWarnings(config);
      assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
      assert.match(warnings[0], /mail is not configured, so the welcome, password-reset, MFA-change, external-id-release, auto-deletion confirmation, auto-deletion reminder, auto-deletion on-hold, transfer beneficiary named, transfer claim link, transfer started, transfer cancelled, transfer lapsed and transfer completed mails are not sent/);
      assert.ok(!/email-verification|cannot be proved/.test(warnings[0]), warnings[0]);
    });

    it('[CV-GA7] a placeholder SMTP host is shown in the warning', () => {
      const config = scopedConfig({
        services: { email: { sendVerifyEmail: false, method: 'in-process', smtp: { host: 'REPLACE ME' } } },
        auth: {}
      }, 'default-file');
      const warnings = collectWarnings(config);
      assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
      assert.match(warnings[0], /smtp\.host missing or unset: it is 'REPLACE ME'\)/);
    });

    // The shipped defaults (verifyEmail on, no verification page URL, an empty
    // SMTP host) give two warnings with two different remedies: the mail one
    // (SMTP) and the verification page one (auth.emailVerificationPageURL).
    it('[CV-GA8] the shipped default mail settings give the mail warning and the verification page warning', () => {
      const yaml = require('js-yaml');
      const fs = require('node:fs');
      const defaults = yaml.load(fs.readFileSync(new URL('../../../config/default-config.yml', import.meta.url), 'utf8'));
      const config = scopedConfig({ services: { email: defaults.services.email }, auth: defaults.auth }, 'default-file');
      const warnings = collectWarnings(config);
      assert.strictEqual(warnings.length, 2, JSON.stringify(warnings));
      assert.match(warnings[0], /mail is not configured, so the welcome, password-reset, email-verification, MFA-change, external-id-release, auto-deletion confirmation, auto-deletion reminder, auto-deletion on-hold, transfer beneficiary named, transfer claim link, transfer started, transfer cancelled, transfer lapsed and transfer completed mails are not sent/);
      assert.ok(!/: it is '/.test(warnings[0]), 'an empty host is not shown');
      assert.match(warnings[1], /email verification is on by default but 'auth\.emailVerificationPageURL' is not set/);
    });

    it('[CV-GA9] services.email.mergeLanguage: an unknown value refuses the boot; mandrill without it warns once', () => {
      const { checkMergeLanguage } = require('../../../config/plugins/config-validation.js');
      const mandrill = { sendVerifyEmail: false, method: 'mandrill', url: 'u', key: 'k' };
      for (const bad of ['Handlebars', 'mustache', 3, true]) {
        const problems = [];
        checkMergeLanguage(scopedConfig({ services: { email: { ...mandrill, mergeLanguage: bad } }, auth: {} }, 'override-file'), problems);
        assert.strictEqual(problems.length, 1, JSON.stringify(bad));
        assert.match(problems[0].message, /services\.email\.mergeLanguage must be 'handlebars' or 'mailchimp'/);
      }
      for (const ok of ['handlebars', 'mailchimp', null, undefined, '']) {
        const problems = [];
        checkMergeLanguage(scopedConfig({ services: { email: { ...mandrill, mergeLanguage: ok } }, auth: {} }, 'override-file'), problems);
        assert.deepStrictEqual(problems, [], JSON.stringify(ok));
      }
      const unset = collectWarnings(scopedConfig({ services: { email: mandrill }, auth: {} }, 'override-file'));
      assert.strictEqual(unset.length, 1, JSON.stringify(unset));
      assert.match(unset[0], /services\.email\.mergeLanguage is not set \(method mandrill\)/);
      for (const email of [
        { ...mandrill, mergeLanguage: 'handlebars' },
        { ...mandrill, enabled: false },
        { sendVerifyEmail: false, method: 'microservice', url: 'u', key: 'k' }
      ]) {
        assert.deepStrictEqual(collectWarnings(scopedConfig({ services: { email }, auth: {} }, 'override-file')), [], JSON.stringify(email));
      }
    });

    it('[CV-GA6] no mail warning when mail is off or the SMTP host is set', () => {
      for (const email of [
        { enabled: false, method: 'in-process' },
        { sendWelcome: false, sendResetPassword: false, sendVerifyEmail: false, sendMfaChange: false, sendExternalIdReleased: false, sendAccountDeletionScheduled: false, sendAccountDeletionReminder: false, sendAccountDeletionBlocked: false, sendAccountTransferNamed: false, sendAccountTransferClaim: false, sendAccountTransferStarted: false, sendAccountTransferCancelled: false, sendAccountTransferLapsed: false, sendAccountTransferCompleted: false, method: 'in-process' },
        { sendVerifyEmail: false, method: 'in-process', smtp: { host: 'smtp.example.com' } }
      ]) {
        const warnings = collectWarnings(scopedConfig({ services: { email }, auth: {} }, 'default-file'));
        assert.deepStrictEqual(warnings, [], JSON.stringify(email));
      }
    });
  });
});

describe('[EMFLB] config-validation mail switches', () => {
  let checkEmailSwitches, checkRequiredWhen, validate;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ checkEmailSwitches, checkRequiredWhen, validate } = require('../../../config/plugins/config-validation.js'));
  });

  const nested = (values) => (key) => key.split(':').reduce((node, seg) => (node == null ? undefined : node[seg]), values);

  /**
   * A boiler-shaped config: `scopes` highest first, each `[name, values, file?]`.
   * `get` resolves like boiler: the first scope holding a non-object value wins.
   */
  function layeredConfig (scopes) {
    const stores = {};
    for (const [name, values, file] of scopes) {
      stores[name] = file != null ? { type: 'file', file, get: nested(values) } : { type: 'literal', get: nested(values) };
    }
    return {
      store: { stores },
      get: (key) => {
        if (key == null) return {};
        for (const [, values] of scopes) {
          const v = nested(values)(key);
          if (v !== undefined) return v;
        }
        return undefined;
      },
      getScopeAndValue: () => null
    };
  }

  function run (config) {
    const problems = [];
    checkEmailSwitches(config, problems);
    return problems;
  }

  it('[EMFL4] the object form in the override file: one problem naming each key found and its replacement, nothing else', () => {
    const problems = run(layeredConfig([
      ['override-file', { services: { email: { enabled: { welcome: false, resetPassword: true, verifyEmail: 'no', welcom: false } } } }, '/etc/pryv/override.yml'],
      ['default-file', { services: { email: { enabled: true, sendWelcome: true, sendMfaChange: true } } }, 'config/default-config.yml']
    ]));
    assert.strictEqual(problems.length, 1, JSON.stringify(problems));
    const [p] = problems;
    assert.deepStrictEqual(p.path, ['services', 'email', 'enabled']);
    assert.deepStrictEqual(p.payload, { scope: 'override-file', info: 'From file: /etc/pryv/override.yml' });
    const lines = p.message.split('\n');
    assert.match(lines[0], /^services\.email\.enabled must be true or false\. .*Found in override-file \(From file: \/etc\/pryv\/override\.yml\):$/);
    assert.deepStrictEqual(lines.slice(1, -1), [
      '  services.email.enabled.welcome: false  ->  services.email.sendWelcome: false',
      '  services.email.enabled.resetPassword: true  ->  services.email.sendResetPassword: true',
      '  services.email.enabled.verifyEmail: <not a boolean>  ->  services.email.sendVerifyEmail: true or false',
      '  services.email.enabled.welcom: not a mail switch, remove it'
    ]);
    assert.match(lines[lines.length - 1], /^Move each line to its new key, then set services\.email\.enabled to true or remove it/);
    assert.ok(!/mfaChange|MfaChange/.test(p.message), 'a key not set in that scope is not listed');
    const empty = run(layeredConfig([['override-file', { services: { email: { enabled: {} } } }]]));
    assert.strictEqual(empty.length, 1);
    assert.strictEqual(empty[0].message.split('\n').length, 2, empty[0].message);
    assert.match(empty[0].message, /Found in override-file \(Type: literal\), as an empty object\./);
  });

  it('[EMFL5] the object form in a lower scope, under a higher enabled: true, is still refused (every scope is read)', () => {
    const config = layeredConfig([
      ['env', { services: { email: { enabled: true } } }],
      ['override-file', { services: { email: { enabled: { welcome: false } } } }, '/etc/pryv/override.yml'],
      ['test', { services: { email: { enabled: { mfaChange: false } } } }]
    ]);
    assert.strictEqual(config.get('services:email:enabled'), true, 'the resolved value hides the objects');
    const problems = run(config);
    assert.deepStrictEqual(problems.map((p) => p.payload.scope), ['override-file', 'test'], JSON.stringify(problems));
    // In the environment, both sides are written as variables.
    const env = run(layeredConfig([['env', { services: { email: { enabled: { welcome: false } } } }]]));
    assert.match(env[0].message, /Found in env \(Type: literal\):\n {2}services__email__enabled__welcome=false {2}-> {2}services__email__sendWelcome=false\n/);
    // The whole validation reports it too.
    return validate(config).then((all) => {
      assert.ok(all.some((p) => p.path.join(':') === 'services:email:enabled'), JSON.stringify(all.map((p) => p.path)));
    });
  });

  it('[EMFL6] enabled: true, enabled: false, unset and flat switches are no problem', () => {
    for (const email of [{ enabled: true }, { enabled: false }, {}, { enabled: true, sendWelcome: false, sendResetPassword: true }]) {
      assert.deepStrictEqual(run(layeredConfig([['override-file', { services: { email } }]])), [], JSON.stringify(email));
    }
    assert.deepStrictEqual(run(layeredConfig([['override-file', {}]])), [], 'no services.email at all');
    // A config without scopes (a unit-test fake) is read through get.
    assert.deepStrictEqual(run({ get: nested({ services: { email: { enabled: true } } }) }), []);
    assert.strictEqual(run({ get: nested({ services: { email: { enabled: { welcome: false } } } }) }).length, 1);
  });

  it('[EMFL7] a non-boolean enabled or send<Kind> (empty value, quoted false) is refused; a hidden lower one is not', () => {
    const problems = run(layeredConfig([
      ['override-file', { services: { email: { enabled: null, sendWelcome: 'false', sendWelcom: 'x' } } }, '/etc/pryv/override.yml'],
      ['default-file', { services: { email: { enabled: true, sendWelcome: true } } }]
    ]));
    assert.deepStrictEqual(problems.map((p) => p.path.join('.')), ['services.email.enabled', 'services.email.sendWelcome'], JSON.stringify(problems));
    assert.match(problems[0].message, /^services\.email\.enabled must be true or false, found an empty value in override-file \(From file: \/etc\/pryv\/override\.yml\)/);
    assert.match(problems[1].message, /^services\.email\.sendWelcome must be true or false, found the string "false" in override-file/);
    assert.deepStrictEqual(run(layeredConfig([
      ['override-file', { services: { email: { sendWelcome: false } } }],
      ['default-file', { services: { email: { sendWelcome: 'x' } } }]
    ])), [], 'a lower value hidden by a boolean is not the running value');
  });

  it('[EMFL8] auth.passwordResetPageURL: required by default, not with sendResetPassword: false, not with enabled: false', () => {
    const fs = require('node:fs');
    const yaml = require('js-yaml');
    const defaults = yaml.load(fs.readFileSync(new URL('../../../config/default-config.yml', import.meta.url), 'utf8'));
    const missing = (email) => {
      const config = { get: nested({ services: { email: { ...defaults.services.email, ...email } }, auth: { adminAccessKey: 'some-real-admin-key', filesReadTokenSecret: 'some-real-secret' } }) };
      const problems = [];
      checkRequiredWhen(config, problems);
      return problems.some((p) => p.payload && p.payload.path === 'auth:passwordResetPageURL');
    };
    assert.strictEqual(missing({}), true, 'the shipped defaults send the reset mail: the page is required');
    assert.strictEqual(missing({ sendResetPassword: false }), false);
    assert.strictEqual(missing({ enabled: false, sendResetPassword: true }), false);
    assert.strictEqual(missing({ sendWelcome: false }), true, 'another class switched off changes nothing');
  });

  it('[EMFL10] on the real boiler config: the object form in the test scope, under enabled: true in memory, is refused', async () => {
    const { getConfig } = require('@pryv/boiler');
    const config = await getConfig();
    const memory = config.store.stores.memory;
    const key = 'services:email:enabled';
    const before = memory.get(key);
    const restore = injectTestConfigSnapshot({ services: { email: { enabled: { welcome: false } } } });
    try {
      const inTest = run(config).filter((p) => p.path.join(':') === key);
      assert.deepStrictEqual(inTest.map((p) => p.payload.scope), ['test'], JSON.stringify(inTest));
      // A boolean in a higher scope (only the memory store, not config.set, which writes every writable store).
      memory.set(key, true);
      assert.strictEqual(config.get(key), true, 'the resolved value hides the object');
      const hidden = run(config).filter((p) => p.path.join(':') === key);
      assert.deepStrictEqual(hidden.map((p) => p.payload.scope), ['test'], JSON.stringify(hidden));
      assert.match(hidden[0].message, /services\.email\.enabled\.welcome: false {2}-> {2}services\.email\.sendWelcome: false/);
    } finally {
      if (before === undefined) memory.clear(key); else memory.set(key, before);
      restore();
    }
    assert.deepStrictEqual(run(config).filter((p) => p.path.join(':') === key), [], 'restored');
  });
});

describe('[CVSE] config-validation reportProblems stderr mirror', () => {
  let reportProblems;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ reportProblems } =
      require('../../../config/plugins/config-validation.js'));
  });

  it('[CVSE-01] mirrors the header + every problem to stderr with a [config-validation] tag', () => {
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      reportProblems([
        { path: ['auth', 'passwordResetPageURL'], message: 'is missing' },
        { path: ['letsEncrypt', 'atRestKey'], message: 'is missing' }
      ]);
    } finally {
      process.stderr.write = orig;
    }
    const out = writes.join('');
    assert.ok(out.includes('[config-validation]'), 'stderr carries the [config-validation] tag');
    assert.ok(out.includes('2 problem(s) found'), 'header mirrored to stderr');
    assert.ok(out.includes('auth:passwordResetPageURL'), 'first problem path mirrored to stderr');
    assert.ok(out.includes('letsEncrypt:atRestKey'), 'second problem path mirrored to stderr');
    assert.ok(out.includes('is missing'), 'problem message mirrored to stderr');
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

  it('[CV-AOUD-03] pseudonymise refused at boot (not implemented)', () => {
    const problems = [];
    checkAuditOnUserDeleteMode(fakeConfig('pseudonymise'), problems);
    assert.strictEqual(problems.length, 1);
    assert.ok(problems[0].message.includes('not implemented'),
      'expected message to say pseudonymisation is not implemented');
    assert.ok(!/not yet available|ALIASES|#38/.test(problems[0].message),
      'the message no longer names a missing primitive (aliases exist)');
    assert.strictEqual(problems[0].payload.implemented, false);
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

describe('[SSOCFG] config-validation third-party sign-in (SSO)', () => {
  let checkSsoConfig, checkRequiredWhen;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ checkSsoConfig, checkRequiredWhen } =
      require('../../../config/plugins/config-validation.js'));
  });

  function fakeConfig (map) {
    return { get: (key) => map[key] };
  }

  const validProvider = {
    google: { issuer: 'https://accounts.google.com', clientId: 'cid', clientSecret: 'csecret', label: 'Google' }
  };

  it('[SSOCFG-01] disabled (default) → no checks run, no problems', () => {
    const problems = [];
    checkSsoConfig(fakeConfig({ 'sso:enabled': false, 'dns:active': true, 'sso:providers': { bad: {} } }), problems);
    assert.strictEqual(problems.length, 0, JSON.stringify(problems, null, 2));
  });

  it('[SSOCFG-02] enabled with a valid provider (dnsLess) → no problems', () => {
    const problems = [];
    checkSsoConfig(fakeConfig({ 'sso:enabled': true, 'sso:providers': validProvider }), problems);
    assert.strictEqual(problems.length, 0, JSON.stringify(problems, null, 2));
  });

  it('[SSOCFG-03] enabled with embedded DNS (dns.active) → single-core refusal (D7)', () => {
    const problems = [];
    checkSsoConfig(fakeConfig({ 'sso:enabled': true, 'dns:active': true, 'sso:providers': validProvider }), problems);
    const p = problems.find((p) => p.path && p.path[0] === 'sso' && p.path[1] === 'enabled');
    assert.ok(p, 'expected a single-core/dns problem');
    assert.ok(p.message.includes('single-core'), p.message);
  });

  it('[SSOCFG-04] provider id not a url-safe slug → problem', () => {
    const problems = [];
    checkSsoConfig(fakeConfig({
      'sso:enabled': true,
      'sso:providers': { 'Bad Id!': { issuer: 'https://idp.example.com', clientId: 'a', clientSecret: 'b' } }
    }), problems);
    const p = problems.find((p) => p.message.includes('url-safe slug'));
    assert.ok(p, 'expected a slug problem: ' + JSON.stringify(problems));
  });

  it('[SSOCFG-05] provider missing clientSecret → problem', () => {
    const problems = [];
    checkSsoConfig(fakeConfig({
      'sso:enabled': true,
      'sso:providers': { google: { issuer: 'https://accounts.google.com', clientId: 'cid' } }
    }), problems);
    const p = problems.find((p) => p.message.includes('clientSecret'));
    assert.ok(p, 'expected a missing-clientSecret problem');
  });

  it('[SSOCFG-06] provider issuer not https → problem', () => {
    const problems = [];
    checkSsoConfig(fakeConfig({
      'sso:enabled': true,
      'sso:providers': { google: { issuer: 'http://accounts.google.com', clientId: 'a', clientSecret: 'b' } }
    }), problems);
    const p = problems.find((p) => p.message.includes('https URL'));
    assert.ok(p, 'expected an https-issuer problem');
  });

  it('[SSOCFG-07] landingPageURL required once enabled with providers (REQUIRED_WHEN)', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({
      'sso:enabled': true,
      'sso:providers': validProvider,
      'sso:landingPageURL': ''
    }), problems);
    const p = problems.find((p) => p.payload && p.payload.path === 'sso:landingPageURL');
    assert.ok(p, 'expected a missing landingPageURL problem');
  });

  it('[SSOCFG-08] landingPageURL NOT required when disabled or no providers', () => {
    const problems = [];
    checkRequiredWhen(fakeConfig({ 'sso:enabled': false, 'sso:providers': validProvider, 'sso:landingPageURL': undefined }), problems);
    checkRequiredWhen(fakeConfig({ 'sso:enabled': true, 'sso:providers': {}, 'sso:landingPageURL': undefined }), problems);
    const sso = problems.filter((p) => p.payload && p.payload.path === 'sso:landingPageURL');
    assert.strictEqual(sso.length, 0, 'expected NO landingPageURL problem when disabled / no providers');
  });

  it('[SSOCFG-09] providers as a YAML list (not a map) → problem', () => {
    const problems = [];
    checkSsoConfig(fakeConfig({
      'sso:enabled': true,
      'sso:providers': [{ issuer: 'https://accounts.google.com', clientId: 'a', clientSecret: 'b' }]
    }), problems);
    const p = problems.find((p) => p.message.includes('map keyed by provider id'));
    assert.ok(p, 'expected a providers-must-be-a-map problem: ' + JSON.stringify(problems));
  });

  it('[SSOCFG-10] callbackBaseURL non-https when set → problem; empty/unset → fine', () => {
    let problems = [];
    checkSsoConfig(fakeConfig({ 'sso:enabled': true, 'sso:callbackBaseURL': 'http://core.example.com', 'sso:providers': validProvider }), problems);
    assert.ok(problems.find((p) => p.message.includes('callbackBaseURL')), 'expected an https-callbackBaseURL problem');
    problems = [];
    checkSsoConfig(fakeConfig({ 'sso:enabled': true, 'sso:callbackBaseURL': '', 'sso:providers': validProvider }), problems);
    assert.strictEqual(problems.length, 0, 'empty callbackBaseURL is allowed (derived from public URL)');
  });
});

describe('[CVWS] config-validation weak secrets', () => {
  const { checkRequiredWhen } = require('../../../config/plugins/config-validation.js');
  function fakeConfig (map) {
    return { get: (key) => map[key] };
  }
  const allHappy = {
    'services:email:enabled': true,
    'services:email:sendWelcome': true,
    'services:email:sendResetPassword': true,
    'services:email:sendVerifyEmail': true,
    'auth:passwordResetPageURL': 'https://example.com/reset',
    'auth:emailVerificationPageURL': 'https://example.com/verify',
    'auth:adminAccessKey': 'some-real-admin-key',
    'auth:filesReadTokenSecret': 'some-real-secret',
    'letsEncrypt:enabled': false
  };

  it('[CVWS1] a shipped placeholder secret never boots, whatever the environment', () => {
    for (const key of ['auth:adminAccessKey', 'auth:filesReadTokenSecret']) {
      for (const value of ['OVERRIDE ME', 'override me', 'CHANGEME', 'change-me', 'CHANGE_ME_WITH_SOMETHING', 'please-override-me']) {
        const problems = [];
        checkRequiredWhen(fakeConfig({ ...allHappy, [key]: value }), problems);
        const p = problems.find((p) => p.payload && p.payload.path === key);
        assert.ok(p, `expected a problem for ${key} = ${value}`);
        assert.strictEqual(p.payload.weakSecret, true);
        assert.ok(!p.message.includes(value), 'the message does not echo the value');
      }
    }
  });

  it('[CVWS2] in production, a secret shorter than the minimum is refused; a long one passes', () => {
    const { MIN_SECRET_LENGTH } = require('../../../config/plugins/config-validation.js');
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      let problems = [];
      checkRequiredWhen(fakeConfig({ ...allHappy, 'auth:adminAccessKey': 'x'.repeat(MIN_SECRET_LENGTH - 1) }), problems);
      assert.ok(problems.find((p) => p.payload && p.payload.path === 'auth:adminAccessKey' && p.payload.weakSecret));
      problems = [];
      checkRequiredWhen(fakeConfig({ ...allHappy, 'auth:adminAccessKey': 'a1'.repeat(16), 'auth:filesReadTokenSecret': 'b2'.repeat(16) }), problems);
      assert.strictEqual(problems.length, 0, JSON.stringify(problems));
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('[CVPK1] hashed PII without a piiHmacKey (absent, empty or placeholder) refuses the boot', () => {
    for (const value of [undefined, '', 'REPLACE ME', 0]) {
      const problems = [];
      checkRequiredWhen(fakeConfig({ ...allHappy, 'platform:piiMode': 'hashed', 'platform:piiHmacKey': value }), problems);
      const p = problems.find((p) => p.payload && p.payload.path === 'platform:piiHmacKey');
      assert.ok(p, 'expected a problem for piiHmacKey=' + JSON.stringify(value));
      assert.match(p.message, /randomBytes\(32\)/, 'the problem says how to generate the key');
    }
  });

  it('[CVPK2] hashed PII with a key, or cleartext / unset piiMode without one, boots', () => {
    const cases = [
      { 'platform:piiMode': 'hashed', 'platform:piiHmacKey': 'WLthDQK7GoYZINg7uIeWN9eANnj2BSh4zEZmRPyR5y0=' },
      { 'platform:piiMode': 'cleartext' },
      {} // Platform resolves an unset piiMode to cleartext
    ];
    for (const extra of cases) {
      const problems = [];
      checkRequiredWhen(fakeConfig({ ...allHappy, ...extra }), problems);
      assert.strictEqual(problems.length, 0, JSON.stringify({ extra, problems }));
    }
  });

  it('[CVPK4] in production, the public development/test pepper is refused; a key of your own boots', () => {
    const publicKey = 'WLthDQK7GoYZINg7uIeWN9eANnj2BSh4zEZmRPyR5y0=';
    const ownKey = require('node:crypto').randomBytes(32).toString('base64');
    const run = (key) => {
      const problems = [];
      checkRequiredWhen(fakeConfig({ ...allHappy, 'platform:piiMode': 'hashed', 'platform:piiHmacKey': key }), problems);
      return problems.find((p) => p.payload && p.payload.path === 'platform:piiHmacKey');
    };
    assert.strictEqual(run(publicKey), undefined, 'accepted outside production (tests use it)');
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const p = run(publicKey);
      assert.ok(p && p.payload.weakSecret, 'refused in production');
      assert.match(p.message, /public development\/test value/);
      assert.match(p.message, /randomBytes\(32\)/, 'the hint fits a pepper, not a hex secret');
      assert.strictEqual(run(ownKey), undefined);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('[CVPK3] development-config.yml carries a usable key for the hashed default', () => {
    const yaml = require('js-yaml');
    const fs = require('node:fs');
    const read = (f) => yaml.load(fs.readFileSync(new URL('../../../config/' + f, import.meta.url), 'utf8'));
    assert.strictEqual(read('default-config.yml').platform.piiMode, 'hashed');
    const key = read('development-config.yml').platform.piiHmacKey;
    assert.strictEqual(Buffer.from(key, 'base64').length, 32);
  });

  it('[CVWS3] outside production, a short (non-placeholder) secret is accepted', () => {
    const { weakSecretReason } = require('../../../config/plugins/config-validation.js');
    assert.strictEqual(weakSecretReason('short-key'), null);
    assert.match(weakSecretReason('short-key', { production: true }), /shorter than/);
    assert.match(weakSecretReason('OVERRIDE ME'), /placeholder/);
    assert.strictEqual(weakSecretReason(undefined), null);
    for (const devValue of ['dev-only-admin-access-key', 'dev-only-files-read-token-secret']) {
      assert.strictEqual(weakSecretReason(devValue), null, 'development-config.yml boots outside production');
    }
  });

  it('[CVWS4] in production, the admin key and files-read secret published for development and tests are refused', () => {
    const published = {
      'auth:adminAccessKey': ['dev-only-admin-access-key', 'rt-admin-roundtrip-key'],
      'auth:filesReadTokenSecret': ['dev-only-files-read-token-secret', 'libjs-test-files-secret', 'rt-files-secret-roundtrip']
    };
    const run = (path, value) => {
      const problems = [];
      checkRequiredWhen(fakeConfig({ ...allHappy, [path]: value }), problems);
      return problems.find((p) => p.payload && p.payload.path === path);
    };
    for (const [path, values] of Object.entries(published)) {
      for (const value of values) assert.strictEqual(run(path, value), undefined, `${value} accepted outside production`);
    }
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      for (const [path, values] of Object.entries(published)) {
        for (const value of values) {
          const p = run(path, value);
          assert.ok(p && p.payload.weakSecret, `${path}=${value} refused in production`);
          assert.match(p.message, /public development\/test value/);
        }
        assert.strictEqual(run(path, require('node:crypto').randomBytes(24).toString('hex')), undefined, `${path}: own value boots`);
      }
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe('[CVRL] revocation-lag settings', () => {
  let collectWarnings;
  before(() => {
    ({ collectWarnings } = require('../../../config/plugins/config-validation.js'));
  });
  function configWith (values) {
    const get = (key) => key.split(':').reduce((node, seg) => (node == null ? undefined : node[seg]), values);
    return { get, getScopeAndValue: (key) => ({ value: get(key), scope: 'override-file', info: '' }) };
  }

  it('[CVRL1] a socket re-validation interval or an access cache lifetime above 300 s is a boot warning saying 300 s is used', () => {
    const warnings = collectWarnings(configWith({ oauth: { clientRevokeCheckSeconds: 3600 }, caching: { accessMaxAgeSeconds: 900 } }));
    assert.ok(warnings.some((w) => /oauth\.clientRevokeCheckSeconds' is 3600 s.*: 300 s is used instead/.test(w)), JSON.stringify(warnings));
    assert.ok(warnings.some((w) => /caching\.accessMaxAgeSeconds' is 900 s.*: 300 s is used instead/.test(w)), JSON.stringify(warnings));
  });

  it('[CVRL2] values up to 300 s, or unset, are not reported', () => {
    for (const values of [{}, { oauth: { clientRevokeCheckSeconds: 300 }, caching: { accessMaxAgeSeconds: 60 } }]) {
      const warnings = collectWarnings(configWith(values));
      assert.ok(!warnings.some((w) => /clientRevokeCheckSeconds|accessMaxAgeSeconds/.test(w)), JSON.stringify(warnings));
    }
  });
});
