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
 * [MLCP] / [VMPL] / [EMCG] — the mail-capability predicate and the boot rule
 * that guards the registration email gate.
 *
 * The gate mails a one-time code on every sign-up, so an incomplete mail
 * configuration would block every registration on the platform. The boot must
 * refuse that combination rather than let an operator discover it from the
 * first failed sign-up. Pure unit tests over the predicate and the check
 * function; `-seq` only because the api-server hooks run a Platform integrity
 * check (these tests touch no storage).
 */

describe('[MLCP] mail capability predicate', () => {
  let describeMailCapability;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ describeMailCapability } = require('business/src/emails/mailCapability.ts'));
  });

  function fakeConfig (map) {
    return { get: (key) => map[key] };
  }

  const inProcessOk = {
    'services:email:method': 'in-process',
    'services:email:smtp:host': 'smtp.example.com',
    'services:email:from:address': 'no-reply@example.com'
  };

  it('[MLCP1] in-process with smtp host and from address is capable', () => {
    assert.deepStrictEqual(describeMailCapability(fakeConfig(inProcessOk)), {
      ok: true,
      method: 'in-process',
      problems: []
    });
  });

  it('[MLCP7] in-process without a from address is still capable', () => {
    // The sender is optional at the transport. This predicate decides whether
    // verification mail runs at all, so requiring a key the runtime does not
    // require would silently stop a deployment that was sending mail.
    const map = Object.assign({}, inProcessOk);
    delete map['services:email:from:address'];
    assert.deepStrictEqual(describeMailCapability(fakeConfig(map)), {
      ok: true,
      method: 'in-process',
      problems: []
    });
  });

  it('[MLCP2] in-process without smtp.host is not capable and says which key', () => {
    const map = Object.assign({}, inProcessOk);
    delete map['services:email:smtp:host'];
    const res = describeMailCapability(fakeConfig(map));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.problems.length, 1);
    assert.match(res.problems[0], /services\.email\.smtp\.host/);
  });

  it('[MLCP3] a REPLACE sentinel counts as unset, not as a value', () => {
    const map = Object.assign({}, inProcessOk, { 'services:email:smtp:host': 'REPLACE ME' });
    const res = describeMailCapability(fakeConfig(map));
    assert.strictEqual(res.ok, false);
    assert.match(res.problems[0], /services\.email\.smtp\.host/);
  });

  it('[MLCP4] mandrill needs url and key', () => {
    const ok = {
      'services:email:method': 'mandrill',
      'services:email:url': 'https://mandrill.example.com/send',
      'services:email:key': 'k'
    };
    assert.strictEqual(describeMailCapability(fakeConfig(ok)).ok, true);
    const map = Object.assign({}, ok);
    delete map['services:email:key'];
    const res = describeMailCapability(fakeConfig(map));
    assert.strictEqual(res.ok, false);
    assert.match(res.problems[0], /services\.email\.key/);
  });

  it('[MLCP5] enabled:false is not capable whatever the method says', () => {
    const map = Object.assign({}, inProcessOk, { 'services:email:enabled': false });
    const res = describeMailCapability(fakeConfig(map));
    assert.strictEqual(res.ok, false);
    assert.ok(res.problems.some((p) => /services\.email\.enabled is false/.test(p)));
  });

  it('[MLCP6] an unknown method yields method null and a problem', () => {
    const res = describeMailCapability(fakeConfig({ 'services:email:method': 'smtp' }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.method, null);
    assert.match(res.problems[0], /in-process, microservice, mandrill/);
  });
});

describe('[VMPL] verification-mail status', () => {
  let describeVerificationMail;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ describeVerificationMail } = require('business/src/emails/mailCapability.ts'));
  });

  const live = {
    'services:email:method': 'in-process',
    'services:email:smtp:host': 'smtp.example.com',
    'services:email:from:address': 'no-reply@example.com',
    'auth:emailVerificationPageURL': 'https://app.example.com/verify-email'
  };

  function fakeConfig (map) {
    return { get: (key) => map[key] };
  }

  it('[VMPL1] a complete configuration is enabled', () => {
    const res = describeVerificationMail(fakeConfig(live));
    assert.strictEqual(res.enabled, true);
    assert.strictEqual(res.reason, null);
  });

  it('[VMPL2] verifyEmail:false reports disabled, ahead of any other gap', () => {
    const map = Object.assign({}, live, { 'services:email:enabled': { verifyEmail: false } });
    delete map['auth:emailVerificationPageURL'];
    const res = describeVerificationMail(fakeConfig(map));
    assert.strictEqual(res.enabled, false);
    assert.strictEqual(res.reason, 'disabled');
  });

  it('[VMPL3] a missing page URL reports missing-page-url', () => {
    const map = Object.assign({}, live);
    delete map['auth:emailVerificationPageURL'];
    const res = describeVerificationMail(fakeConfig(map));
    assert.strictEqual(res.enabled, false);
    assert.strictEqual(res.reason, 'missing-page-url');
  });

  it('[VMPL4] an incomplete mail config reports mail-not-configured, and scope decides `explicit`', () => {
    const map = Object.assign({}, live);
    delete map['services:email:smtp:host'];
    const res = describeVerificationMail(fakeConfig(map));
    assert.strictEqual(res.enabled, false);
    assert.strictEqual(res.reason, 'mail-not-configured');
    // A plain object cannot prove where the value came from, so it counts as
    // operator-set: the conservative direction.
    assert.strictEqual(res.explicit, true);
    // With scope information, the shipped default file is NOT explicit.
    const scoped = {
      get: (key) => live[key],
      getScopeAndValue: () => ({ value: true, scope: 'default-file', info: '' })
    };
    assert.strictEqual(describeVerificationMail(scoped).explicit, false);
    const overridden = {
      get: (key) => live[key],
      getScopeAndValue: () => ({ value: true, scope: 'override-file', info: '' })
    };
    assert.strictEqual(describeVerificationMail(overridden).explicit, true);
  });
});

describe('[EMCG] registration-gate boot rule', () => {
  let checkEmailVerificationGate;

  before(async function () {
    this.timeout(30000);
    await initTests();
    await initCore();
    ({ checkEmailVerificationGate } = require('../../../config/plugins/config-validation.js'));
  });

  function run (map) {
    const problems = [];
    checkEmailVerificationGate({ get: (key) => map[key] }, problems);
    return problems;
  }

  it('[EMCG1] the gate off is never checked, however broken the mail config is', () => {
    assert.deepStrictEqual(run({}), []);
    assert.deepStrictEqual(run({ 'account:emailVerification:requireAtRegistration': false }), []);
  });

  it('[EMCG2] the gate on with an incomplete mail config is a boot problem', () => {
    const problems = run({
      'account:emailVerification:requireAtRegistration': true,
      'services:email:method': 'in-process',
      'services:email:from:address': 'no-reply@example.com'
    });
    assert.strictEqual(problems.length, 1);
    assert.deepStrictEqual(problems[0].path, ['account', 'emailVerification', 'requireAtRegistration']);
    assert.ok(problems[0].payload.problems.some((p) => /services\.email\.smtp\.host/.test(p)));
    assert.match(problems[0].message, /requires a complete mail configuration/);
  });

  it('[EMCG3] the gate on with a complete mandrill config boots', () => {
    assert.deepStrictEqual(run({
      'account:emailVerification:requireAtRegistration': true,
      'services:email:method': 'mandrill',
      'services:email:url': 'https://mandrill.example.com/send',
      'services:email:key': 'k'
    }), []);
  });

  it('[EMCG4] bin/check-config.js mirrors the rule on a standalone override', async () => {
    const { spawnSync } = require('node:child_process');
    const fs = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');

    const script = path.resolve(import.meta.dirname, '../../../bin/check-config.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'check-config-gate-'));
    const write = async (name, body) => {
      const p = path.join(dir, name);
      await fs.writeFile(p, body, 'utf8');
      return p;
    };
    const runCheck = (file) => spawnSync(process.execPath, [script, file], { encoding: 'utf8' });

    // The override carries other gaps (it is deliberately minimal), so we assert
    // on the PRESENCE of the gate's own problem rather than the exit code alone.
    const gateOn = await write('gate-on.yml', [
      'account:',
      '  emailVerification:',
      '    requireAtRegistration: true',
      'services:',
      '  email:',
      '    method: in-process',
      "    from: { address: 'no-reply@example.com' }",
      ''
    ].join('\n'));
    const onRes = runCheck(gateOn);
    assert.strictEqual(onRes.status, 1);
    assert.match(onRes.stderr, /services\.email\.smtp\.host missing or unset \(required by the registration email gate/);

    // Same file with the gate off: that specific problem must be gone.
    const gateOff = await write('gate-off.yml', [
      'account:',
      '  emailVerification:',
      '    requireAtRegistration: false',
      'services:',
      '  email:',
      '    method: in-process',
      "    from: { address: 'no-reply@example.com' }",
      ''
    ].join('\n'));
    const offRes = runCheck(gateOff);
    assert.doesNotMatch(
      (offRes.stderr || '') + (offRes.stdout || ''),
      /required by the registration email gate/
    );

    await fs.rm(dir, { recursive: true, force: true });
  });
});
