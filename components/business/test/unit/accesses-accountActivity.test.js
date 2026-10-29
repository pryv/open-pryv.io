/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const { lastActivityOf, getLastActivity } = require('../../src/accesses/accountActivity.ts');

describe('[ACAC] account activity', function () {
  it('[ACAC1] is the latest lastUsed among personal and app accesses', function () {
    assert.equal(lastActivityOf([
      { type: 'personal', lastUsed: 100 },
      { type: 'app', lastUsed: 300 },
      { type: 'personal', lastUsed: 200 }
    ]), 300);
  });

  it('[ACAC2] ignores shared accesses, however recent', function () {
    assert.equal(lastActivityOf([
      { type: 'personal', lastUsed: 100 },
      { type: 'shared', lastUsed: 900 }
    ]), 100);
  });

  it('[ACAC3] is null when no qualifying access was ever used', function () {
    assert.equal(lastActivityOf([]), null);
    assert.equal(lastActivityOf([{ type: 'shared', lastUsed: 900 }]), null);
    assert.equal(lastActivityOf([{ type: 'app' }, { type: 'personal', lastUsed: null }]), null);
  });

  it('[ACAC4] skips malformed values and rows', function () {
    assert.equal(lastActivityOf([null, { type: 'app', lastUsed: NaN }, { type: 'app', lastUsed: '500' }, { type: 'app', lastUsed: 50 }]), 50);
  });

  it('[ACAC5] reads the user\'s accesses through the repository', async function () {
    const seen = [];
    const repo = {
      find (user, query, options, cb) {
        seen.push(user.id);
        cb(null, [{ type: 'app', lastUsed: 42 }, { type: 'shared', lastUsed: 99 }]);
      }
    };
    assert.equal(await getLastActivity(repo, { id: 'u1' }), 42);
    assert.deepEqual(seen, ['u1']);
  });

  it('[ACAC6] rejects with the repository error', async function () {
    const repo = { find (user, query, options, cb) { cb(new Error('boom')); } };
    await assert.rejects(getLastActivity(repo, { id: 'u1' }), /boom/);
  });
});
