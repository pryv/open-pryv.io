/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');

const { Platform } = require('../../src/Platform.ts');

/**
 * Two levels of reserved usernames: the names the platform routes itself
 * (a host it answers, a path it serves) and the larger word list kept out
 * of new registrations. A restore refuses only the first kind.
 */
describe('[PLRR] reserved usernames: routing names vs the word list', () => {
  it('[PLRR1] the names the platform routes are routing-reserved, whatever their length or case', () => {
    const platform = new Platform();
    for (const name of ['reg', 'access', 'mfa', 'lsc', 'LSC', 'users', 'oauth2', 'system', 'pryv', 'pryvsupport', 'PryvSupport']) {
      assert.equal(platform.isUsernameRoutingReserved(name), true, name);
      assert.equal(platform.isUsernameInReservedList(name), true, name);
    }
  });

  it('[PLRR2] a word of the list that the platform does not route is listed but not routing-reserved', () => {
    const platform = new Platform();
    for (const name of ['summer', 'john', 'health']) {
      assert.equal(platform.isUsernameInReservedList(name), true, name);
      assert.equal(platform.isUsernameRoutingReserved(name), false, name);
    }
    assert.equal(platform.isUsernameRoutingReserved('firstuser'), false);
  });
});
