/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { Platform } = require('../../src/Platform.ts');

function platformWithAdminKey (adminKey, filesReadTokenSecret = 'a-files-read-token-secret-0123456789') {
  const values = { 'core:id': 'core-a', 'auth:adminAccessKey': adminKey, 'auth:filesReadTokenSecret': filesReadTokenSecret, 'integrity:algorithm': 'sha256' };
  const platform = new Platform();
  platform._setDependenciesForTests({}, null, { get: (key) => values[key] });
  return platform;
}

/**
 * The boot log and `bin/observability.js show` print a fingerprint of the
 * admin key so operators can compare it across cores. A plain SHA-256 prefix
 * let anyone holding a log line test candidate keys against it directly.
 */
describe('[PLFP] admin key fingerprint in the config snapshot', () => {
  it('[PLFP1] is keyed: not the SHA-256 of the key, the same for the same key, different for another', () => {
    const key = 'an-admin-key-for-plfp1-0123456789';
    const { snapshot } = platformWithAdminKey(key).getPlatformConfigSnapshot();
    const fingerprint = snapshot['auth.adminAccessKey.fingerprint'];
    assert.match(fingerprint, /^[0-9a-f]{16}$/);
    const plain = crypto.createHash('sha256').update(key).digest('hex');
    assert.ok(!plain.startsWith(fingerprint), 'not a SHA-256 prefix of the key');
    assert.ok(!JSON.stringify(snapshot).includes(plain.slice(0, 16)), 'no SHA-256 prefix anywhere in the snapshot');
    assert.equal(platformWithAdminKey(key).getPlatformConfigSnapshot().snapshot['auth.adminAccessKey.fingerprint'], fingerprint);
    assert.notEqual(platformWithAdminKey(key + 'x').getPlatformConfigSnapshot().snapshot['auth.adminAccessKey.fingerprint'], fingerprint);
  });

  it('[PLFP2] needs a second platform secret: the admin key alone does not give the fingerprint', () => {
    const key = 'an-admin-key-for-plfp2-0123456789';
    const fingerprint = platformWithAdminKey(key, 'secret-one-0123456789-abcdefghij').getPlatformConfigSnapshot().snapshot['auth.adminAccessKey.fingerprint'];
    assert.match(fingerprint, /^[0-9a-f]{16}$/);
    assert.notEqual(platformWithAdminKey(key, 'secret-two-0123456789-abcdefghij').getPlatformConfigSnapshot().snapshot['auth.adminAccessKey.fingerprint'], fingerprint);
    // Computable from the admin key alone (an HMAC keyed by it over any fixed label): not the logged value.
    const keyOnly = crypto.createHmac('sha256', key).update('pryv.io admin access key fingerprint v1').digest('hex').slice(0, 16);
    assert.notEqual(fingerprint, keyOnly);
  });
});
