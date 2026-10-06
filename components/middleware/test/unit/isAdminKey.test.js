/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const isAdminKey = require('../../src/isAdminKey.ts').default;
const assert = require('node:assert');

describe('[IAK] isAdminKey', function () {
  it('[IAK1] accepts exactly the configured key', function () {
    assert.strictEqual(isAdminKey('secret-key', 'secret-key'), true);
  });

  it('[IAK2] refuses another key, of the same length or not, and other forms', function () {
    for (const sent of ['secret-kez', 'secret-key2', 'secret', 'Bearer secret-key', ' secret-key', '', undefined, null, ['secret-key']]) {
      assert.strictEqual(isAdminKey(sent, 'secret-key'), false, String(sent));
    }
  });

  it('[IAK3] refuses everything when no key is configured', function () {
    for (const configured of ['', undefined, null]) {
      assert.strictEqual(isAdminKey('', configured), false);
      assert.strictEqual(isAdminKey('anything', configured), false);
    }
  });
});
