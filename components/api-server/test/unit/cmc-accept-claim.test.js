/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * The claim a single-use link's first accepter takes, on the core's shared
 * key-value store: its own re-delivery passes again, another accepter does not.
 */

/* global assert, cuid */

const { claimSingleUseAccept } = require('../../src/methods/helpers/cmcAcceptClaim.ts');

describe('[CMCAC] single-use accept claim on cluster_kv', function () {
  it('[CMCAC1] the first accepter takes the link and passes again; another accepter is refused', async function () {
    const userId = 'u-' + cuid();
    const cap = 'cap-' + cuid();
    const results = await Promise.all([
      claimSingleUseAccept(userId, cap, 'bob|b.example'),
      claimSingleUseAccept(userId, cap, 'carol|c.example')
    ]);
    assert.deepStrictEqual(results.slice().sort(), [false, true], 'exactly one of two concurrent accepters');
    const holder = results[0] ? 'bob|b.example' : 'carol|c.example';
    const other = results[0] ? 'carol|c.example' : 'bob|b.example';
    assert.strictEqual(await claimSingleUseAccept(userId, cap, holder), true);
    assert.strictEqual(await claimSingleUseAccept(userId, cap, other), false);
  });

  it('[CMCAC2] the claim is per account and capability; an accept naming no accepter matches nobody', async function () {
    const userId = 'u-' + cuid();
    const cap = 'cap-' + cuid();
    assert.strictEqual(await claimSingleUseAccept(userId, cap, ''), true);
    assert.strictEqual(await claimSingleUseAccept(userId, cap, ''), false);
    assert.strictEqual(await claimSingleUseAccept(userId, cap, 'bob|b.example'), false);
    assert.strictEqual(await claimSingleUseAccept(userId, 'cap-' + cuid(), 'bob|b.example'), true);
    assert.strictEqual(await claimSingleUseAccept('u-' + cuid(), cap, 'bob|b.example'), true);
  });
});
