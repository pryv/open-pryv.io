/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('chai').assert;

const generateCode = require('../../../src/mfa/generateCode.ts').default;
const { DEFAULT_CODE_LENGTH } = require('../../../src/mfa/SingleService.ts');

describe('[MFAG] mfa/generateCode', () => {
  it('[MFG1] returns digits only, of the requested length, from 4 to 10', async () => {
    for (const length of [4, 6, 8, 10]) {
      const code = await generateCode(length);
      assert.lengthOf(code, length);
      assert.match(code, /^[0-9]+$/);
    }
  });

  it('[MFG2] refuses a length outside 4 to 10, or not an integer', async () => {
    for (const length of [0, 3, 11, 1000, 6.5, '6', undefined]) {
      try {
        await generateCode(length);
        assert.fail(`length ${length} should be refused`);
      } catch (err) {
        assert.match(err.message, /code length/, String(length));
      }
    }
  });

  it('[MFG3] the SMS single mode generates 6 digits by default', () => {
    assert.strictEqual(DEFAULT_CODE_LENGTH, 6);
  });

  it('[MFG4] 10 000 codes are uniform: every first digit, 0 included, close to a tenth', async () => {
    const N = 10000;
    const firstDigits = new Array(10).fill(0);
    for (let i = 0; i < N; i++) {
      const code = await generateCode(DEFAULT_CODE_LENGTH);
      assert.lengthOf(code, DEFAULT_CODE_LENGTH);
      assert.match(code, /^[0-9]{6}$/);
      firstDigits[Number(code[0])]++;
    }
    assert.ok(firstDigits[0] > 0, 'a code starts with 0 at least once');
    // Expected 1000 each, standard deviation 30: 800..1200 is over 6 sigma.
    for (let d = 0; d < 10; d++) {
      assert.ok(firstDigits[d] > 800 && firstDigits[d] < 1200, `first digit ${d}: ${firstDigits[d]} of ${N} (${JSON.stringify(firstDigits)})`);
    }
  });
});
