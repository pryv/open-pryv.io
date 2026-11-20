/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');

const { secureToken, SECURE_TOKEN_PATTERN } = require('storages/interfaces/_shared/secureToken.ts');

/**
 * [SCTK] bearer secrets minted from node:crypto, in the shape clients know.
 */
describe('[SCTK] storages secureToken', () => {
  it('[SCTK1] a letter then 24 letters or digits, all distinct, every symbol drawn', () => {
    const seen = new Set();
    const counts = {};
    for (let i = 0; i < 4000; i++) {
      const t = secureToken();
      assert.match(t, SECURE_TOKEN_PATTERN);
      assert.equal(t.length, 25);
      seen.add(t);
      for (const c of t.slice(1)) counts[c] = (counts[c] ?? 0) + 1;
    }
    assert.equal(seen.size, 4000, 'no repeat');
    // 96000 body symbols over 36: about 2667 each; a modulo bias or a stuck
    // generator would push some far off.
    assert.equal(Object.keys(counts).length, 36);
    for (const [c, n] of Object.entries(counts)) assert.ok(n > 2300 && n < 3050, c + ': ' + n);
  });

  it('[SCTK2] does not use Math.random', () => {
    const original = Math.random;
    Math.random = () => { throw new Error('Math.random called'); };
    try {
      assert.match(secureToken(), SECURE_TOKEN_PATTERN);
    } finally {
      Math.random = original;
    }
  });
});
