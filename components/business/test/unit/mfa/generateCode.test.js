/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('chai').assert;

const generateCode = require('../../../src/mfa/generateCode');

describe('[MFAG] mfa/generateCode', () => {
  it('[MFG1] returns a code of the requested length when smaller than the random source', async () => {
    const length = 3;
    const code = await generateCode(length);
    assert.lengthOf(code, length);
    assert.match(code, /^\d+$/);
  });

  it('[MFG2] pads with leading zeroes when the random source is too short', async () => {
    const length = 1000;
    const code = await generateCode(length);
    assert.lengthOf(code, length);
    assert.match(code, /^\d+$/);
  });
});
