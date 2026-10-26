/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { factory, ErrorIds } = require('../../src/index.ts');

describe('[UNKR] unknown resource errors', function () {
  it('[UNKR1] without an id the message has no trailing space', function () {
    const err = factory.unknownResource('external id');
    assert.strictEqual(err.id, ErrorIds.UnknownResource);
    assert.strictEqual(err.httpStatus, 404);
    assert.strictEqual(err.message, 'Unknown external id');
    assert.strictEqual(factory.unknownResource().message, 'Unknown resource');
  });

  it('[UNKR2] with an id the id is quoted after one space', function () {
    assert.strictEqual(factory.unknownResource('stream', 'diary').message, 'Unknown stream "diary"');
  });
});
