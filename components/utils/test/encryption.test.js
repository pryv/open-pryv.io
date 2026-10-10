/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const encryption = require('../src/encryption.ts');

// `$2b$<cost>$` followed by the 22-character salt.
const SALT_PREFIX_LENGTH = 29;

describe('[ENCR] password hashing', function () {
  this.timeout(10000);

  it('[ENCR1] hashing the same value twice uses a fresh salt each time', async () => {
    const a = await encryption.hash('same-password');
    const b = await encryption.hash('same-password');
    assert.notEqual(a.slice(0, SALT_PREFIX_LENGTH), b.slice(0, SALT_PREFIX_LENGTH));
    assert.notEqual(a, b);
  });

  it('[ENCR2] hashes of different values never share a salt', async () => {
    const a = await encryption.hash('password-one');
    const b = await encryption.hash('password-two');
    assert.notEqual(a.slice(0, SALT_PREFIX_LENGTH), b.slice(0, SALT_PREFIX_LENGTH));
  });

  it('[ENCR3] the synchronous variant also uses a fresh salt each time', () => {
    const a = encryption.hashSync('same-password');
    const b = encryption.hashSync('same-password');
    assert.notEqual(a.slice(0, SALT_PREFIX_LENGTH), b.slice(0, SALT_PREFIX_LENGTH));
  });

  it('[ENCR4] the cost factor is 10', async () => {
    const h = await encryption.hash('some-password');
    assert.equal(bcrypt.getRounds(h), 10);
    assert.equal(bcrypt.getRounds(encryption.hashSync('some-password')), 10);
  });

  it('[ENCR5] compare accepts the right value and refuses a wrong one', async () => {
    const h = await encryption.hash('right-password');
    assert.equal(await encryption.compare('right-password', h), true);
    assert.equal(await encryption.compare('wrong-password', h), false);
    const hs = encryption.hashSync('right-password');
    assert.equal(await encryption.compare('right-password', hs), true);
  });
});
