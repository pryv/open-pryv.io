/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [EMFL] the mail switches: `services.email.enabled` (whole feature) and one
 * flat `services.email.send<Kind>` per mail class, read by one helper.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  MAIL_KINDS, mailSwitchKey, isMailKindSwitchedOn, isMailKindSwitchedOnInConfig, enabledMailKinds
} from '../../src/emails/mailCapability.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(here, '../../../../config/default-config.yml');
const KINDS = Object.keys(MAIL_KINDS);

/** A config reader over a nested object, as boiler resolves it. */
function configOf (values) {
  return { get: (key) => key.split(':').reduce((node, seg) => (node == null ? undefined : node[seg]), values) };
}

describe('[EMFL] mail switches', function () {
  it('[EMFL1] the shipped defaults set every mail class on, with enabled true and no other send key', function () {
    const email = yaml.load(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8')).services.email;
    assert.equal(email.enabled, true);
    for (const kind of KINDS) {
      assert.equal(email[mailSwitchKey(kind)], true, mailSwitchKey(kind));
    }
    const sendKeys = Object.keys(email).filter((k) => /^send[A-Z]/.test(k)).sort();
    assert.deepEqual(sendKeys, KINDS.map(mailSwitchKey).sort());
    assert.equal(mailSwitchKey('resetPassword'), 'sendResetPassword');
    assert.equal(mailSwitchKey('accountDeletionReminder'), 'sendAccountDeletionReminder');
  });

  it('[EMFL2] on by default; send<Kind>: false turns that class off only; enabled: false turns every class off', function () {
    for (const kind of KINDS) {
      assert.equal(isMailKindSwitchedOn({}, kind), true, kind);
      assert.equal(isMailKindSwitchedOn({ enabled: true }, kind), true, kind);
      const oneOff = { enabled: true, [mailSwitchKey(kind)]: false };
      for (const other of KINDS) {
        assert.equal(isMailKindSwitchedOn(oneOff, other), other !== kind, `${kind} off, ${other}`);
        assert.equal(isMailKindSwitchedOnInConfig(configOf({ services: { email: oneOff } }), other), other !== kind, `${kind} off, ${other} (config)`);
      }
      const allOff = { enabled: false, [mailSwitchKey(kind)]: true };
      assert.equal(isMailKindSwitchedOn(allOff, kind), false, kind);
      assert.equal(isMailKindSwitchedOnInConfig(configOf({ services: { email: allOff } }), kind), false, kind);
    }
    assert.deepEqual(enabledMailKinds(configOf({ services: { email: { enabled: false } } })), []);
    assert.deepEqual(enabledMailKinds(configOf({ services: { email: { sendWelcome: false } } })), KINDS.filter((k) => k !== 'welcome'));
    assert.equal(isMailKindSwitchedOn(null, 'welcome'), false, 'no services.email: nothing to send with');
  });

  it('[EMFL3] the former object form and non-boolean values read as off (fail-closed)', function () {
    for (const kind of KINDS) {
      assert.equal(isMailKindSwitchedOn({ enabled: { [kind]: true } }, kind), false, kind);
      assert.equal(isMailKindSwitchedOn({ enabled: {} }, kind), false, kind);
      assert.equal(isMailKindSwitchedOn({ enabled: null }, kind), false, kind);
      assert.equal(isMailKindSwitchedOn({ enabled: 'true' }, kind), false, kind);
      assert.equal(isMailKindSwitchedOn({ [mailSwitchKey(kind)]: 'false' }, kind), false, kind);
      assert.equal(isMailKindSwitchedOn({ [mailSwitchKey(kind)]: null }, kind), false, kind);
      assert.equal(isMailKindSwitchedOnInConfig(configOf({ services: { email: { enabled: { [kind]: true } } } }), kind), false, kind);
      // An empty `email:` (YAML null): both helpers say off.
      assert.equal(isMailKindSwitchedOnInConfig(configOf({ services: { email: null } }), kind), false, kind);
      assert.equal(isMailKindSwitchedOn(null, kind), false, kind);
    }
  });
});
