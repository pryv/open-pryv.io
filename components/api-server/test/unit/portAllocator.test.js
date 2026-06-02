/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./test-helper');
const assert = require('node:assert');
const portAllocator = require('test-helpers/src/portAllocator.ts');

describe('[PALC] portAllocator', () => {
  beforeEach(() => {
    portAllocator.reset();
  });

  it('[PALC01] allocates monotonically increasing ports', async () => {
    const p1 = await portAllocator.allocatePort();
    const p2 = await portAllocator.allocatePort();
    assert.ok(p2 > p1, `expected p2 (${p2}) > p1 (${p1})`);
  });

  it('[PALC02] releasePort returns the port to the freed pool for reuse', async () => {
    const p1 = await portAllocator.allocatePort();
    portAllocator.releasePort(p1);
    const p2 = await portAllocator.allocatePort();
    assert.strictEqual(p2, p1, 'freed port should be re-issued first');
  });

  it('[PALC03] releasePort is a no-op for an unallocated port', () => {
    portAllocator.releasePort(54321);
    portAllocator.releasePort(54321);
    // Should not throw, no observable side-effect.
    assert.ok(true);
  });

  it('[PALC04] releasePort is idempotent on repeat releases of the same port', async () => {
    const p1 = await portAllocator.allocatePort();
    portAllocator.releasePort(p1);
    portAllocator.releasePort(p1);
    // Allocating again should give back p1 once, then a fresh one.
    const a = await portAllocator.allocatePort();
    const b = await portAllocator.allocatePort();
    assert.strictEqual(a, p1, 'first re-allocate returns the freed port');
    assert.notStrictEqual(b, p1, 'second re-allocate returns a fresh port');
  });
});
