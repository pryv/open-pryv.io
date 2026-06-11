/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

require('test-helpers/src/api-server-tests-config.ts');
const assert = require('node:assert');
const { sanitizeRequestFiles } = require('../../src/methods/events.ts');

describe('[SRF1] sanitizeRequestFiles', function () {
  it('[SRF2] unwraps the nested { file: [...] } shape into a real array', function () {
    const a = { name: 'a.txt', mimetype: 'text/plain', size: 1 };
    const b = { filename: 'b.png', mimetype: 'image/png', size: 2 };
    const result = sanitizeRequestFiles({ file: [a, b] });
    assert.ok(Array.isArray(result), 'must be a real array (consumers gate on .length)');
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].filename, 'a.txt', 'filename backfilled from name');
    assert.strictEqual(result[1].filename, 'b.png');
  });

  it('[SRF3] passes plain arrays and empty values through unchanged', function () {
    const arr = [{ filename: 'c.txt' }];
    assert.strictEqual(sanitizeRequestFiles(arr), arr);
    assert.strictEqual(sanitizeRequestFiles(null), null);
    assert.strictEqual(sanitizeRequestFiles(undefined), undefined);
  });
});
