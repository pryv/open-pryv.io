/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [RTFE] — fileStorage-engine resolution for tests honours the
 * `storages__file__engine` env override.
 *
 * Regression guard: the test helpers force the fileStorage engine into
 * the highest-priority (memory) nconf scope via `config.set()`. If that
 * forced value ignored the env, it would shadow the boiler env source a
 * DynamicInstanceManager-forked child server reads, putting the
 * in-process fixture mall and the server-under-test on different
 * fileStorage engines.
 */

const assert = require('node:assert');
const { resolveTestFileEngine } = require('test-helpers/src/resolveTestFileEngine.ts');

describe('[RTFE] resolveTestFileEngine', () => {
  it('[RTF1] defaults to filesystem when no env override is set', () => {
    assert.strictEqual(resolveTestFileEngine({}), 'filesystem');
  });

  it('[RTF2] honours an explicit storages__file__engine override', () => {
    assert.strictEqual(
      resolveTestFileEngine({ storages__file__engine: 'postgresql' }),
      'postgresql'
    );
  });

  it('[RTF3] an empty override falls back to filesystem', () => {
    assert.strictEqual(
      resolveTestFileEngine({ storages__file__engine: '' }),
      'filesystem'
    );
  });
});
