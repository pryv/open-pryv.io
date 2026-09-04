/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Recovery codes are stored as digests, not in the clear: a recovery code
 * bypasses the second factor, so it must not be readable from the profile.
 * The codes themselves exist only in the response that shows them once.
 *
 * Codes stored in the clear by an earlier version still verify, so an enrolled
 * user is not locked out by the change.
 */

const assert = require('node:assert/strict');
const { Profile, hashRecoveryCode, isHashedRecoveryCode } = require('../../src/mfa/Profile.ts');

describe('[MRC] MFA recovery codes at rest', function () {
  it('[MRC1] generation stores digests and returns the codes exactly once', function () {
    const profile = new Profile();
    profile.generateRecoveryCodes();

    const shown = profile.getRecoveryCodes();
    assert.strictEqual(shown.length, 10);
    for (const code of shown) assert.match(code, /^[0-9a-f-]{36}$/, 'the user gets a real code');

    assert.ok(profile.recoveryCodes.every(isHashedRecoveryCode), 'everything stored is a digest');
    for (const stored of profile.recoveryCodes) {
      assert.ok(!shown.includes(stored), 'no stored entry is a usable code');
    }
  });

  it('[MRC2] a profile read back from storage cannot hand out any code', function () {
    const source = new Profile();
    source.generateRecoveryCodes();

    // What storage would return: the digests only.
    const reloaded = new Profile({}, source.recoveryCodes);
    assert.deepStrictEqual(reloaded.getRecoveryCodes(), [],
      'a stored profile must never expose codes');
    assert.ok(reloaded.matchesRecoveryCode(source.getRecoveryCodes()[0]),
      'yet it still verifies a genuine code');
  });

  it('[MRC3] verification accepts a genuine code and refuses everything else', function () {
    const profile = new Profile();
    profile.generateRecoveryCodes();
    const codes = profile.getRecoveryCodes();

    for (const code of codes) {
      assert.ok(profile.matchesRecoveryCode(code), 'every issued code works');
    }
    assert.ok(!profile.matchesRecoveryCode('not-a-code'));
    assert.ok(!profile.matchesRecoveryCode(''));
    assert.ok(!profile.matchesRecoveryCode(null));
    assert.ok(!profile.matchesRecoveryCode(undefined));
    // One character off, same length.
    const near = codes[0].slice(0, -1) + (codes[0].endsWith('a') ? 'b' : 'a');
    assert.ok(!profile.matchesRecoveryCode(near));
    // The digest itself is not a usable code.
    assert.ok(!profile.matchesRecoveryCode(profile.recoveryCodes[0]));
  });

  it('[MRC4] codes stored in the clear by an earlier version still verify', function () {
    const legacy = new Profile({}, [
      '11111111-2222-3333-4444-555555555555',
      '66666666-7777-8888-9999-000000000000'
    ]);
    assert.ok(legacy.matchesRecoveryCode('11111111-2222-3333-4444-555555555555'));
    assert.ok(legacy.matchesRecoveryCode('66666666-7777-8888-9999-000000000000'));
    assert.ok(!legacy.matchesRecoveryCode('11111111-2222-3333-4444-555555555556'));
  });

  it('[MRC5] a profile holding both shapes accepts both', function () {
    const mixed = new Profile({}, [hashRecoveryCode('hashed-one'), 'plain-one']);
    assert.ok(mixed.matchesRecoveryCode('hashed-one'));
    assert.ok(mixed.matchesRecoveryCode('plain-one'));
    assert.ok(!mixed.matchesRecoveryCode('neither'));
  });

  it('[MRC6] the digest is stable, prefixed, and not the code', function () {
    const digest = hashRecoveryCode('abc');
    assert.strictEqual(digest, hashRecoveryCode('abc'), 'stable');
    assert.notStrictEqual(digest, hashRecoveryCode('abd'));
    assert.ok(isHashedRecoveryCode(digest));
    assert.ok(!isHashedRecoveryCode('abc'));
    assert.ok(!digest.includes('abc'));
  });
});
