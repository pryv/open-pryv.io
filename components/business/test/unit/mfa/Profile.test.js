/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('chai').assert;

const Profile = require('../../../src/mfa/Profile');

describe('[MFAP] mfa/Profile', () => {
  it('[MP1A] is inactive when content is empty', () => {
    assert.isFalse(new Profile().isActive());
    assert.isFalse(new Profile({}).isActive());
  });

  it('[MP1B] is active when content has any key', () => {
    assert.isTrue(new Profile({ phone: '+41...' }).isActive());
  });

  it('[MP2A] generateRecoveryCodes() produces 10 unique UUID strings', () => {
    const p = new Profile({ phone: '+41...' });
    p.generateRecoveryCodes();
    const codes = p.getRecoveryCodes();
    assert.lengthOf(codes, 10);
    const set = new Set(codes);
    assert.equal(set.size, 10);
    for (const c of codes) {
      assert.match(c, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
