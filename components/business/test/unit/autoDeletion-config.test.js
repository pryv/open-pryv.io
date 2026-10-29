/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * account.autoDeletion: defaults, the request-path normalizer (never throws)
 * and the boot-time check (problems refuse the boot, warnings are logged).
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  AUTO_DELETION_DEFAULTS,
  normalizeAutoDeletionConfig,
  describeAutoDeletionConfig
} = require('../../src/autoDeletion/config.ts');

const OK_ENV = { accessTrackingActive: true, mailOk: true, accountAppSet: true };
const paths = (report) => report.problems.map((p) => p.path.join('.'));

describe('[ACCF] account.autoDeletion config', function () {
  it('[ACCF1] the shipped default-config block equals the code defaults', function () {
    const defaults = yaml.load(fs.readFileSync(path.resolve(import.meta.dirname, '../../../../config/default-config.yml'), 'utf8'));
    const block = defaults.account.autoDeletion;
    assert.deepEqual(normalizeAutoDeletionConfig(block), AUTO_DELETION_DEFAULTS);
    assert.deepEqual(block, AUTO_DELETION_DEFAULTS, 'every key present in the YAML, same values');
    assert.deepEqual(describeAutoDeletionConfig(block, OK_ENV), { problems: [], warnings: [] });
  });

  it('[ACCF2] normalize fills defaults and replaces invalid values without throwing', function () {
    assert.deepEqual(normalizeAutoDeletionConfig(undefined), AUTO_DELETION_DEFAULTS);
    assert.deepEqual(normalizeAutoDeletionConfig('junk'), AUTO_DELETION_DEFAULTS);
    const c = normalizeAutoDeletionConfig({
      enabled: 'yes',
      inactivity: { defaultDays: 365, minDays: -1 },
      reminders: { leadDays: [7, 30] },
      sweepIntervalMs: 6,
      maxDeletionsPerPass: 0
    });
    assert.equal(c.enabled, true);
    assert.equal(c.inactivity.defaultDays, 365);
    assert.equal(c.inactivity.minDays, 90);
    assert.deepEqual(c.reminders.leadDays, [60, 30, 7, 1]);
    assert.equal(c.sweepIntervalMs, 21600000);
    assert.equal(c.maxDeletionsPerPass, 0);
  });

  it('[ACCF3] normalize returns copies: changing one never changes the defaults', function () {
    const c = normalizeAutoDeletionConfig({});
    c.reminders.leadDays.push(0);
    c.inactivity.minDays = 1;
    assert.deepEqual(normalizeAutoDeletionConfig({}).reminders.leadDays, [60, 30, 7, 1]);
    assert.equal(AUTO_DELETION_DEFAULTS.inactivity.minDays, 90);
  });

  it('[ACCF4] value shapes are problems', function () {
    const r = describeAutoDeletionConfig({
      enabled: 1,
      inactivity: { defaultDays: 0, maxDays: 'x' },
      date: { minLeadDays: 1.5 },
      reminders: { leadDays: [30, 30], minNoticeDays: 0 },
      sweepIntervalMs: 1000,
      maxDeletionsPerPass: -1,
      transfer: { claimWindowDays: 0, identitySecretsKey: 'not-a-key' }
    }, OK_ENV);
    assert.deepEqual(paths(r).sort(), [
      'account.autoDeletion.date.minLeadDays',
      'account.autoDeletion.enabled',
      'account.autoDeletion.inactivity.defaultDays',
      'account.autoDeletion.inactivity.maxDays',
      'account.autoDeletion.maxDeletionsPerPass',
      'account.autoDeletion.reminders.leadDays',
      'account.autoDeletion.reminders.minNoticeDays',
      'account.autoDeletion.sweepIntervalMs',
      'account.autoDeletion.transfer.claimWindowDays',
      'account.autoDeletion.transfer.identitySecretsKey'
    ]);
    assert.equal(paths(describeAutoDeletionConfig([1], OK_ENV))[0], 'account.autoDeletion');
  });

  it('[ACCF5] a 32-byte base64 identity key is accepted, another length refused', function () {
    const key = crypto.randomBytes(32).toString('base64');
    assert.deepEqual(describeAutoDeletionConfig({ transfer: { identitySecretsKey: key } }, OK_ENV).problems, []);
    assert.equal(normalizeAutoDeletionConfig({ transfer: { identitySecretsKey: key } }).transfer.identitySecretsKey, key);
    const short = crypto.randomBytes(16).toString('base64');
    assert.deepEqual(paths(describeAutoDeletionConfig({ transfer: { identitySecretsKey: short } }, OK_ENV)), ['account.autoDeletion.transfer.identitySecretsKey']);
  });

  it('[ACCF6] relations between values are problems', function () {
    assert.deepEqual(paths(describeAutoDeletionConfig({ inactivity: { minDays: 400, maxDays: 300 } }, OK_ENV)), ['account.autoDeletion.inactivity.minDays']);
    assert.deepEqual(paths(describeAutoDeletionConfig({ inactivity: { defaultDays: 30 } }, OK_ENV)), ['account.autoDeletion.inactivity.defaultDays']);
    assert.deepEqual(paths(describeAutoDeletionConfig({ date: { minLeadDays: 3 } }, OK_ENV)), ['account.autoDeletion.date.minLeadDays']);
  });

  it('[ACCF7] a preset with access tracking off refuses the boot', function () {
    const r = describeAutoDeletionConfig({ inactivity: { defaultDays: 365 } }, { ...OK_ENV, accessTrackingActive: false });
    assert.deepEqual(paths(r), ['account.autoDeletion.inactivity.defaultDays']);
    assert.match(r.problems[0].message, /accessTracking\.isActive/);
    // no preset: the date trigger alone does not need tracking
    assert.deepEqual(describeAutoDeletionConfig({}, { ...OK_ENV, accessTrackingActive: false }).problems, []);
    // feature off: nothing to measure
    assert.deepEqual(describeAutoDeletionConfig({ enabled: false, inactivity: { defaultDays: 365 } }, { ...OK_ENV, accessTrackingActive: false }).problems, []);
  });

  it('[ACCF8] a preset without mail or without the account app URL is a warning', function () {
    const block = { inactivity: { defaultDays: 365 } };
    assert.deepEqual(describeAutoDeletionConfig(block, OK_ENV), { problems: [], warnings: [] });
    const noMail = describeAutoDeletionConfig(block, { ...OK_ENV, mailOk: false });
    assert.equal(noMail.problems.length, 0);
    assert.equal(noMail.warnings.length, 1);
    assert.match(noMail.warnings[0], /mail is not configured/);
    const noApp = describeAutoDeletionConfig(block, { ...OK_ENV, accountAppSet: false });
    assert.equal(noApp.warnings.length, 1);
    assert.match(noApp.warnings[0], /service\.account/);
    // without a preset, neither is worth a boot warning
    assert.deepEqual(describeAutoDeletionConfig({}, { accessTrackingActive: true, mailOk: false, accountAppSet: false }).warnings, []);
  });
});
