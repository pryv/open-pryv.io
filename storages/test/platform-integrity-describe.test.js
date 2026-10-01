/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [PIDS] — the lines the boot log and `bin/integrity-check.js` print for a
 * platform DB integrity report. A failure must name what is wrong and how to
 * repair; a clean report must say whether the engine had a structural check.
 */

const assert = require('node:assert');
const { describePlatformIntegrity } = require('../interfaces/platformStorage/PlatformDB.ts');

describe('[PIDS] describePlatformIntegrity()', () => {
  it('[PIDS01] a clean report with a structural check reads OK', () => {
    const lines = describePlatformIntegrity({ ok: true, structural: ['ok'], duplicateKeys: [] });
    assert.deepStrictEqual(lines, ['OK (structure and keys)']);
  });

  it('[PIDS02] a clean report without a structural check says so', () => {
    const lines = describePlatformIntegrity({ ok: true, structural: null, duplicateKeys: [] });
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /^OK .*no structural check/);
  });

  it('[PIDS03] duplicated keys are listed with their count, plus the repair pointer', () => {
    const lines = describePlatformIntegrity({
      ok: false,
      structural: ['ok'],
      duplicateKeys: [{ key: 'core-info/core-use1', count: 2 }]
    });
    assert.strictEqual(lines[0], 'FAILED');
    assert.ok(!lines.some(l => l.startsWith('structural check')), 'a clean structural result is not reported');
    assert.ok(lines.includes('  core-info/core-use1 (x2)'), lines.join('\n'));
    assert.match(lines[lines.length - 1], /INSTALL\.md/);
  });

  it('[PIDS04] structural messages are reported, and long lists are capped', () => {
    const structural = Array.from({ length: 15 }, (_, i) => `row ${i} missing from index sqlite_autoindex_keyValue_1`);
    const duplicateKeys = Array.from({ length: 12 }, (_, i) => ({ key: `k/${i}`, count: 2 }));
    const lines = describePlatformIntegrity({ ok: false, structural, duplicateKeys });
    assert.ok(lines.includes('structural check: 15 message(s)'));
    assert.ok(lines.includes('12 key(s) stored more than once (corrupted primary-key index):'));
    assert.strictEqual(lines.filter(l => l.startsWith('  row ')).length, 10);
    assert.strictEqual(lines.filter(l => l.startsWith('  k/')).length, 10);
  });
});
